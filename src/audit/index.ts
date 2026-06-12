// 灵镜 审计 — 操作日志(政企合规硬门票,/plan-eng-review §I3 + 外部声音#5)。
//
// 记录:谁(user)、何时、做了什么(action)、对什么(target)、从哪(ip)。
// 关键操作(登录/发起生成/发放积分/成员变更)都写一条。append-only,不可改。

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { db, type AuditRow, type ActorType } from '../db/index.js';

// 平台级审计的虚拟租户 id:超管自身操作(非针对具体租户的,如登录)记在此,
// 与任何真实租户的 audit_log 视图隔离,供平台级审计追溯(/plan-ceo-review C1/E3)。
export const PLATFORM_TENANT = '__platform__';

function clientIp(req: Request): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string') return xf.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? null;
}

/** 从已鉴权请求写一条租户审计(req.user 必须存在)。 */
/** detail:字段级变更详情(T-SETTINGS-AUDIT-DIFF)。设置变更类操作传 [{field,old,new}],其余省略。 */
export function audit(
  req: Request,
  action: string,
  target?: string,
  detail?: AuditDetail,
): void {
  writeAudit(req.user?.tenantId ?? 'unknown', req.user?.id ?? null, action, target ?? null, clientIp(req), 'user', detail);
}

export type AuditDetail = { field: string; old: string; new: string }[];

/** 低层写入(登录场景 req.user 还没挂,直接传 tenant/user)。actorType 默认 user。
 *  超管操作传 actorType='platform_admin' + actorId=platform_admin.id;
 *  跨租户操作的 tenantId 记目标租户,租户 admin 能在自己审计看到"平台 X 操作"。
 *  detail:字段级变更 JSON([{field,old,new}]);只设置变更类操作写,其余 null。 */
export function writeAudit(
  tenantId: string,
  userId: string | null,
  action: string,
  target: string | null,
  ip: string | null,
  actorType: ActorType = 'user',
  detail?: AuditDetail,
): void {
  db.prepare(
    `INSERT INTO audit_log (id,tenant_id,user_id,actor_type,action,target,ip,detail,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), tenantId, userId, actorType, action, target, ip, detail ? JSON.stringify(detail) : null, Date.now());
}

/** 平台超管操作审计(actor_type=platform_admin)。
 *  targetTenant:针对某租户的操作记目标租户(租户侧可见);纯平台操作记 PLATFORM_TENANT。 */
export function writePlatformAudit(
  padminId: string,
  action: string,
  targetTenant: string,
  target: string | null,
  ip: string | null,
): void {
  writeAudit(targetTenant, padminId, action, target, ip, 'platform_admin');
}

// 操作者名 JOIN:user_id 语义随 actor_type 变(user.id 或 platform_admin.id),
// 故两表都 LEFT JOIN,再 COALESCE 合成一列 actorName(与 credits.ledger() 的 userName 同套路)。
// 经 JOIN 派生,不冗余存 audit_log;user_id 空 / 用户已删 → actorName 空(前端回退「未知用户」)。
const ACTOR_NAME_SELECT = `COALESCE(uu.display_name, uu.username, pa.username) AS actorName`;
// 模块(工具类型):create_job 行的 target = jobId,JOIN job 取 jt.type 即得精确工具
// (video_i2v / ai_image / tts ...)。经 JOIN 派生,零写改动 + 自动覆盖历史老记录。
// 非 create_job 行 / job 已删 → module 空(前端显「—」)。
const MODULE_SELECT = `jt.type AS module`;
const ACTOR_NAME_JOIN = `
   LEFT JOIN user uu ON l.actor_type='user' AND l.user_id = uu.id
   LEFT JOIN platform_admin pa ON l.actor_type='platform_admin' AND l.user_id = pa.id
   LEFT JOIN job jt ON l.action='create_job' AND l.target = jt.id`;

/** 查租户审计(admin 可见)。带操作者名(actorName)+ 模块(module)。 */
export function listAudit(
  tenantId: string,
  limit = 200,
  actingUserId?: string,
  isAdmin = false,
  offset = 0,
): AuditRow[] {
  // 信任边界:租户审计**只显本租户用户操作**(actor_type='user')。
  //   平台超管(actor_type='platform_admin')的操作 —— 即使 target 是本租户(开户/充值/重置密码/
  //   订单确认/发票)—— 绝不出现在租户审计页:那是平台内部操作,泄露进租户审计既混淆「谁在管系统」
  //   又不安全。平台操作只在 /admin 的 listPlatformAudit 可见。
  //   租户对「平台给我充了多少积分」的知情权由「用量计费」明细(credit_ledger grant 行)承载,不丢信息。
  // 账号隔离:creator 只看自己的操作行;admin / 无 actingUserId(内部)→ 看全机构(仍限 user 行)。
  const scoped = !isAdmin && actingUserId !== undefined;
  const scopeClause = scoped ? ` AND l.user_id = ?` : '';
  const scopeParams = scoped ? [actingUserId] : [];
  return db
    .prepare(
      `SELECT l.*, ${ACTOR_NAME_SELECT}, ${MODULE_SELECT}
         FROM audit_log l${ACTOR_NAME_JOIN}
        WHERE l.tenant_id=? AND l.actor_type='user'${scopeClause}
        ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(tenantId, ...scopeParams, limit, offset) as AuditRow[];
}

/** 租户审计总条数(分页用;与 listAudit 同口径:仅 user 行 + 账号隔离)。 */
export function countAudit(tenantId: string, actingUserId?: string, isAdmin = false): number {
  const scoped = !isAdmin && actingUserId !== undefined;
  const scopeClause = scoped ? ` AND user_id = ?` : '';
  const scopeParams = scoped ? [actingUserId] : [];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id=? AND actor_type='user'${scopeClause}`,
    )
    .get(tenantId, ...scopeParams) as { n: number };
  return row.n;
}

/** 平台级审计:所有超管操作(跨所有目标租户 + 纯平台操作),供 /admin 追溯。带操作者名 + 模块。 */
export function listPlatformAudit(limit = 200): AuditRow[] {
  return db
    .prepare(
      `SELECT l.*, ${ACTOR_NAME_SELECT}, ${MODULE_SELECT}
         FROM audit_log l${ACTOR_NAME_JOIN}
        WHERE l.actor_type='platform_admin' ORDER BY l.created_at DESC LIMIT ?`,
    )
    .all(limit) as AuditRow[];
}
