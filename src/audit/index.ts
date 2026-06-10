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

/** 查租户审计(admin 可见)。 */
export function listAudit(tenantId: string, limit = 200): AuditRow[] {
  return db
    .prepare(`SELECT * FROM audit_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, limit) as AuditRow[];
}

/** 平台级审计:所有超管操作(跨所有目标租户 + 纯平台操作),供 /admin 追溯。 */
export function listPlatformAudit(limit = 200): AuditRow[] {
  return db
    .prepare(`SELECT * FROM audit_log WHERE actor_type='platform_admin' ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as AuditRow[];
}
