// 灵镜 在线支付 — 每日对账(零静默失败最后防线,D4.3 + 决策19/25)。
//
// ┌─ 对账口径 ────────────────────────────────────────────────────────────────┐
// │ 通道账单(T+1)⟷ 本地 payment_attempt,按 out_trade_no 逐笔对平:            │
// │   账单有、本地无该单号          → missing_local(最严重:收了钱不知道)      │
// │   账单「支付成功」、本地未入账态 → status_mismatch(漏回调且 sweep 也没兜住)│
// │   金额不符                      → amount_mismatch                            │
// │   本地已收款、账单没有          → missing_channel(单边账,极罕见)          │
// │ 差异 INSERT OR IGNORE(唯一索引)→ 重跑幂等不刷屏;落表即 error 日志。       │
// │ 告警面 v1 = 超管差异面板 + error 日志(设计定稿的显式取舍)。                │
// └────────────────────────────────────────────────────────────────────────────┘
// 调度:server 每小时 reconTick() —— 昨日未对平(或账单未生成)的 (日期,通道) 重试;
// recon_run 表做幂等标记。runReconFor(date) 供测试直接驱动(时钟无关)。

import { db, type PaymentChannel } from '../db/index.js';
import { BillNotReadyError, CHANNELS, getProvider, recordReconDiff, type BillRow } from './index.js';

interface LocalAttempt {
  id: string;
  txn_id: string | null;
  amount_fen: number;
  status: string;
  paid_at: number | null;
}

/** 'yyyy-mm-dd'(北京时间;账单按 GMT+8 日切)。 */
export function cstDateString(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 北京时间某日 [0点, 次日0点) 的 ms 区间。 */
function cstDayRange(billDate: string): { start: number; end: number } {
  const start = Date.parse(`${billDate}T00:00:00+08:00`);
  return { start, end: start + 86_400_000 };
}

function markRun(billDate: string, channel: PaymentChannel, status: string, detail?: string): void {
  db.prepare(
    `INSERT INTO recon_run (bill_date, channel, status, detail, ran_at) VALUES (?,?,?,?,?)
     ON CONFLICT(bill_date, channel) DO UPDATE SET status=excluded.status, detail=excluded.detail, ran_at=excluded.ran_at`,
  ).run(billDate, channel, status, detail ?? null, Date.now());
}

function runDone(billDate: string, channel: PaymentChannel): boolean {
  const row = db
    .prepare(`SELECT status FROM recon_run WHERE bill_date=? AND channel=?`)
    .get(billDate, channel) as { status: string } | undefined;
  return row?.status === 'ok';
}

/** 对单个 (日期, 通道) 执行对账。返回差异数;账单未生成返回 null(顺延重试)。 */
export async function reconcileChannel(billDate: string, channel: PaymentChannel): Promise<number | null> {
  const provider = getProvider(channel);
  if (!provider) return 0; // 通道未配置:无账单可对,视为完成(markRun 由调用方决定)
  let bill: BillRow[];
  try {
    bill = await provider.downloadBill(billDate);
  } catch (e) {
    if (e instanceof BillNotReadyError) {
      markRun(billDate, channel, 'bill_not_ready');
      console.log(`[对账] ${channel} ${billDate} 账单未生成,顺延重试`);
      return null;
    }
    markRun(billDate, channel, 'error', e instanceof Error ? e.message.slice(0, 300) : String(e));
    throw e;
  }

  const { start, end } = cstDayRange(billDate);
  // 本地口径:当日收款(paid_at 落在账单日)∪ 当日创建仍在途的尝试(迟到差异下轮自愈)。
  const locals = db
    .prepare(
      `SELECT id, txn_id, amount_fen, status, paid_at FROM payment_attempt
        WHERE channel=? AND ((paid_at IS NOT NULL AND paid_at>=? AND paid_at<?) OR (created_at>=? AND created_at<?))`,
    )
    .all(channel, start, end, start, end) as LocalAttempt[];
  const localById = new Map(locals.map((l) => [l.id, l]));
  const PAID_LIKE = new Set(['paid', 'refunding', 'refunded', 'refund_failed']);

  let diffs = 0;
  const seenInBill = new Set<string>();
  // 跨日创建单的补查语句:循环外 prepare 一次(账单可能上万行,循环内 prepare 是纯浪费)。
  const lookupStmt = db.prepare(
    `SELECT id, txn_id, amount_fen, status, paid_at FROM payment_attempt WHERE id=? AND channel=?`,
  );
  for (const row of bill) {
    seenInBill.add(row.outTradeNo);
    const local =
      localById.get(row.outTradeNo) ??
      (lookupStmt.get(row.outTradeNo, channel) as LocalAttempt | undefined);
    if (!local) {
      recordReconDiff({
        channel, kind: 'missing_local', outTradeNo: row.outTradeNo, txnId: row.txnId, billDate,
        detail: { billAmountFen: row.amountFen, billStatus: row.status },
      });
      diffs++;
      continue;
    }
    // 账单显示已退款、本地却还是「已收款/已入账」→ 多为运营在商户后台手工退款(钱退了积分没扣)。
    // 这是对账的必查项:不查则永远无人发现(评审 MEDIUM-HIGH)。
    if (row.status === 'refunded' && (local.status === 'paid' || local.status === 'refund_failed')) {
      recordReconDiff({
        channel, kind: 'status_mismatch', outTradeNo: row.outTradeNo, txnId: row.txnId, billDate,
        detail: { billStatus: 'refunded', localStatus: local.status, reason: 'channel_refunded_local_not_clawed_back' },
      });
      diffs++;
      continue;
    }
    if (row.status === 'paid') {
      if (!PAID_LIKE.has(local.status)) {
        recordReconDiff({
          channel, kind: 'status_mismatch', outTradeNo: row.outTradeNo, txnId: row.txnId, billDate,
          detail: { billStatus: 'paid', localStatus: local.status, reason: 'channel_paid_local_not_credited' },
        });
        diffs++;
      } else if (row.amountFen !== local.amount_fen) {
        recordReconDiff({
          channel, kind: 'amount_mismatch', outTradeNo: row.outTradeNo, txnId: row.txnId, billDate,
          detail: { billAmountFen: row.amountFen, localAmountFen: local.amount_fen },
        });
        diffs++;
      }
    }
  }
  // 单边账:本地当日已收款、账单里没有(通道侧无此钱)。
  for (const l of locals) {
    if (!PAID_LIKE.has(l.status)) continue;
    if (l.paid_at === null || l.paid_at < start || l.paid_at >= end) continue;
    if (seenInBill.has(l.id)) continue;
    recordReconDiff({
      channel, kind: 'missing_channel', outTradeNo: l.id, txnId: l.txn_id, billDate,
      detail: { localAmountFen: l.amount_fen, localStatus: l.status },
    });
    diffs++;
  }
  markRun(billDate, channel, 'ok', `diffs=${diffs} bill_rows=${bill.length}`);
  console.log(`[对账] ${channel} ${billDate} 完成:账单 ${bill.length} 笔,差异 ${diffs}`);
  return diffs;
}

/** 对某账单日全通道对账(测试直接驱动)。 */
export async function runReconFor(billDate: string): Promise<void> {
  for (const channel of CHANNELS) {
    if (runDone(billDate, channel)) continue;
    if (!getProvider(channel)) continue; // 未配置通道不产生 run 记录(配置后可补跑)
    try {
      await reconcileChannel(billDate, channel);
    } catch (e) {
      console.error(`[对账] ${channel} ${billDate} 失败(下轮重试):`, e instanceof Error ? e.message : e);
    }
  }
}

/** 回溯窗口:宕机/持续报错跨过北京时间午夜时,只对「昨日」会永久漏掉那一天的账单(零静默失败的洞)。
 *  每 tick 补扫最近 7 天里所有没有 ok 记录的账单日(runDone 幂等,已对平的日子零成本跳过)。 */
const RECON_LOOKBACK_DAYS = 7;

export async function reconTick(nowMs: number = Date.now()): Promise<void> {
  for (let d = 1; d <= RECON_LOOKBACK_DAYS; d++) {
    await runReconFor(cstDateString(nowMs - d * 86_400_000));
  }
}

/** 超管差异面板数据。 */
export function listReconDiffs(opts: { resolved?: boolean; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 100, 500);
  return db
    .prepare(
      `SELECT * FROM recon_diff WHERE resolved=? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(opts.resolved ? 1 : 0, limit);
}

export function resolveReconDiff(id: string): boolean {
  return db.prepare(`UPDATE recon_diff SET resolved=1 WHERE id=? AND resolved=0`).run(id).changes === 1;
}

export function openReconDiffCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM recon_diff WHERE resolved=0`).get() as { n: number }).n;
}
