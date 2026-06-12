// 灵镜 数据库层 — SQLite(better-sqlite3,同步 API,Slice1 单机够用)。
//
// Slice 1 只建命脉闭环需要的表:job(同时是队列)。
// Slice 2/3 再加 tenant / user / avatar / voice / credit_ledger / audit_log / authorization。
// 设计文档 Data Model 是完整骨架;这里只落 Slice 1 子集,避免过度建设。

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
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
    kind          TEXT NOT NULL DEFAULT 'preset',   -- preset | clone | design
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
// T-SETTINGS-AUDIT-DIFF:字段级变更详情(JSON [{field,old,new}]);只设置变更类操作写,其余 null。
addColumnIfMissing('audit_log', 'detail', `detail TEXT`);
addColumnIfMissing('avatar', 'orientation', `orientation TEXT DEFAULT 'portrait'`);
addColumnIfMissing('avatar', 'is_default', `is_default INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('user', 'display_name', `display_name TEXT`);
addColumnIfMissing('authorization', 'terms_version', `terms_version TEXT`);
addColumnIfMissing('voice', 'provider_voice_id', `provider_voice_id TEXT`);
// 多工具平台:job.output_kind 区分产物类型(video|image|audio),右画廊按此渲染。
// output_url 语义随之改为 JSON 字符串(key 数组)——旧视频行是裸 key 字符串,读路径 JSON.parse
// 失败时兜底当单 key(向后兼容,见 api/jobs.ts)。默认 'video' 让旧行保持视频语义。
addColumnIfMissing('job', 'output_kind', `output_kind TEXT NOT NULL DEFAULT 'video'`);
// 用量计费归属(谁消费):记录创建该任务的用户 id(可空)。老 job 为 NULL → 计费明细显「—」。
// credit_ledger 不冗余存用户/工具,经 job_id JOIN job(取 created_by + type)还原"谁 + 什么工具"。
addColumnIfMissing('job', 'created_by', `created_by TEXT`);

// ── 账号级数据隔离(机构共享 → 账号私有)──
// 形象/音色补 created_by(job 已有上面那列)。NULL = 部署前的老资产/无主,仅 admin 可见。
// 时序严格:① 先加列 → ② 复合索引 → ③ viewer→creator 迁移 → ④ 老资产回填(UPDATE 引用 created_by,必须在加列后)。
const avatarHadCreatedBy = (db.prepare(`PRAGMA table_info(avatar)`).all() as { name: string }[]).some((c) => c.name === 'created_by');
const voiceHadCreatedBy = (db.prepare(`PRAGMA table_info(voice)`).all() as { name: string }[]).some((c) => c.name === 'created_by');
addColumnIfMissing('avatar', 'created_by', `created_by TEXT`);
addColumnIfMissing('voice', 'created_by', `created_by TEXT`);
// ② 复合索引:creator 查询 WHERE tenant_id=? AND created_by=? 走索引(admin 的 tenant-only 查询用现有 idx_*_tenant)。
db.exec(`CREATE INDEX IF NOT EXISTS idx_job_tenant_creator ON job(tenant_id, created_by);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_avatar_tenant_creator ON avatar(tenant_id, created_by);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_voice_tenant_creator ON voice(tenant_id, created_by);`);
// ③ viewer → creator 迁移(角色精简为 admin/creator)。幂等;零行也安全。
//   必须在任何 resolveSession 读 role 前跑(import 期天然满足);DB 列无 CHECK,残留 viewer 会处处 403。
db.prepare(`UPDATE user SET role='creator' WHERE role='viewer'`).run();
// ④ 老资产回填:从 audit_log(create_avatar / clone_voice / design_voice 行带 user_id + target=assetId)
//   回填 created_by,让原创作者部署后仍看得到自己部署前建的资产。只在刚加列时跑一次(幂等,只填 NULL)。
//   回填不到的(audit 无记录)→ 留 NULL = 机构公共,仅 admin 可见。
if (!avatarHadCreatedBy) {
  db.prepare(
    `UPDATE avatar SET created_by = (
       SELECT a.user_id FROM audit_log a
       WHERE a.action='create_avatar' AND a.target=avatar.id AND a.user_id IS NOT NULL
       ORDER BY a.created_at ASC LIMIT 1)
     WHERE created_by IS NULL`,
  ).run();
}
if (!voiceHadCreatedBy) {
  db.prepare(
    `UPDATE voice SET created_by = (
       SELECT a.user_id FROM audit_log a
       WHERE a.action IN ('clone_voice','design_voice') AND a.target=voice.id AND a.user_id IS NOT NULL
       ORDER BY a.created_at ASC LIMIT 1)
     WHERE created_by IS NULL`,
  ).run();
}

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

// 租户品牌:tenant.slug —— 落地页按 /landing.html?org=<slug> 识别租户并渲染其品牌。
//   slug = 随机不可猜短串(8 位 base62),防枚举发现「哪些机构用了平台 + 机构名」(政企/融媒隐私)。
//   链接由平台/管理员主动分发,不做可读 slug。
const tenantHadSlug = (db.prepare(`PRAGMA table_info(tenant)`).all() as { name: string }[]).some(
  (c) => c.name === 'slug',
);
addColumnIfMissing('tenant', 'slug', `slug TEXT`);

// 8 位 base62 随机串(~2e14 空间,枚举不可行)。better-sqlite3 同步,循环重试保证唯一。
function genTenantSlug(): string {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHA[bytes[i]! % 62];
  return s;
}
const slugExists = db.prepare(`SELECT 1 FROM tenant WHERE slug=? LIMIT 1`);
// 创建租户(auth/createTenant)与迁移回填共用,保证唯一。
export function uniqueTenantSlug(): string {
  for (let i = 0; i < 20; i++) {
    const s = genTenantSlug();
    if (!slugExists.get(s)) return s;
  }
  throw new Error('tenant.slug 连续 20 次碰撞,异常');
}

// 一次性回填(仅刚加列时):给每个现有租户生成唯一随机 slug。
// 不回填则 /landing.html?org=<slug> 对所有老租户失效(功能静默不可用)—— 同 max_creator_seats 教训。
if (!tenantHadSlug) {
  const rows = db.prepare(`SELECT id FROM tenant WHERE slug IS NULL`).all() as { id: string }[];
  const setSlug = db.prepare(`UPDATE tenant SET slug=? WHERE id=?`);
  for (const r of rows) setSlug.run(uniqueTenantSlug(), r.id);
}
// slug 唯一索引(NULL 不参与唯一约束,SQLite 允许多 NULL —— 新建租户须显式赋 slug)。
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_slug ON tenant(slug) WHERE slug IS NOT NULL`);

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
// modes:管理员勾选的模式(CSV "text2img,img2img");空=回落代码模板 modes。sort_order:展示排序(小在前)。
addColumnIfMissing('image_model_override', 'modes', `modes TEXT`);
addColumnIfMissing('image_model_override', 'sort_order', `sort_order INTEGER NOT NULL DEFAULT 0`);
// resolutions:admin 录的分辨率列表 JSON([{ratio,width,height,isDefault}],照百炼官方推荐表)。
//   空/null = 回落代码默认(imageSize 算法)。tier(计价档)由 width*height 自动推,不入表。
addColumnIfMissing('image_model_override', 'resolutions', `resolutions TEXT`);

export interface ImageModelOverrideRow {
  key: string;
  label: string;
  model_id: string;
  enabled: number;
  price_tier: number;
  max_images: number;
  shape_template: string | null;
  modes: string | null; // CSV;null/空 = 用代码模板 modes
  sort_order: number;
  resolutions: string | null; // JSON [{ratio,width,height,isDefault}];null/空 = 回落代码默认
  created_at: number;
}

// ── 积分套餐 + 意向线索(/plan-design-review + /plan-eng-review)──
// pricing_plan:admin 后台动态管理的定价套餐,前端定价区只渲染。照 image_model_override 范式
//   (代码不写死套餐,运营在后台填真实价/积分;改完即时生效)。price_yuan 可空 = 面议。
// sales_leads:咨询式购买点击落库(不接支付)。点「购买/扩容/企业定制」记一条线索给运营跟进。
//   套餐快照(name/price/credits/bonus)落库 —— 套餐被改/删后线索仍可读运营手动 grant 的依据。
db.exec(`
  CREATE TABLE IF NOT EXISTS pricing_plan (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    price_yuan      INTEGER,                    -- NULL = 面议(对公区间价/联系报价)
    credits         INTEGER NOT NULL,
    bonus_credits   INTEGER NOT NULL DEFAULT 0,
    validity_months INTEGER NOT NULL DEFAULT 12,
    features        TEXT,                       -- 卖点 JSON 数组
    flag            TEXT,                       -- 角标(如"最受欢迎";空=无)
    enabled         INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sales_leads (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    plan_id            TEXT,                     -- 可空:enterprise/topup 无具体套餐
    plan_name          TEXT,                     -- 套餐名快照
    plan_price_yuan    INTEGER,                  -- 价格快照
    plan_credits       INTEGER,                  -- 积分数快照(运营手动 grant 依据)
    plan_bonus_credits INTEGER,                  -- 赠送积分快照
    kind               TEXT NOT NULL DEFAULT 'plan',  -- plan | enterprise | topup
    note               TEXT,                     -- 用户诉求/金额 + 运营备注
    status             TEXT NOT NULL DEFAULT 'new',   -- new | contacted | closed
    created_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_tenant ON sales_leads(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON sales_leads(status);
`);

// ── 对公充值闭环:订单 + 发票 ──
// ┌─ 订单状态机(transitionOrder 单一原子迁移,WHERE status=from + changes===1 守卫)──┐
// │  pending_payment ──「我已打款」(+可选回单)──▶ paid_claimed                          │
// │  paid_claimed    ── 超管确认到账 ──▶ credited(同事务 grant credits+bonus 一次)      │
// │  paid_claimed    ── 超管驳回 ──▶ rejected(带 admin_note)                            │
// │  rejected        ── 用户重新提交打款 ──▶ paid_claimed                                │
// │  pending/rejected ── 用户取消 ──▶ cancelled(≥paid_claimed 前端隐藏取消,守卫兑底)   │
// │  credited 为终态。退款追回本轮无 UI(手工 runbook,见计划)。                          │
// └────────────────────────────────────────────────────────────────────────────────────┘
// 金额/积分以 order 行**全快照**为准(套餐改/删不影响已下单);order_no 事务内日计数 + UNIQUE 兜底。
db.exec(`
  CREATE TABLE IF NOT EXISTS recharge_order (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    created_by      TEXT NOT NULL,              -- 下单人(账号隔离;充值必有登录用户)
    order_no        TEXT NOT NULL UNIQUE,       -- 展示号 LJyyyymmdd-seq(事务内生成,UNIQUE 兜底)
    plan_id         TEXT,                       -- 快照来源(套餐可能后续被删,仅留痕)
    plan_name       TEXT NOT NULL,              -- ↓ 下单时全快照,grant/发票只读这些,与 pricing_plan 后续改动无关
    price_yuan      INTEGER NOT NULL,           -- 应付金额(建单已拒 NULL 面议套餐)
    credits         INTEGER NOT NULL,
    bonus_credits   INTEGER NOT NULL DEFAULT 0,
    validity_months INTEGER NOT NULL DEFAULT 12,
    status          TEXT NOT NULL DEFAULT 'pending_payment',
    receipt_key     TEXT,                       -- 银行回单截图 storage key(可空)
    admin_note      TEXT,                       -- 驳回原因(超管填)
    confirmed_by    TEXT,                       -- 确认/驳回的超管 id
    confirmed_at    INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_order_tenant_creator ON recharge_order(tenant_id, created_by);
  CREATE INDEX IF NOT EXISTS idx_order_status ON recharge_order(status);

  CREATE TABLE IF NOT EXISTS invoice (
    id          TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL,                  -- 仅 credited 订单可申请
    tenant_id   TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    title       TEXT NOT NULL,                  -- 抬头
    tax_no      TEXT NOT NULL,                  -- 税号
    kind        TEXT NOT NULL DEFAULT '普票',    -- 本轮仅普票(专票字段留下轮)
    amount_yuan INTEGER NOT NULL,               -- 申请时金额快照(= order.price_yuan)
    status      TEXT NOT NULL DEFAULT 'requested', -- requested | issued(none 即未申请,无行)
    invoice_no  TEXT,                           -- 超管回填发票号
    pdf_key     TEXT,                           -- 超管上传 PDF storage key
    admin_note  TEXT,                           -- 驳回原因
    created_at  INTEGER NOT NULL,
    issued_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_invoice_tenant_creator ON invoice(tenant_id, created_by);
  CREATE INDEX IF NOT EXISTS idx_invoice_order ON invoice(order_id);
  CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoice(status);

  -- 对公收款信息(单行平台配置,超管后台填;真实银行账号不进代码/git)。
  CREATE TABLE IF NOT EXISTS payee_setting (
    id           INTEGER PRIMARY KEY CHECK (id = 1),  -- 单例行
    payee_name   TEXT,
    tax_no       TEXT,
    bank_name    TEXT,
    bank_account TEXT,
    updated_at   INTEGER
  );
`);

// credit_ledger 加 order_id:充值 grant 写入,部分唯一索引做 grant 幂等双保险(外部声音 #8)。
// 即使确认守卫漏了,同一 order 第二次 grant 也被唯一索引拦下。
addColumnIfMissing('credit_ledger', 'order_id', `order_id TEXT`);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_order_grant ON credit_ledger(order_id) WHERE kind='grant' AND order_id IS NOT NULL;`,
);

export interface PricingPlanRow {
  id: string;
  name: string;
  price_yuan: number | null; // null = 面议
  credits: number;
  bonus_credits: number;
  validity_months: number;
  features: string | null; // JSON 数组字符串
  flag: string | null;
  enabled: number;
  sort_order: number;
  created_at: number;
}

export type LeadKind = 'plan' | 'enterprise' | 'topup';
export type LeadStatus = 'new' | 'contacted' | 'closed';

export interface SalesLeadRow {
  id: string;
  tenant_id: string;
  user_id: string;
  plan_id: string | null;
  plan_name: string | null;
  plan_price_yuan: number | null;
  plan_credits: number | null;
  plan_bonus_credits: number | null;
  kind: LeadKind;
  note: string | null;
  status: LeadStatus;
  created_at: number;
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid_claimed'
  | 'credited'
  | 'rejected'
  | 'cancelled';

export interface RechargeOrderRow {
  id: string;
  tenant_id: string;
  created_by: string;
  order_no: string;
  plan_id: string | null;
  plan_name: string;
  price_yuan: number;
  credits: number;
  bonus_credits: number;
  validity_months: number;
  status: OrderStatus;
  receipt_key: string | null;
  admin_note: string | null;
  confirmed_by: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

export type InvoiceStatus = 'requested' | 'issued';

export interface InvoiceRow {
  id: string;
  order_id: string;
  tenant_id: string;
  created_by: string;
  title: string;
  tax_no: string;
  kind: string;
  amount_yuan: number;
  status: InvoiceStatus;
  invoice_no: string | null;
  pdf_key: string | null;
  admin_note: string | null;
  created_at: number;
  issued_at: number | null;
}

export interface PayeeSettingRow {
  id: number;
  payee_name: string | null;
  tax_no: string | null;
  bank_name: string | null;
  bank_account: string | null;
  updated_at: number | null;
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
  created_by: string | null; // 创建该任务的用户 id(计费归属;老 job 为 NULL)
}

export type Role = 'admin' | 'creator';
export type UserStatus = 'active' | 'disabled';

export interface TenantRow {
  id: string;
  name: string;
  delivery: 'hosted' | 'private';
  max_creator_seats: number;
  created_at: number;
  slug?: string | null; // 落地页品牌识别用随机 slug(老行可空,新建必赋)
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
  order_id: string | null; // 充值到账 grant 关联订单(幂等 + 审计);非充值行为空
  note: string | null;
  created_at: number;
  // 计费归属(ledger() JOIN job/user 派生;非表列)。grant 行无 job → 两者空;老 job → userName 空。
  toolType?: string | null; // 工具类型(job.type;前端映射中文场景名)
  userName?: string | null; // 消费人(display_name 或 username)
  // 关联作品(ledger() 解析 job.input_json 派生;非表列)。grant 行 / 无文案的老 job → 空。
  taskTitle?: string | null; // 作品文案摘要(按工具取 script/prompt/text/lyrics,截前 24 字)
  outputKind?: string | null; // 产物类型(job.output_kind:video/image/audio;决定前端预览渲染)
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
  detail: string | null; // 字段级变更 JSON([{field,old,new}]);仅设置变更类操作有(T-SETTINGS-AUDIT-DIFF)
  created_at: number;
  // 操作者名(listAudit() JOIN user/platform_admin 派生;非表列)。user_id 为空 / 用户已删 → 空。
  actorName?: string | null; // user → display_name||username;platform_admin → username
  // 模块/工具类型(listAudit() JOIN job 派生;非表列)。create_job 行 = job.type;非工具行 / job 已删 → 空。
  module?: string | null; // video_i2v / ai_image / tts ...;前端映射中文模块名 + 分色
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
  created_by: string | null; // 创建者用户 id(账号隔离);老资产/回填不到 → NULL = 机构公共,仅 admin 可见
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

export type VoiceKind = 'preset' | 'clone' | 'design';
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
  created_by: string | null; // 创建者用户 id(账号隔离);老资产/回填不到 → NULL = 机构公共,仅 admin 可见
  created_at: number;
}

// ── 账号级数据隔离 helper ──
// 在租户隔离(WHERE tenant_id=?)之上叠加账号隔离:
//   admin → 看全机构(不加 created_by 限制,返回空片段);
//   creator → 仅看 created_by=自己(NULL 老数据自然不匹配 → 看不到,符合「机构公共仅 admin 可见」)。
// 用法:`WHERE tenant_id=? ${scope.clause} ORDER BY ... LIMIT ?`,参数按位拼 `.all(tenantId, ...scope.params, limit)`。
// 关键:scope.params 插在 tenantId 与 limit 之间,绝不追加末尾(会与 LIMIT ? 错位)。
export function scopeByActor(
  actingUserId: string,
  isAdmin: boolean,
  col = 'created_by',
): { clause: string; params: string[] } {
  return isAdmin ? { clause: '', params: [] } : { clause: ` AND ${col} = ?`, params: [actingUserId] };
}

