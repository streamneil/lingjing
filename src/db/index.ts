// 灵镜 数据库层 — SQLite(better-sqlite3,同步 API,Slice1 单机够用)。
//
// Slice 1 只建命脉闭环需要的表:job(同时是队列)。
// Slice 2/3 再加 tenant / user / avatar / voice / credit_ledger / audit_log / authorization。
// 设计文档 Data Model 是完整骨架;这里只落 Slice 1 子集,避免过度建设。

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { encryptKey, masterKey, lastFour } from '../gateway/key-crypto.js'; // 叶子(纯 node:crypto,无 db/config 依赖,防环)
import { translateProviderError } from '../gateway/provider-errors.js'; // 叶子(纯函数,无 db 依赖,防环)

export const db = new Database(config.db.file);
db.pragma('journal_mode = WAL'); // 并发读 + 单写,适合 worker 轮询拉任务
db.pragma('busy_timeout = 5000'); // 写碰撞时等而非立刻抛 SQLITE_BUSY(WAL 下单进程现不触发,但为 worker 拆进程留保险)
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

  -- Open API key(lj_sk_…):key == 成员本人。只存 sha256 哈希,明文创建时回传一次。
  -- 无生命周期联动(产品决策):认证时每请求查 user 最新状态,主人停用即 401(免费,非联动)。
  CREATE TABLE IF NOT EXISTS api_key (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    user_id       TEXT NOT NULL,                    -- key 的主人,key 即此人
    name          TEXT NOT NULL,                    -- 用户备注名,如 "我的 Claude Code"
    key_hash      TEXT NOT NULL,                    -- sha256(key) hex,明文不落库
    key_prefix    TEXT NOT NULL,                    -- 前 12 位明文,列表页展示 "lj_sk_a3f9…"
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    revoked_at    INTEGER,                           -- 非空即吊销;不删行,留审计
    FOREIGN KEY (user_id) REFERENCES user(id)
  );
  CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_key(key_hash);
  CREATE INDEX IF NOT EXISTS idx_api_key_tenant ON api_key(tenant_id);
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

// ── 短信验证码登录 / 自助注册(/plan-ceo-review + /plan-eng-review,2026-06-24)──
// sms_code:验证码不落明文(code_hash=sha256(phone:code))。purpose 枚举服务 4 流程
//   (login|register|reset|rebind),verify 须绑 (phone,purpose) 且执行特权副作用同事务消费。
//   单活码:每 (phone,purpose) 只保留最新一条(发码前先删旧)。attempts ≤5 即作废(6 位防暴破)。
// sms_send_log:append-only 发送流水,做「每手机号 60s / 每手机号日 / 每 IP 日」限频计数
//   (sms_code 消费即删会丢计数,故独立计数表);保留 30 天,惰性清。超管只读视图读它。
db.exec(`
  CREATE TABLE IF NOT EXISTS sms_code (
    id          TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    purpose     TEXT NOT NULL,            -- login | register | reset | rebind
    code_hash   TEXT NOT NULL,            -- sha256(phone:code),不落明文
    attempts    INTEGER NOT NULL DEFAULT 0,
    ip          TEXT,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    UNIQUE (phone, purpose)               -- 单活码:同手机号同用途只一条(发码前 DELETE 旧的)
  );
  CREATE INDEX IF NOT EXISTS idx_sms_code_exp ON sms_code(expires_at);

  CREATE TABLE IF NOT EXISTS sms_send_log (
    id          TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    ip          TEXT,
    purpose     TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sms_send_phone ON sms_send_log(phone, created_at);
  CREATE INDEX IF NOT EXISTS idx_sms_send_ip ON sms_send_log(ip, created_at);

  -- login_fail_log:append-only 密码登录失败流水,做「每 IP / 每账号 窗口内失败」限频计数。
  -- /login 原本只有 captcha 一道闸,自建滑块答案下发前端可被脚本绕 → 密码暴破无墙;此表是真墙。惰性清。
  CREATE TABLE IF NOT EXISTS login_fail_log (
    id          TEXT PRIMARY KEY,
    ip          TEXT,
    username    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_fail_ip ON login_fail_log(ip, created_at);
  CREATE INDEX IF NOT EXISTS idx_login_fail_user ON login_fail_log(username, created_at);
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
// Open API:操作经 API key 发起时记 key id(区分本人网页操作 vs 客户 Agent 操作);cookie 操作为 null。
addColumnIfMissing('audit_log', 'via_api_key', `via_api_key TEXT`);
addColumnIfMissing('avatar', 'orientation', `orientation TEXT DEFAULT 'portrait'`);
addColumnIfMissing('avatar', 'is_default', `is_default INTEGER NOT NULL DEFAULT 0`);
addColumnIfMissing('user', 'display_name', `display_name TEXT`);
// 短信登录:user.phone(可空,部分唯一索引 —— NULL 不参与唯一,老用户无手机号)。
//   新手机号自助注册时 username=phone(Fork2);无密码用户 password_hash 存哨兵 ''(Fork1,免迁移)。
addColumnIfMissing('user', 'phone', `phone TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_phone ON user(phone) WHERE phone IS NOT NULL`);
addColumnIfMissing('authorization', 'terms_version', `terms_version TEXT`);
addColumnIfMissing('voice', 'provider_voice_id', `provider_voice_id TEXT`);
// 多工具平台:job.output_kind 区分产物类型(video|image|audio),右画廊按此渲染。
// output_url 语义随之改为 JSON 字符串(key 数组)——旧视频行是裸 key 字符串,读路径 JSON.parse
// 失败时兜底当单 key(向后兼容,见 api/jobs.ts)。默认 'video' 让旧行保持视频语义。
addColumnIfMissing('job', 'output_kind', `output_kind TEXT NOT NULL DEFAULT 'video'`);
// 用量计费归属(谁消费):记录创建该任务的用户 id(可空)。老 job 为 NULL → 计费明细显「—」。
// credit_ledger 不冗余存用户/工具,经 job_id JOIN job(取 created_by + type)还原"谁 + 什么工具"。
addColumnIfMissing('job', 'created_by', `created_by TEXT`);
// Open API 幂等键(设计文档 §4.4):客户端可选 Idempotency-Key,防 Agent 超时重试双扣费。
//   idempotency_key = 客户端任意串;idempotency_hash = 请求 body 的 canonical sha256(检测同键异 body → 409)。
//   reserved_cost 存本次预扣积分,幂等命中时原样返回,无需 JOIN ledger。
addColumnIfMissing('job', 'idempotency_key', `idempotency_key TEXT`);
addColumnIfMissing('job', 'idempotency_hash', `idempotency_hash TEXT`);
addColumnIfMissing('job', 'reserved_cost', `reserved_cost INTEGER`);
// 部分唯一索引:同租户同 key 唯一;key 为 NULL(绝大多数请求)不参与唯一。并发同键第二插入撞此索引 → submitJob 兜底返原 job。
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_idem ON job(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

// 失败可读化(用户反馈:前端不能出现英文 JSON;admin 需看到原始日志排障)。
//   error 列语义收敛为「用户可读中文」;新增 error_detail 存「原始技术日志」(厂商 code/RequestId)。
//   markFailed 现在是单一翻译点。首次加列时回填历史失败行:原始英文错误存入 error_detail,
//   error 就地翻译为中文可读(译不出的原样保留,detail 永远是真相)。
{
  const jobCols = (db.prepare(`PRAGMA table_info(job)`).all() as { name: string }[]).map((c) => c.name);
  const needBackfill = !jobCols.includes('error_detail');
  addColumnIfMissing('job', 'error_detail', `error_detail TEXT`);
  if (needBackfill) {
    try {
      const failed = db
        .prepare(`SELECT id, error FROM job WHERE status='failed' AND error IS NOT NULL AND error != ''`)
        .all() as { id: string; error: string }[];
      const upd = db.prepare(`UPDATE job SET error=?, error_detail=? WHERE id=?`);
      const tx = db.transaction((rows: { id: string; error: string }[]) => {
        for (const r of rows) {
          const { readable, detail } = translateProviderError(r.error);
          upd.run(readable, detail, r.id);
        }
      });
      tx(failed);
    } catch {
      /* 回填是尽力而为:失败不阻塞启动(新失败行仍会被 markFailed 正确翻译) */
    }
  }
}

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
// 并发改造(2026-06-16):claimNextJob 的 per-tenant cap COUNT 与 admin 看板都按 status 过滤活跃 job。
//   部分索引只收录 queued/running 行 → 比全 (tenant_id,status) 索引小得多,正好服务这两个热查询。
db.exec(`CREATE INDEX IF NOT EXISTS idx_job_tenant_active ON job(tenant_id, status) WHERE status IN ('queued','running');`);
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
// 成本驱动定价(2026-06):real_cost_yuan = 厂商真实元/张;price_tier 由 admin 写入时算 ceil(real×35) 落库。
// cost_source:'doc'(价格页确价)|'estimate'(待校准,不得 enabled 上线)。
addColumnIfMissing('image_model_override', 'real_cost_yuan', `real_cost_yuan REAL`);
addColumnIfMissing('image_model_override', 'cost_source', `cost_source TEXT`);

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
  real_cost_yuan: number | null; // 厂商真实元/张(成本驱动定价源;null = 老行未录)
  cost_source: string | null; // 'doc' | 'estimate';enabled 行不应为 estimate
  created_at: number;
}

// ── 定价管理(2026-06:全模态后台调价)──
// platform_config:全局参数 key-value。markup_x35 = 毛利倍率×10积分/元 的整数(默认35=3.5倍);
//   floor_x35 = 倍率地板(默认10=保本);用整数避免 ×3.5×10 浮点多收(见 credits/pricing.ts)。
db.exec(`CREATE TABLE IF NOT EXISTS platform_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
{
  const seedCfg = db.prepare(`INSERT OR IGNORE INTO platform_config (key,value) VALUES (?,?)`);
  seedCfg.run('markup_x35', '35'); // 3.5 倍毛利 × 10 积分/元
  seedCfg.run('credits_per_yuan', '10');
  seedCfg.run('floor_x35', '10'); // 倍率地板:markup_x35 ≥ 10 才保本(建议运营设 ≥30 守毛利)
  seedCfg.run('self_serve_trial_credits', '200'); // 自助注册到账试用积分(够试跳 ~1 条;运营可调,0=不送)
}
// video_model_override:视频/数字人后台可改成本+启停(照 image_model_override 范式)。
//   一模型多档=多行(id="{key}:{variant}");enabled 默认 1 —— 视频现状全部可用,默认0会误杀生成。
db.exec(`
  CREATE TABLE IF NOT EXISTS video_model_override (
    id              TEXT PRIMARY KEY,
    model_key       TEXT NOT NULL,
    variant         TEXT,
    real_cost_yuan  REAL NOT NULL,
    cost_source     TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    updated_at      INTEGER NOT NULL
  )
`);

export interface VideoModelOverrideRow {
  id: string;
  model_key: string;
  variant: string | null; // 720P/1080P/audio-720P… ;null=无档
  real_cost_yuan: number;
  cost_source: string; // 'doc' | 'estimate'
  enabled: number;
  updated_at: number;
}

// ── model_pricing:全模态「价格+启停」统一真源(2026-06,/plan-ceo-review + /plan-eng-review)──
// 为什么:旧定价散 3 套不兼容表(image_model_override 14列 / video_model_override 7列 / platform_config TTS),
//   加新模型(seedance/nanobanana…)每次选错桶 + 写专属 UI。本表只管「价格(real_cost_yuan)+ enabled」,
//   一张表统一图片/视频/TTS;业务字段(label/modes/resolutions…)仍留各自原表(价格统一 ≠ 字段统一)。
// 读价点(mergeDef / videoPriceTier / ttsPricePerChar)统一经 lookupCost(credits/pricing.ts)读本表 → 收口双源。
// 一模型多档=多行:id="{model_key}:{variant}"(无档则 variant=null,id=model_key)。enabled DEFAULT 0:
//   「无行 = 不启用」(沿用 image isEnabled 修后的「默认不启用」语义,防占位价静默上线)。
db.exec(`
  CREATE TABLE IF NOT EXISTS model_pricing (
    id              TEXT PRIMARY KEY,            -- "{model_key}" 或 "{model_key}:{variant}"
    model_key       TEXT NOT NULL,
    modality        TEXT NOT NULL,               -- 'image' | 'video' | 'tts'
    unit            TEXT NOT NULL,               -- '张' | '秒' | '万字' 等(展示用)
    variant         TEXT,                        -- 720P/audio-1080P/null
    real_cost_yuan  REAL NOT NULL,               -- 厂商真实成本(售价=ceil(×markup_x35),见 pricing.ts:sellPrice)
    cost_source     TEXT NOT NULL DEFAULT 'doc', -- 'doc'(价格页确价)| 'estimate'(待校准,不得 enabled)
    enabled         INTEGER NOT NULL DEFAULT 0,  -- 无行/0 = 不启用(防占位价静默上线)
    sort_order      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
  )
`);
// 启动幂等迁移(eng-review E4):本表空时,从 3 套旧表各搬一次价格;幂等键 = model_pricing.id 已存在则跳。
// 插入点必须在 image_model_override / video_model_override / platform_config 之后(读源表)—— 已满足(此处在三者后)。
{
  const empty = (db.prepare('SELECT COUNT(*) AS c FROM model_pricing').get() as { c: number }).c === 0;
  if (empty) {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const ts = Date.now();
    let migrated = 0;
    // 图片:image_model_override(只搬有真实成本的 enabled 行;成本缺失行不搬 = 迁移后不启用,需 admin 录价)。
    const imgRows = db.prepare(
      `SELECT key, enabled, real_cost_yuan, cost_source, sort_order FROM image_model_override WHERE real_cost_yuan IS NOT NULL AND real_cost_yuan > 0`,
    ).all() as { key: string; enabled: number; real_cost_yuan: number; cost_source: string | null; sort_order: number }[];
    for (const r of imgRows) {
      ins.run(r.key, r.key, 'image', '张', null, r.real_cost_yuan, r.cost_source ?? 'doc', r.enabled, r.sort_order ?? 0, ts);
      migrated++;
    }
    // 视频:video_model_override(每档一行,id 直接复用 "{key}:{variant}")。
    const vidRows = db.prepare(
      `SELECT id, model_key, variant, real_cost_yuan, cost_source, enabled FROM video_model_override`,
    ).all() as { id: string; model_key: string; variant: string | null; real_cost_yuan: number; cost_source: string; enabled: number }[];
    for (const r of vidRows) {
      ins.run(r.id, r.model_key, 'video', '秒', r.variant, r.real_cost_yuan, r.cost_source ?? 'doc', r.enabled, 0, ts);
      migrated++;
    }
    // TTS:platform_config.tts_cost_per_char —— 该 key **只在 seed-demo 种,db/index.ts 没种**(eng-review E4 CRITICAL):
    //   非 demo/生产库读到 NULL,故 `|| 0.00008` 硬兜底(= 0.8元/万字符真实成本),否则迁移搬 0 行音色价、静默退回代码常数。
    const ttsCfg = db.prepare(`SELECT value FROM platform_config WHERE key='tts_cost_per_char'`).get() as { value?: string } | undefined;
    const ttsCostVal = Number(ttsCfg?.value) || 0.00008;
    ins.run('tts', 'tts', 'tts', '万字', '每字', ttsCostVal, 'doc', 1, 0, ts);
    migrated++;
    if (migrated) console.log(`[migrate] model_pricing 已从旧表搬入 ${migrated} 行(图片/视频/TTS 统一定价)`);
  }
  // 注:豆包真实定价由 seed-demo 种(同所有产品模型),不在此启动迁移里种 —— 否则会污染测试 :memory: 库
  //   (测试不跑 seed-demo,旧图片模型无 model_pricing 行,若此处单种豆包会让豆包成为唯一 enabled 图片模型,
  //    破 getImageModel 默认兜底契约)。存量生产库补豆包:重跑 seed-demo 或 admin 定价页录价。
}

export interface ModelPricingRow {
  id: string;
  model_key: string;
  modality: string; // 'image' | 'video' | 'tts'
  unit: string;
  variant: string | null;
  real_cost_yuan: number;
  cost_source: string; // 'doc' | 'estimate'
  enabled: number;
  sort_order: number;
  updated_at: number;
}

// ── provider:厂商 + 加密 API Key(2026-06,model-access-platform PR-1)──
// 各厂商模型 key 原在 .env 易泄露 → AES-256-GCM 加密存库(密钥 MASTER_KEY 走环境变量,不进库/git)。
// admin 永不见明文,只回显 last4;解密只在网关调用时(见 gateway/provider-keys.ts)。
// cipher/iv/tag = GCM 三件套;key_version = 主密钥版本(轮转脚本按版本分批);AAD=id 防行间搬移。
db.exec(`
  CREATE TABLE IF NOT EXISTS provider (
    id              TEXT PRIMARY KEY,            -- 'bailian' | 'volc-ark' | 'google-ai-studio'
    name            TEXT NOT NULL,               -- 展示名「阿里百炼」
    adapter_key     TEXT NOT NULL,               -- 代码适配器标识(gateway 按此分发)
    base_url        TEXT NOT NULL,
    api_key_cipher  BLOB,                        -- AES-256-GCM 密文(null = 未配,回落 .env)
    api_key_iv      BLOB,
    api_key_tag     BLOB,
    key_version     INTEGER NOT NULL DEFAULT 1,  -- 主密钥版本(轮转用)
    api_key_last4   TEXT,                        -- 脱敏尾号(admin 只看这个)
    enabled         INTEGER NOT NULL DEFAULT 1,
    updated_at      INTEGER NOT NULL
  )
`);
// schema_meta:迁移版本标记(eng 外部声音 P3)。让迁移可识别「已跑/未跑」,避免重复/半态。
db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

// ── 火山素材库资产缓存(2026-07,Seedance 人脸拦截解法)──
// ark_asset_group:每 project 一个素材组(get-or-create 缓存)。
// ark_asset:storage_key(稳定去重键)→ asset_id + 状态;同一张脸只入库一次复用。
// 注意:避让已有 asset 表(形象/音色素材),故用 ark_ 前缀。
db.exec(`
  CREATE TABLE IF NOT EXISTS ark_asset_group (
    project_name  TEXT PRIMARY KEY,     -- '' = default 项目
    group_id      TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ark_asset (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     TEXT NOT NULL,
    storage_key   TEXT NOT NULL,        -- publish 前的稳定存储 key(去重键)
    project_name  TEXT NOT NULL,        -- '' = default
    asset_id      TEXT NOT NULL,        -- 火山 asset-xxx
    status        TEXT NOT NULL,        -- 'Processing' | 'Active' | 'Failed'
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (tenant_id, storage_key, project_name)
  );
  CREATE INDEX IF NOT EXISTS idx_ark_asset_tenant ON ark_asset(tenant_id);
`);
// 启动幂等迁移:provider 表空时种子 bailian。base_url 取现 config 默认;
//   key 从 .env 的 DASHSCOPE_API_KEY 加密搬入(仅当 MASTER_KEY 配置;否则 cipher 留空、运行时回落 .env)。
{
  const empty = (db.prepare('SELECT COUNT(*) AS c FROM provider').get() as { c: number }).c === 0;
  if (empty) {
    const ts = Date.now();
    const baseUrl = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
    const dashKey = process.env.DASHSCOPE_API_KEY || '';
    let cipher: Buffer | null = null, iv: Buffer | null = null, tag: Buffer | null = null, last4: string | null = null, ver = 1;
    // 有主密钥 + 有 .env key → 加密搬入(否则 cipher 留 null,getProviderKey 回落 .env)。
    if (dashKey && masterKey()) {
      try {
        const b = encryptKey(dashKey, 'bailian'); // AAD = provider.id
        cipher = b.cipher; iv = b.iv; tag = b.tag; ver = b.keyVersion; last4 = lastFour(dashKey);
      } catch { /* 加密失败不阻断启动:留 null 回落 .env */ }
    }
    db.prepare(
      `INSERT INTO provider (id,name,adapter_key,base_url,api_key_cipher,api_key_iv,api_key_tag,key_version,api_key_last4,enabled,updated_at)
       VALUES ('bailian','阿里百炼','bailian',?,?,?,?,?,?,1,?)`,
    ).run(baseUrl, cipher, iv, tag, ver, last4, ts);
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key,value) VALUES ('provider_migrated','1')`).run();
    console.log(`[migrate] provider 表已种子 bailian(${cipher ? '密钥已加密入库' : '密钥留 .env 回落(未配 MASTER_KEY)'})`);
  }
  // 火山引擎方舟(豆包,PR-2a):独立 INSERT OR IGNORE,存量库(已有 bailian)也补这行。
  //   key 不预置(用户在 admin 厂商页贴);enabled=1(provider 启用 ≠ 模型启用,模型各自 enabled 控)。
  db.prepare(
    `INSERT OR IGNORE INTO provider (id,name,adapter_key,base_url,key_version,enabled,updated_at)
     VALUES ('volc-ark','火山引擎(豆包)','volc-ark','https://ark.cn-beijing.volces.com/api/v3',1,1,?)`,
  ).run(Date.now());
  // Google AI Studio(Gemini / Nano Banana,PR-2a):同上幂等补行;key 用户在 admin 厂商页贴。
  db.prepare(
    `INSERT OR IGNORE INTO provider (id,name,adapter_key,base_url,key_version,enabled,updated_at)
     VALUES ('google-ai-studio','Google AI Studio','google-ai-studio','https://generativelanguage.googleapis.com/v1beta',1,1,?)`,
  ).run(Date.now());
  // OpenAI(GPT Image 2,第 4 个 provider):同上幂等补行;key 用户在 admin 厂商页贴。
  //   国内 ECS 直连 api.openai.com 被墙 → 网关走 OPENAI_PROXY(同 Gemini 的 GEMINI_PROXY)。
  db.prepare(
    `INSERT OR IGNORE INTO provider (id,name,adapter_key,base_url,key_version,enabled,updated_at)
     VALUES ('openai','OpenAI','openai','https://api.openai.com/v1',1,1,?)`,
  ).run(Date.now());
}

export interface ProviderRow {
  id: string;
  name: string;
  adapter_key: string;
  base_url: string;
  api_key_cipher: Buffer | null;
  api_key_iv: Buffer | null;
  api_key_tag: Buffer | null;
  key_version: number;
  api_key_last4: string | null;
  enabled: number;
  updated_at: number;
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

// ── 充值闭环:订单 + 发票 + 在线支付(微信/支付宝)──
// ┌─ 订单状态机(transitionOrder 单一原子迁移,WHERE status=from + changes===1 守卫)──┐
// │  pending_payment ──「我已打款」(对公,+可选回单)──▶ paid_claimed                    │
// │  pending_payment ── 在线支付成功(回调/查单)──▶ credited(同事务 grant 恰一次)      │
// │  paid_claimed    ── 超管确认到账 / 在线迟到回调(钱到即入账)──▶ credited             │
// │  paid_claimed    ── 超管驳回 ──▶ rejected(终态,带 admin_note)                      │
// │  pending         ── 用户取消 / 超时 sweep(在线单先查单再关单)──▶ cancelled          │
// │  credited        ── 超管退款(挂票拒退)──▶ refunding ──通道确认──▶ refunded(终态)  │
// │                                              └──通道失败──▶ credited(回退)          │
// │  支付尝试状态机见 payment_attempt 建表注释与 orders/index.ts。                        │
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

  -- 发票(一票多单;无 order_id 列 —— 订单关联走 invoice_order)。
  -- 存量库若仍是老「一票一单」(有 order_id NOT NULL)→ 下方表重建迁移修复。
  CREATE TABLE IF NOT EXISTS invoice (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    created_by  TEXT NOT NULL,                  -- 发起的租户 admin(迁移行可能是老 creator,仅展示)
    title       TEXT NOT NULL,                  -- 抬头
    tax_no      TEXT NOT NULL,                  -- 税号
    kind        TEXT NOT NULL DEFAULT '普票',    -- 本轮仅普票
    amount_yuan INTEGER NOT NULL,               -- = 所含订单金额之和(申请时快照)
    status      TEXT NOT NULL DEFAULT 'requested', -- requested | issued
    invoice_no  TEXT,                           -- 超管回填发票号
    pdf_key     TEXT,                           -- 超管上传 PDF storage key
    admin_note  TEXT,                           -- 驳回原因
    created_at  INTEGER NOT NULL,
    issued_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_invoice_tenant_creator ON invoice(tenant_id, created_by);
  CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoice(status);

  -- 一票多单关联表;UNIQUE(order_id) 保证一单只进一张在途/已开发票。
  CREATE TABLE IF NOT EXISTS invoice_order (
    invoice_id TEXT NOT NULL,
    order_id   TEXT NOT NULL UNIQUE,
    PRIMARY KEY (invoice_id, order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_invoice_order_invoice ON invoice_order(invoice_id);

  -- 租户开票抬头资料(单例/租户;首次开票自动 upsert;仅 admin 可编辑)。
  CREATE TABLE IF NOT EXISTS tenant_invoice_profile (
    tenant_id    TEXT PRIMARY KEY,
    title        TEXT,
    tax_no       TEXT,
    bank_name    TEXT,
    bank_account TEXT,
    address      TEXT,
    phone        TEXT,
    updated_at   INTEGER,
    updated_by   TEXT
  );

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

// recharge_order 加 payment_method:收银台付款方式(offline_bank | wechat | alipay)。
// 老订单加列后默认 offline_bank;在线支付在 pending_payment 期可切换,支付成功/claimPaid 时锁定。
addColumnIfMissing('recharge_order', 'payment_method', `payment_method TEXT NOT NULL DEFAULT 'offline_bank'`);
// 入账流水 id:给该订单发放积分的那一笔 payment_attempt。退款必须原路退「这一笔」——
// 一单可能有多笔已收款流水(旧码迟到支付),退错笔 = 扣了 A 的积分却退了 B 的钱。
addColumnIfMissing('recharge_order', 'credited_attempt_id', `credited_attempt_id TEXT`);

// ── 在线支付(微信/支付宝):支付尝试 + 通道配置 + 对账差异 ──
// 设计:docs/designs/online-payments.md(31 条定稿决策)。
// payment_attempt:一次通道下单一行(决策1)。id 即 out_trade_no(去横杠 UUID,32 hex,
// 微信 out_trade_no 上限 32 字符,决策12/18)。UNIQUE(order_id) WHERE pending = 每单恰一在途码(决策23)。
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_attempt (
    id           TEXT PRIMARY KEY,              -- 32 hex,即通道 out_trade_no
    order_id     TEXT NOT NULL,
    tenant_id    TEXT NOT NULL,
    channel      TEXT NOT NULL,                 -- wechat | alipay
    scene        TEXT NOT NULL,                 -- native | h5 | page | wap
    amount_fen   INTEGER NOT NULL,              -- 下单时快照,整数分(元分换算唯一点护栏)
    status       TEXT NOT NULL DEFAULT 'pending', -- pending|paid|closed|expired|refunding|refunded|refund_failed
    code_url     TEXT,                          -- native 二维码内容 / h5|page|wap 跳转 url
    txn_id       TEXT,                          -- 通道侧交易号(paid 时回填;幂等按它匹配,决策4)
    paid_at      INTEGER,
    refund_no    TEXT,                          -- 退款单号(发起退款时生成)
    refund_at    INTEGER,
    fail_reason  TEXT,                          -- refund_failed 原因(超管可见)
    expires_at   INTEGER NOT NULL,              -- min(场景TTL, 订单剩余TTL)(决策24)
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempt_order ON payment_attempt(order_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_one_pending ON payment_attempt(order_id) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS idx_attempt_expiry ON payment_attempt(expires_at) WHERE status='pending';

  -- 通道配置(单例行/通道)。敏感包(微信 APIv3密钥+商户私钥 / 支付宝应用私钥)JSON 序列化后
  -- 经 key-crypto AES-256-GCM 加密(AAD='payment:'+channel,复用 MASTER_KEY,决策3)。
  CREATE TABLE IF NOT EXISTS payment_channel_setting (
    channel            TEXT PRIMARY KEY,        -- wechat | alipay
    enabled_scenes     TEXT NOT NULL DEFAULT '[]', -- JSON 数组;Native/H5 独立开关(决策7)
    config_json        TEXT NOT NULL DEFAULT '{}', -- 非敏感:appid/mchid/公钥等
    secret_cipher      BLOB,
    secret_iv          BLOB,
    secret_tag         BLOB,
    secret_key_version INTEGER,
    updated_at         INTEGER
  );

  -- 对账差异(零静默失败最后防线)。UNIQUE 防微信重试/对账重跑刷屏(决策25)。
  CREATE TABLE IF NOT EXISTS recon_diff (
    id           TEXT PRIMARY KEY,
    bill_date    TEXT NOT NULL,                 -- yyyy-mm-dd('-' = 实时差异,非账单来源)
    channel      TEXT NOT NULL,
    kind         TEXT NOT NULL,                 -- missing_local|missing_channel|amount_mismatch|status_mismatch
    out_trade_no TEXT,
    txn_id       TEXT,
    detail_json  TEXT NOT NULL,                 -- 双边快照(排查用)
    resolved     INTEGER NOT NULL DEFAULT 0,    -- 超管处理后置 1
    created_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_diff_uniq
    ON recon_diff(channel, COALESCE(out_trade_no,''), COALESCE(txn_id,''), kind);
  CREATE INDEX IF NOT EXISTS idx_recon_diff_open ON recon_diff(resolved, created_at);

  -- 对账执行记录(账单 T+1 未生成时顺延重试的幂等标记)。
  CREATE TABLE IF NOT EXISTS recon_run (
    bill_date TEXT NOT NULL,
    channel   TEXT NOT NULL,
    status    TEXT NOT NULL,                    -- ok | bill_not_ready | error
    detail    TEXT,
    ran_at    INTEGER NOT NULL,
    PRIMARY KEY (bill_date, channel)
  );
`);

// 退款追回幂等双保险(决策10):镜像 grant 的部分唯一索引 —— 同一订单第二次 refund 写入被 UNIQUE 拦。
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_order_refund ON credit_ledger(order_id) WHERE kind='refund' AND order_id IS NOT NULL;`,
);

// ── invoice 一票多单迁移(外部声音 #3/#4)──
// 老库 invoice 是「一票一单」(order_id TEXT NOT NULL)。SQLite 改不了列约束 → 表重建:
//   ① 老数据按 (id,order_id) 回填 invoice_order ② 建无 order_id 的新表拷数据 ③ drop 老表 rename。
// 幂等:只在检测到老 order_id 列时执行;新库上面 CREATE 已是新形态,跳过。
{
  const cols = db.prepare(`PRAGMA table_info(invoice)`).all() as { name: string }[];
  const hasLegacyOrderId = cols.some((c) => c.name === 'order_id');
  if (hasLegacyOrderId) {
    db.transaction(() => {
      // ① 回填关联表(老的一票一单 → 一行关联)。INSERT OR IGNORE 防 UNIQUE 撞(理论不会)。
      db.exec(
        `INSERT OR IGNORE INTO invoice_order (invoice_id, order_id)
         SELECT id, order_id FROM invoice WHERE order_id IS NOT NULL;`,
      );
      // ② 建无 order_id 的新表 + 拷数据(列对齐,排除 order_id)。
      db.exec(`
        CREATE TABLE invoice_new (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT NOT NULL,
          title TEXT NOT NULL, tax_no TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '普票',
          amount_yuan INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'requested',
          invoice_no TEXT, pdf_key TEXT, admin_note TEXT, created_at INTEGER NOT NULL, issued_at INTEGER
        );
        INSERT INTO invoice_new (id,tenant_id,created_by,title,tax_no,kind,amount_yuan,status,invoice_no,pdf_key,admin_note,created_at,issued_at)
          SELECT id,tenant_id,created_by,title,tax_no,kind,amount_yuan,status,invoice_no,pdf_key,admin_note,created_at,issued_at FROM invoice;
        DROP TABLE invoice;
        ALTER TABLE invoice_new RENAME TO invoice;
        CREATE INDEX IF NOT EXISTS idx_invoice_tenant_creator ON invoice(tenant_id, created_by);
        CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoice(status);
      `);
    })();
  }
}

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
  tenantName?: string | null; // 租户名(listLeads JOIN tenant 派生;运营跟进要知道是谁的机构)
  userName?: string | null; // 发起人名(JOIN user 派生;display_name 优先)
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid_claimed'
  | 'credited'
  | 'rejected'
  | 'cancelled'
  | 'refunding' // 在线支付退款中(超管发起,通道确认前;失败回退 credited)
  | 'refunded'; // 已退款终态(ledger 追回,余额可负)

export type PaymentChannel = 'wechat' | 'alipay';
export type PaymentScene = 'native' | 'h5' | 'page' | 'wap';
export type PaymentAttemptStatus =
  | 'pending'
  | 'paid'
  | 'closed'
  | 'expired'
  | 'refunding'
  | 'refunded'
  | 'refund_failed';

export interface PaymentAttemptRow {
  id: string; // 32 hex = 通道 out_trade_no
  order_id: string;
  tenant_id: string;
  channel: PaymentChannel;
  scene: PaymentScene;
  amount_fen: number;
  status: PaymentAttemptStatus;
  code_url: string | null;
  txn_id: string | null;
  paid_at: number | null;
  refund_no: string | null;
  refund_at: number | null;
  fail_reason: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface PaymentChannelSettingRow {
  channel: PaymentChannel;
  enabled_scenes: string; // JSON 数组
  config_json: string;
  secret_cipher: Buffer | null;
  secret_iv: Buffer | null;
  secret_tag: Buffer | null;
  secret_key_version: number | null;
  updated_at: number | null;
}

export type ReconDiffKind =
  | 'missing_local'
  | 'missing_channel'
  | 'amount_mismatch'
  | 'status_mismatch';

export interface ReconDiffRow {
  id: string;
  bill_date: string;
  channel: PaymentChannel;
  kind: ReconDiffKind;
  out_trade_no: string | null;
  txn_id: string | null;
  detail_json: string;
  resolved: number;
  created_at: number;
}

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
  payment_method: string; // offline_bank | wechat | alipay
  credited_attempt_id: string | null; // 入账流水 id(在线支付入账时写;退款按它原路退)
  receipt_key: string | null;
  admin_note: string | null;
  confirmed_by: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
  actorName?: string | null; // 发起人名(listOrdersForActor JOIN user 派生;非表列。admin 看全机构时显谁下的单)
  invoiceStatus?: string | null; // 开票状态(JOIN invoice_order+invoice 派生;NULL=未开/requested=开票中/issued=已开)
  tenantName?: string | null; // 租户名(admin 视图 JOIN tenant 派生;非表列)
  invoiceId?: string | null; // 关联发票 id(admin 视图 JOIN 派生;抽屉开票/驳回用)
  invoiceNo?: string | null; // 发票号(已开票时 JOIN 派生)
}

export type InvoiceStatus = 'requested' | 'issued';

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  created_by: string; // 发起的租户 admin(迁移行可能是老 creator,仅展示)
  title: string;
  tax_no: string;
  kind: string;
  amount_yuan: number; // = 所含订单金额之和
  status: InvoiceStatus;
  invoice_no: string | null;
  pdf_key: string | null;
  admin_note: string | null;
  created_at: number;
  issued_at: number | null;
  orderIds?: string[]; // 所含订单(JOIN invoice_order 派生;非表列)
  orderNos?: string[]; // 所含订单展示号(派生)
}

export interface TenantInvoiceProfileRow {
  tenant_id: string;
  title: string | null;
  tax_no: string | null;
  bank_name: string | null;
  bank_account: string | null;
  address: string | null;
  phone: string | null;
  updated_at: number | null;
  updated_by: string | null;
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
  error: string | null; // 用户可读中文失败原因(markFailed 翻译;前端 + admin 概要展示)
  error_detail: string | null; // 原始技术日志(厂商 code/RequestId;仅 admin 详情排障)
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
  password_hash: string; // bcrypt;哨兵 '' = 未设密码(手机号自助注册用户,Fork1)
  phone: string | null; // 登录手机号(全局唯一 where not null);老用户为 null
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

// refund:在线支付退款追回(负数);显式排除出消耗统计(usageSummary/consumed 只认
// reserve/settle/release),只影响 balance 与 refunded 汇总。写入仅经 credits.refundClawback。
export type LedgerKind = 'grant' | 'reserve' | 'settle' | 'release' | 'refund';

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

// system:无请求上下文的系统动作(支付回调入账/退款确认,决策30 —— 线上入账不从审计轨迹消失)。
export type ActorType = 'user' | 'platform_admin' | 'system';

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

