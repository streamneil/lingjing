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
import { getImageModel } from '../gateway/image-models.js';
import { getVideoModel, klingModeToResolution } from '../gateway/video-models.js';

const now = () => Date.now();

// ── 计价:字数 × 单价 × 分辨率系数 ──
const PRICE_PER_CHAR = 0.05; // 每字 0.05 积分(可配置;占位值)
// 分辨率计价系数。480P 必须低于 720P,否则"更便宜"的选项反而更贵(eng-review D-E7)。
const RES_FACTOR: Record<string, number> = { '480P': 0.4, '720P': 0.6, '1080P': 1, '4K': 2 };
const MIN_COST = 1;

/** 数字人视频计价(字数 × 单价 × 分辨率系数)。reserve / settle 用同一函数,保证一致(验收第4条)。 */
export function estimateCost(scriptLength: number, resolution = '1080P'): number {
  const factor = RES_FACTOR[resolution] ?? 1;
  return Math.max(MIN_COST, Math.ceil(scriptLength * PRICE_PER_CHAR * factor));
}

// ── AI 图片计价:图数 × 单价 × 分辨率系数 ──
const PRICE_PER_IMAGE = 4; // 每张图 4 积分基价(占位值,可配置)
const IMG_RES_FACTOR: Record<string, number> = { '1K': 1, '2K': 1.5, '4K': 2.5 };

/** 把请求图数 clamp 到 [1, maxImages](默认 4)。model-aware(外部声音 P1):
 *  z-image 固定1、qwen-2.0 6;选超额张数会预扣多返少 → reserve≠settle 超扣。
 *  maxImages 缺省 4 保旧调用(无 model 字段的老 job/测试)兼容(C5b)。 */
export function clampImageCount(n: unknown, maxImages = 4): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 1;
  return Math.min(maxImages, Math.max(1, v));
}

/** AI 文生图费用预估:图数 × 单价 × 分辨率系数。priceTier 缺省回落 PRICE_PER_IMAGE(无 model 兼容)。
 *  外部声音 P2-a:priceTier **替代** PRICE_PER_IMAGE(非双乘)。 */
export function estimateImageCost(count: number, resolution = '1K', priceTier = PRICE_PER_IMAGE, maxImages = 4): number {
  const n = clampImageCount(count, maxImages);
  const factor = IMG_RES_FACTOR[resolution] ?? 1;
  return Math.max(MIN_COST, Math.ceil(n * priceTier * factor));
}

// AI 图生图(编辑)计价:张数 × 编辑单价 × 分辨率系数。
const PRICE_PER_EDIT = 6; // 图生图每次 6 积分基价(无 model 时的回落默认)
/** AI 图生图费用预估:count 张 × 单价 × 分辨率系数。priceTier 替代 PRICE_PER_EDIT(P2-a)。
 *  count 默认 1:千问编辑固定出 1 张,所有旧调用/测试逐字节不变;万相2.7(A_EDIT)按 n 张计价。 */
export function estimateImageEditCost(resolution = '1K', priceTier = PRICE_PER_EDIT, count = 1): number {
  const factor = IMG_RES_FACTOR[resolution] ?? 1;
  const n = Math.max(1, Math.floor(count));
  return Math.max(MIN_COST, Math.ceil(n * priceTier * factor));
}

// ── 文生视频(text2video)计价:秒 × 分辨率档 × 模型 tier,audio 加价 ──
// VIDEO_RES_FACTOR:1080P 真实成本约 720P 的 2×(同图片 480P<720P 必分档教训)。
const VIDEO_RES_FACTOR: Record<string, number> = { '720P': 1, '1080P': 2 };
// AUDIO_FACTOR:可灵有声视频加价(占位 1.3,上线前须填真实厂商有声加价)。
const AUDIO_FACTOR = 1.3;
/** 文生视频费用预估:ceil(duration × priceTier × resFactor)[× audioFactor]。
 *  duration/res/audio 由 buildVideoT2VJob 快照,costFor 读快照 → reserve==settle。
 *  可灵 mode 已在 build 时翻译成 resolution 档(R3),此函数不感知 std/pro。 */
export function estimateVideoCost(duration: number, priceTier: number, resolution = '720P', audio = false): number {
  const dur = Math.max(1, Math.floor(duration));
  const resFactor = VIDEO_RES_FACTOR[resolution] ?? 1;
  let cost = dur * priceTier * resFactor;
  if (audio) cost *= AUDIO_FACTOR;
  return Math.max(MIN_COST, Math.ceil(cost));
}

// 文转语音(TTS)计价:按字数(无分辨率维度)。
const TTS_PRICE_PER_CHAR = 0.02; // 每字 0.02 积分(配音比视频便宜,占位可配)
/** TTS 费用预估:按字数。 */
export function estimateTtsCost(textLength: number): number {
  return Math.max(MIN_COST, Math.ceil(textLength * TTS_PRICE_PER_CHAR));
}

/**
 * 按工具类型计价(多工具统一入口)。reserve / settle / estimate 全走这里,保证一致。
 * 决策来源:/plan-ceo-review A2 —— 每工具一个计价分支,不拷贝计价逻辑。
 */
export function costFor(toolType: string, input: Record<string, unknown>): number {
  switch (toolType) {
    case 'video':
      return estimateCost(
        typeof input.script === 'string' ? input.script.length : 0,
        typeof input.resolution === 'string' ? input.resolution : undefined,
      );
    case 'ai_image': {
      // mode 感知 + model-aware(外部声音 P1/P2):priceTier 替代基价,maxImages 限张数。
      const resolution = typeof input.resolution === 'string' ? input.resolution : undefined;
      const mode = input.mode === 'img2img' ? 'img2img' : 'text2img';
      const def = getImageModel(typeof input.model === 'string' ? input.model : undefined, mode);
      // P3:优先读提交时快照(admin 改价 mid-flight 不破 reserve==settle);无快照(老 job)回落实时。
      const priceTier = typeof input.priceTierSnapshot === 'number' ? input.priceTierSnapshot : def.priceTier;
      const maxImages = typeof input.maxImagesSnapshot === 'number' ? input.maxImagesSnapshot : def.maxImages;
      if (mode === 'img2img') {
        // 编辑按 n 张计价:count clamp 到 maxImages(万相2.7 异步 + 千问2.0 Pro 同步都支持多出;
        // qwen-image-edit maxImages=1 → 自然固定 1)。读快照保 reserve==settle。
        const editCount = clampImageCount(input.count, maxImages);
        return estimateImageEditCost(resolution, priceTier, editCount);
      }
      return estimateImageCost(
        typeof input.count === 'number' ? input.count : 1,
        resolution,
        priceTier,
        maxImages,
      );
    }
    case 'video_edit': {
      // 视频编辑:计费秒快照 = 输入 + 预计输出(贴厂商 usage.duration=in+out,CEO D3)。
      // 快照在 buildVideoEditJob 写入(时长源自 sidecar 服务端真相);无快照视为坏数据,按 0 秒拒绝出价。
      const def = getVideoModel(typeof input.model === 'string' ? input.model : undefined);
      const priceTier = typeof input.priceTierSnapshot === 'number' ? input.priceTierSnapshot : def.priceTier;
      const billable = typeof input.billableSecondsSnapshot === 'number' ? input.billableSecondsSnapshot : 0;
      const resolution = typeof input.resSnapshot === 'string'
        ? input.resSnapshot
        : (typeof input.resolution === 'string' ? input.resolution : '720P');
      return estimateVideoCost(billable, priceTier, resolution, false);
    }
    case 'video_t2v':
    case 'video_i2v': {
      // 文生视频 / 图转影片:同计价(秒×档×tier;i2v audio 恒 false)。读快照(reserve==settle);
      // 无快照(老 job)回落实时派生(同 build 规则,R5.1 DRY)。
      const def = getVideoModel(typeof input.model === 'string' ? input.model : undefined);
      const priceTier = typeof input.priceTierSnapshot === 'number' ? input.priceTierSnapshot : def.priceTier;
      const duration = typeof input.durationSnapshot === 'number'
        ? input.durationSnapshot
        : (typeof input.duration === 'number' ? input.duration : def.defaultDuration);
      // res 档:快照优先;无则派生(可灵 mode→档,V_DASH 用 resolution)。
      let resolution = typeof input.resSnapshot === 'string' ? input.resSnapshot : undefined;
      if (!resolution) {
        resolution = def.shape === 'V_KLING'
          ? klingModeToResolution(typeof input.mode === 'string' ? input.mode : undefined)
          : (typeof input.resolution === 'string' ? input.resolution : '720P');
      }
      // audio:快照优先;无则派生(仅可灵生效,R6)。
      const audio = typeof input.audioSnapshot === 'boolean'
        ? input.audioSnapshot
        : (def.supportsAudio ? !!input.audio : false);
      return estimateVideoCost(duration, priceTier, resolution, audio);
    }
    case 'tts':
      return estimateTtsCost(typeof input.text === 'string' ? input.text.length : 0);
    default:
      throw new Error(`未知工具类型,无法计价:${toolType}`);
  }
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

/** 失败释放:把该 job **尚未释放/结算**的预扣还回。
 *  幂等:用净未结清额计算,重复调用(失败→重试→再失败)不会重复退款。 */
export const release = db.transaction((tenantId: string, jobId: string): void => {
  const outstanding = outstandingReserved(jobId);
  if (outstanding > 0) insert(tenantId, 'release', outstanding, jobId, '生成失败释放');
});

/** 某 job 已预扣的绝对额(reserve 是负数,这里返回正值)。 */
function reservedFor(jobId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS s FROM credit_ledger WHERE job_id=? AND kind='reserve'`,
    )
    .get(jobId) as { s: number };
  return -row.s;
}

/** 某 job 当前**尚未结清**的预扣额,用于 release 幂等。
 *  规则:
 *   - 已 settle(成功结算)→ 预扣已被消费,无可释放(返回 0)。
 *   - 未 settle → 可释放 = 预扣总额 - 已 release。重复 release 时该值降到 0,不再退。
 *  这样 release 多次调用、或对已成功任务误调,都不会重复退款(积分凭空增加)。 */
function outstandingReserved(jobId: string): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind='reserve' THEN -amount ELSE 0 END),0) AS reserved,
         COALESCE(SUM(CASE WHEN kind='release' THEN amount ELSE 0 END),0) AS released,
         COALESCE(SUM(CASE WHEN kind='settle'  THEN 1 ELSE 0 END),0)      AS settleCount
       FROM credit_ledger WHERE job_id=?`,
    )
    .get(jobId) as { reserved: number; released: number; settleCount: number };
  if (row.settleCount > 0) return 0; // 已结算,预扣已消费,不可再释放
  return row.reserved - row.released; // 未结算:剩余可释放额(重复 release 自然降到 0)
}

/** 消费记录(可查询/导出,验收第H3)。 */
export function ledger(tenantId: string, limit = 100): LedgerRow[] {
  return db
    .prepare(`SELECT * FROM credit_ledger WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(tenantId, limit) as LedgerRow[];
}
