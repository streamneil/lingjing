// 灵镜 积分服务 — grant / reserve / settle / release + 余额 + 计价。
//
// 决策来源:/plan-eng-review D17 —— 按文案字数估算计价(提交时算准,reserve=settle);
// 设计文档积分语义:提交 reserve、成功 settle、失败 release,失败不扣。
//
// 余额模型:credit_ledger 是 append-only 流水,余额 = SUM(amount)。
//   grant:  +N   (后台发放)
//   reserve: -N  (提交生成预扣 → 余额立即降,防并发超支)
//   settle:  ±差额(实扣 - 预扣;本期实扣=预扣,故差额=0,仅作账)
//   release: +N  (失败把预扣还回)

import { randomUUID } from 'node:crypto';
import { db, type LedgerKind, type LedgerRow } from '../db/index.js';

const now = () => Date.now();

// ── 计价:字数 × 单价 × 分辨率系数 ──
const PRICE_PER_CHAR = 0.05; // 每字 0.05 积分(可配置;占位值)
const RES_FACTOR: Record<string, number> = { '720P': 0.6, '1080P': 1, '4K': 2 };
const MIN_COST = 1;

/** 生成前费用预估(积分),与 reserve / settle 用同一函数,保证一致(验收第4条)。 */
export function estimateCost(scriptLength: number, resolution = '1080P'): number {
  const factor = RES_FACTOR[resolution] ?? 1;
  return Math.max(MIN_COST, Math.ceil(scriptLength * PRICE_PER_CHAR * factor));
}

function insert(
  tenantId: string,
  kind: LedgerKind,
  amount: number,
  jobId: string | null,
  note: string | null,
): void {
  db.prepare(
    `INSERT INTO credit_ledger (id,tenant_id,kind,amount,job_id,note,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(randomUUID(), tenantId, kind, amount, jobId, note, now());
}

/** 当前余额 = 所有流水之和。 */
export function balance(tenantId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS bal FROM credit_ledger WHERE tenant_id=?`)
    .get(tenantId) as { bal: number };
  return row.bal;
}

/** 后台发放(admin)。 */
export function grant(tenantId: string, amount: number, note = '后台发放'): void {
  if (amount <= 0) throw new Error('发放积分必须为正');
  insert(tenantId, 'grant', amount, null, note);
}

/**
 * 提交生成时预扣。原子事务:校验余额够 → 写 reserve。余额不足抛错(避免负余额)。
 * 决策:reserve 让余额立即下降,两个并发提交不会都通过(验收"用量预警"基础)。
 */
export const reserve = db.transaction((tenantId: string, jobId: string, cost: number): void => {
  if (cost <= 0) throw new Error('预扣金额必须为正');
  if (balance(tenantId) < cost) {
    const err = new Error('积分余额不足');
    (err as any).code = 'INSUFFICIENT_CREDITS';
    throw err;
  }
  insert(tenantId, 'reserve', -cost, jobId, '生成预扣');
});

/** 成功结算:实扣 = 预扣(本期),差额 0,仅记一条 settle 作账。 */
export function settle(tenantId: string, jobId: string, actualCost: number): void {
  const reserved = reservedFor(jobId);
  const diff = reserved - actualCost; // 预扣多了要退,少了要补(本期 diff=0)
  insert(tenantId, 'settle', diff, jobId, `结算实扣 ${actualCost}`);
}

/** 失败释放:把该 job 的预扣全额还回。 */
export function release(tenantId: string, jobId: string): void {
  const reserved = reservedFor(jobId);
  if (reserved > 0) insert(tenantId, 'release', reserved, jobId, '生成失败释放');
}

/** 某 job 已预扣的绝对额(reserve 是负数,这里返回正值)。 */
function reservedFor(jobId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS s FROM credit_ledger WHERE job_id=? AND kind='reserve'`,
    )
    .get(jobId) as { s: number };
  return -row.s;
}

/** 消费记录(可查询/导出,验收第H3)。 */
export function ledger(tenantId: string, limit = 100): LedgerRow[] {
  return db
    .prepare(`SELECT * FROM credit_ledger WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, limit) as LedgerRow[];
}
