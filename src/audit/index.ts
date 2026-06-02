// 灵镜 审计 — 操作日志(政企合规硬门票,/plan-eng-review §I3 + 外部声音#5)。
//
// 记录:谁(user)、何时、做了什么(action)、对什么(target)、从哪(ip)。
// 关键操作(登录/发起生成/发放积分/成员变更)都写一条。append-only,不可改。

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { db, type AuditRow } from '../db/index.js';

function clientIp(req: Request): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string') return xf.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? null;
}

/** 从已鉴权请求写一条审计(req.user 必须存在)。 */
export function audit(req: Request, action: string, target?: string): void {
  writeAudit(req.user?.tenantId ?? 'unknown', req.user?.id ?? null, action, target ?? null, clientIp(req));
}

/** 低层写入(登录场景 req.user 还没挂,直接传 tenant/user)。 */
export function writeAudit(
  tenantId: string,
  userId: string | null,
  action: string,
  target: string | null,
  ip: string | null,
): void {
  db.prepare(
    `INSERT INTO audit_log (id,tenant_id,user_id,action,target,ip,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(randomUUID(), tenantId, userId, action, target, ip, Date.now());
}

/** 查审计(admin 可见)。 */
export function listAudit(tenantId: string, limit = 200): AuditRow[] {
  return db
    .prepare(`SELECT * FROM audit_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, limit) as AuditRow[];
}
