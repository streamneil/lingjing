// 灵镜 数据库层 — SQLite(better-sqlite3,同步 API,Slice1 单机够用)。
//
// Slice 1 只建命脉闭环需要的表:job(同时是队列)。
// Slice 2/3 再加 tenant / user / avatar / voice / credit_ledger / audit_log / authorization。
// 设计文档 Data Model 是完整骨架;这里只落 Slice 1 子集,避免过度建设。

import Database from 'better-sqlite3';
import { config } from '../config.js';

export const db = new Database(config.db.file);
db.pragma('journal_mode = WAL'); // 并发读 + 单写,适合 worker 轮询拉任务
db.pragma('foreign_keys = ON');

// ┌──────────────────────────────────────────────────────────────┐
// │ job 状态机(也是队列状态):                                    │
// │                                                                │
// │   queued ──worker领取──> running ──百炼SUCCEEDED──> done       │
// │     │                       │                                  │
// │     │                       ├──百炼FAILED/异常───> failed       │
// │     │                       └──超过 jobTimeoutMs─> failed(超时) │
// │     │                                                          │
// │   failed ──用户点重试──> queued(重新入队)                      │
// │                                                                │
// │ DB 为唯一真相;前端轮询 GET /jobs/:id 读快照(无 SSE)。        │
// │ worker 用事务 + status 条件更新做"领取",实现失败隔离:          │
// │ 单个 job 异常只把自己标 failed,不影响其它 queued/running。     │
// └──────────────────────────────────────────────────────────────┘

// ── Slice 2:多租户 + 认证 ──
// tenant(机构)→ user(成员,三角色)→ session(server 端会话)。
// 行级隔离:所有业务表带 tenant_id,查询经 tenant-scoped 封装强制带 WHERE。
db.exec(`
  CREATE TABLE IF NOT EXISTS tenant (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    delivery    TEXT NOT NULL DEFAULT 'hosted',  -- hosted | private
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    username      TEXT NOT NULL,                  -- 登录名(全局唯一)
    display_name  TEXT,                            -- 昵称(展示名,可改;空则用 username)
    password_hash TEXT NOT NULL,                  -- bcrypt
    role          TEXT NOT NULL DEFAULT 'creator', -- admin | creator | viewer
    status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled
    created_at    INTEGER NOT NULL,
    UNIQUE (tenant_id, username),
    FOREIGN KEY (tenant_id) REFERENCES tenant(id)
  );

  CREATE TABLE IF NOT EXISTS session (
    token       TEXT PRIMARY KEY,                 -- 随机不可猜
    user_id     TEXT NOT NULL,
    tenant_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user(id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
`);

// ── Slice 3:积分 + 审计 ──
// credit_ledger 记每一笔积分变动(append-only,不改历史):
//   grant(+发放) reserve(-预扣) settle(预扣转实扣,差额释放) release(+全额释放)
// 余额 = SUM(所有已生效变动)。提交时 reserve、成功时 settle、失败时 release。
//
// ┌─ 积分流转(单次生成)─────────────────────────────┐
// │ 提交:reserve(-预估)   余额立即减少,防并发超支     │
// │   成功:settle 差额=实扣-预扣(本期 实扣=预扣 → 差额0) │
// │   失败:release(+预估)  把预扣的还回去,失败不扣      │
// └────────────────────────────────────────────────────┘
db.exec(`
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    kind        TEXT NOT NULL,            -- grant | reserve | settle | release
    amount      INTEGER NOT NULL,         -- 正=入账/释放,负=预扣/实扣
    job_id      TEXT,                     -- 关联生成任务(grant 时为空)
    note        TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON credit_ledger(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_ledger_job ON credit_ledger(job_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    user_id     TEXT,
    action      TEXT NOT NULL,            -- login | create_job | grant_credit | member_add ...
    target      TEXT,                     -- 关联对象 id / 描述
    ip          TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at);

  CREATE TABLE IF NOT EXISTS tenant_setting (
    tenant_id   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    PRIMARY KEY (tenant_id, key)
  );
`);

// ── 平台超管(跨租户高权限,与租户 user/session 物理隔离)──
// 决策来源:/plan-ceo-review D1 + /plan-eng-review。
// platform_admin 独立表:admin 不占租户 user 表 → 租户永远用不了 admin。
// platform_session 独立会话:cookie lj_padmin / Path=/admin,与租户 lj_session 不串位。
// 一个租户侧越权 bug 提不了平台权(独立表 + 独立 cookie + 独立路由三重隔离)。
//
// 防暴破(/plan-ceo-review D8/D9):仅滑块行为验证,无 IP 锁定。
//   captcha_challenge:后端出题(目标 x 存服务端,前端拿不到答案)。
//   captcha_token:滑块过后发的一次性凭证,登录必携,消费即 DELETE。
db.exec(`
  CREATE TABLE IF NOT EXISTS platform_admin (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_session (
    token       TEXT PRIMARY KEY,
    padmin_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    FOREIGN KEY (padmin_id) REFERENCES platform_admin(id)
  );
  CREATE INDEX IF NOT EXISTS idx_psession_padmin ON platform_session(padmin_id);

  CREATE TABLE IF NOT EXISTS captcha_challenge (
    id          TEXT PRIMARY KEY,
    target_x    INTEGER NOT NULL,         -- 缺口目标 x(校验时比对前端提交的 x,容差内即过)
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captcha_token (
    token       TEXT PRIMARY KEY,         -- 滑块过后发的一次性登录凭证
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
`);

// audit_log 加 actor_type 列(/plan-ceo-review D11):区分操作者是租户 user 还是平台超管。
//   user_id 语义 = actor_id;actor_type=platform_admin 时 user_id 指向 platform_admin.id。
//   跨租户充值记目标租户 tenant_id,租户 admin 能在自己审计看到"平台充值 N"。
//   DEFAULT 'user':历史行回填 user,前端 else 分支兼容。

// ── Slice 3:形象库 + 授权存证 ──
// avatar:预置(preset)/ 自定义照片(photo)/ 自定义视频(video)。
//   自定义形象状态机:processing(处理中)→ ready(可用) / failed。
// authorization:每个自定义形象/克隆音色的"本人授权"凭证(政企法律门票 + 百炼可能硬性要求)。
//   决策来源:/plan-eng-review D10 + 外部声音#6。
db.exec(`
  CREATE TABLE IF NOT EXISTS avatar (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'preset',   -- preset | photo | video
    status        TEXT NOT NULL DEFAULT 'ready',    -- processing | ready | failed
    source_key    TEXT,                             -- 源素材在 MinIO 的 key(自定义)
    thumb_url     TEXT,                             -- 缩略图(预置用外链,自定义用源图)
    authorization_id TEXT,                          -- 关联授权凭证(自定义必填)
    orientation   TEXT DEFAULT 'portrait',          -- portrait(竖) | landscape(横) | square
    is_default    INTEGER NOT NULL DEFAULT 0,       -- 是否设为该租户默认形象(C6)
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_avatar_tenant ON avatar(tenant_id);

  CREATE TABLE IF NOT EXISTS voice (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'preset',   -- preset | clone
    status        TEXT NOT NULL DEFAULT 'ready',    -- processing | ready | failed
    source_key    TEXT,                             -- 样本音频在 MinIO 的 key
    provider_voice_id TEXT,                          -- 百炼声音复刻返回的 voice_id(克隆音色合成时用)
    authorization_id TEXT,                          -- 关联授权(克隆必填)
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voice_tenant ON voice(tenant_id);

  -- 已弃用:素材库模块(零消费方死端口)已删除,见 ~/.claude/plans/remove-asset-library.md。
  -- 建表语句保留不 DROP:CREATE TABLE 幂等无害,现有库若有素材数据不被毁(数据安全)。
  -- 将来若重建素材库(且接真消费方),复用此表;否则确认无数据后可单独清表。
  CREATE TABLE IF NOT EXISTS asset (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    type          TEXT NOT NULL,                    -- image | video | audio
    source_key    TEXT NOT NULL,                    -- MinIO key
    size          INTEGER,
    created_by    TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_asset_tenant ON asset(tenant_id);

  CREATE TABLE IF NOT EXISTS authorization (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    subject_type  TEXT NOT NULL,                    -- avatar | voice(肖像 / 声音)
    consent       INTEGER NOT NULL DEFAULT 0,       -- 是否勾选"已获本人授权"(1=是)
    proof_key     TEXT,                             -- 授权凭证文件在 MinIO 的 key
    terms_version TEXT,                             -- 同意时的条款版本(可举证"同意的是哪一版")
    note          TEXT,
    created_by    TEXT,                             -- 操作人 user id
    created_at    INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS job (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL DEFAULT 'default',
    type          TEXT NOT NULL DEFAULT 'video',          -- video | (后续) clone
    status        TEXT NOT NULL DEFAULT 'queued',         -- queued|running|done|failed
    progress      INTEGER NOT NULL DEFAULT 0,             -- 0-100
    input_json    TEXT NOT NULL,                          -- 生成入参(形象/音色/文案)
    baichuan_task_id TEXT,                                -- 百炼侧 task_id(poll 用)
    output_url    TEXT,                                   -- 成品视频 URL(MinIO 签名或 key)
    ai_label      TEXT,                                   -- AI 标识来源:native|postprocess|none
    error         TEXT,                                   -- 失败原因(用户可见)
    attempts      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    started_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_job_status ON job(status, created_at);
`);

// 幂等迁移:给早于"形象库 C5/C6"的旧库补列(CREATE TABLE IF NOT EXISTS 不会改已存在的表)。
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
addColumnIfMissing('audit_log', 'actor_type', `actor_type TEXT NOT NULL DEFAULT 'user'`);
addColumnIfMissing('avatar', 'orientation', `orientation TEXT DEFAULT 'portrait'`);
addColumnIfMissing('avatar', 'is_default', `is_default INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('user', 'display_name', `display_name TEXT`);
addColumnIfMissing('authorization', 'terms_version', `terms_version TEXT`);
addColumnIfMissing('voice', 'provider_voice_id', `provider_voice_id TEXT`);
// 多工具平台:job.output_kind 区分产物类型(video|image|audio),右画廊按此渲染。
// output_url 语义随之改为 JSON 字符串(key 数组)——旧视频行是裸 key 字符串,读路径 JSON.parse
// 失败时兜底当单 key(向后兼容,见 api/jobs.ts)。默认 'video' 让旧行保持视频语义。
addColumnIfMissing('job', 'output_kind', `output_kind TEXT NOT NULL DEFAULT 'video'`);

// 成员与权限升级:
//  - tenant.max_creator_seats:创作席位上限(licensing 真相源,默认 10)。
//    NOT NULL DEFAULT 安全:旧行由 SQLite ALTER 自动回填默认值(同 avatar.is_default)。
//  - user.last_active:最近活跃时间戳(resolveSession throttle 写,可空=从未活跃)。
const tenantHadSeats = (db.prepare(`PRAGMA table_info(tenant)`).all() as { name: string }[]).some(
  (c) => c.name === 'max_creator_seats',
);
addColumnIfMissing('tenant', 'max_creator_seats', `max_creator_seats INTEGER NOT NULL DEFAULT 10`);
addColumnIfMissing('user', 'last_active', `last_active INTEGER`);

// clamp 迁移(仅刚加列时跑一次):现有租户若已超 10 个创作者,把上限抬到当前数,
// 否则统计卡显示「15/10」且 create/enable 全被拦,现有客户一上来就被锁死无救济。
if (!tenantHadSeats) {
  db.prepare(
    `UPDATE tenant SET max_creator_seats = MAX(10, (
       SELECT COUNT(*) FROM user
       WHERE user.tenant_id = tenant.id AND user.role='creator' AND user.status='active'
     ))`,
  ).run();
}

// 用户名全局唯一(登录免输机构 ID):在 user.username 上建唯一索引。
// 旧库若已有重名用户会建索引失败 —— 用 try 包裹并告警,交付时人工清理重名。
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_username_global ON user(username)`);
} catch {
  console.warn('[迁移] user.username 存在跨租户重名,未能建全局唯一索引;请清理重名后重启。');
}

// AI 图片模型 admin 覆盖层(CEO A2:代码拥有技术契约,DB 只覆盖展示/运营字段)。
//   key            对应代码 IMAGE_MODELS 的 key,或管理员新增的 key
//   shape_template 新增模型时指向一个代码定义的技术模板 key(取 shape/sizeKind/modes/maxResolution)
//   label/model_id/enabled/price_tier/max_images  管理员可改的展示/运营字段
// 技术契约(shape/sizeKind/...)永不入表 —— 改不到 = 改不坏(防呆 by construction)。
db.exec(`
  CREATE TABLE IF NOT EXISTS image_model_override (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    model_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    price_tier INTEGER NOT NULL,
    max_images INTEGER NOT NULL,
    shape_template TEXT,
    created_at INTEGER NOT NULL
  )
`);

export interface ImageModelOverrideRow {
  key: string;
  label: string;
  model_id: string;
  enabled: number;
  price_tier: number;
  max_images: number;
  shape_template: string | null;
  created_at: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: string;
  tenant_id: string;
  type: string;
  status: JobStatus;
  progress: number;
  input_json: string;
  baichuan_task_id: string | null;
  output_url: string | null; // 存储 key;多工具后为 JSON key 数组(旧视频行是裸 key 字符串)
  output_kind: string; // video | image | audio(右画廊渲染依据;旧行默认 video)
  ai_label: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
}

export type Role = 'admin' | 'creator' | 'viewer';
export type UserStatus = 'active' | 'disabled';

export interface TenantRow {
  id: string;
  name: string;
  delivery: 'hosted' | 'private';
  max_creator_seats: number;
  created_at: number;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: Role;
  status: UserStatus;
  last_active: number | null;
  created_at: number;
}

export interface SessionRow {
  token: string;
  user_id: string;
  tenant_id: string;
  created_at: number;
  expires_at: number;
}

export type LedgerKind = 'grant' | 'reserve' | 'settle' | 'release';

export interface LedgerRow {
  id: string;
  tenant_id: string;
  kind: LedgerKind;
  amount: number;
  job_id: string | null;
  note: string | null;
  created_at: number;
}

export type ActorType = 'user' | 'platform_admin';

export interface AuditRow {
  id: string;
  tenant_id: string;
  user_id: string | null; // 语义 = actor_id;actor_type=platform_admin 时指向 platform_admin.id
  actor_type: ActorType;
  action: string;
  target: string | null;
  ip: string | null;
  created_at: number;
}

export interface PlatformAdminRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface PlatformSessionRow {
  token: string;
  padmin_id: string;
  created_at: number;
  expires_at: number;
}

export type AvatarKind = 'preset' | 'photo' | 'video';
export type AvatarStatus = 'processing' | 'ready' | 'failed';

export interface AvatarRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: AvatarKind;
  status: AvatarStatus;
  source_key: string | null;
  thumb_url: string | null;
  authorization_id: string | null;
  orientation: string | null;
  is_default: number;
  created_at: number;
}

export interface AuthorizationRow {
  id: string;
  tenant_id: string;
  subject_type: 'avatar' | 'voice';
  consent: number;
  proof_key: string | null;
  terms_version: string | null;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

export type VoiceKind = 'preset' | 'clone';
export type VoiceStatus = 'processing' | 'ready' | 'failed';

export interface VoiceRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: VoiceKind;
  status: VoiceStatus;
  source_key: string | null;
  provider_voice_id: string | null;
  authorization_id: string | null;
  created_at: number;
}

