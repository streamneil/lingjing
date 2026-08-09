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
import { getImageModel, imagePixelWH } from '../gateway/image-models.js';
import { getVideoModel, klingModeToResolution } from '../gateway/video-models.js';
import { sellPrice, getConfig, markupX35, lookupCost, variantId } from './pricing.js';
import type { ImageUsage } from '../gateway/types.js';

const now = () => Date.now();

const MIN_COST = 1;

// ── 数字人(wan2.2-s2v)计价:按生成视频「秒数 × 每秒售价」,与全站视频同口径 ──
// 此前按「字数 × 0.05 × 分辨率系数」扁平估算,严重低估:65字/720P 仅 2 积分,
// 而 wan2.2-s2v 真实按输出秒数计费(480P 0.5元/秒、720P 0.9元/秒),漏收 ~200 倍。
// 修正为「估算秒数 × 每秒售价(真实元/秒 × 全局倍率)」,与 estimateVideoCost 一致。
//
// 秒数估算:中文播报约 5 字/秒(与 pipeline/segment.ts 同口径);语速 speed 快则同样字数更短。
//   seconds ≈ ⌈script.length / (5 × speed)⌉。worker settle 读同一 input 再算 → reserve==settle。
// s2v 无 model 字段(固定百炼),每秒真实成本(元/秒)直接登记于此,售价 = 成本 × markupX35()。
const AVATAR_CHARS_PER_SECOND = 5; // 中文播报速率(字/秒,rate=1)
const S2V_COST_YUAN_PER_SECOND: Record<string, number> = { '480P': 0.5, '720P': 0.9 }; // 百炼官方单价

/** 数字人视频计价:估算秒数 × 每秒售价(真实元/秒 × 全局倍率)。
 *  reserve(buildVideoJob)/ settle(worker.runVideoJob)用同一函数同一入参,保证一致(reserve==settle)。 */
export function estimateCost(scriptLength: number, resolution = '720P', speed = 1): number {
  if (!(scriptLength > 0)) return MIN_COST; // 空脚本不生成视频 → 下限(否则 max(1,秒)会凭空收 1 秒)
  const cps = AVATAR_CHARS_PER_SECOND * (speed > 0 ? speed : 1); // 语速快 → 每秒读更多字 → 秒数减
  const seconds = Math.max(1, Math.ceil(scriptLength / cps));
  const costPerSec = S2V_COST_YUAN_PER_SECOND[resolution] ?? S2V_COST_YUAN_PER_SECOND['720P']!;
  const perSecTier = sellPrice(costPerSec); // 售价积分/秒 = ⌈真实元/秒 × markupX35⌉(后台改倍率随之变)
  return Math.max(MIN_COST, Math.ceil(seconds * perSecTier));
}

// ── AI 图片计价:图数 × 单价(分辨率价差已编码进 priceTier,系数恒 1) ──
// 分档计价(2026-07,eng-review D1/D8):Gemini 等模型官方价随清晰度变
// (Flash 512/1K/2K/4K=$0.045/0.067/0.101/0.151;Pro 1K-2K/4K=$0.134/0.24)。
// 与视频侧同构:priceTier 已是「该(模型,清晰度档)组合的每张售价积分」,由 imagePriceTier
// 按 model_pricing 变体行(id="{key}:{档}")选好,∴ IMG_RES_FACTOR 全取 1(不再二次上浮)。
// 百炼系模型官方「费用与分辨率无关」→ 无变体行,自然回落基础价,行为不变。
const PRICE_PER_IMAGE = 4; // 每张图 4 积分基价(无 model 时回落默认 ≈ z-image 关改写档)
const IMG_RES_FACTOR: Record<string, number> = { '1K': 1, '2K': 1, '4K': 1 };

/** 取(图片模型,清晰度档)每张售价积分(2026-07 分档计价,与 videoPriceTier 同构)。
 *  两级链:① model_pricing 变体行 "{key}:{档}"(enabled)→ sellPrice(接全局倍率);
 *         ② def.priceTier —— mergeDef 已保证 = 基础行售价(D8 修脱钩),无行才是代码常量。
 *  resolution 为空 → 直接 ②(绝不拼 "key:undefined" 查库);disabled 变体档在
 *  resolutionAllowed 层已拒(D5 下架语义),此处 enabled 判断只是双保险(老 job 回落时命中)。 */
export function imagePriceTier(def: Pick<ReturnType<typeof getImageModel>, 'key' | 'priceTier'>, resolution?: string): number {
  if (resolution) {
    const mp = lookupCost(variantId(def.key, resolution));
    if (mp && mp.enabled) return sellPrice(mp.realCostYuan);
  }
  return def.priceTier;
}

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

// ── token 计价模型(gpt-image-2,Design B 真实用量结算)──
// gpt-image-2 按 output image token 计费($30/1M);官方只在 1K 标准尺寸有确价,2K/4K/任意分辨率无公布单价,
// 只能按响应 usage.output_tokens 实结。故 reserve 阶段用「像素×画质」上界估算(宁高勿低,可退),
// settle 阶段用 worker 回写的真实 usage(封顶 reserved,只退不补)。
//
// 每档画质 output token / 百万像素(MP)上界系数:
//   锚 = 官方 1024²(≈1.05MP)output token ≈ low 200 / medium 1767 / high 7033(每张美元价 ÷ $30×1M)。
//   取 ~1.15× 安全上界:low 250 / medium 2050 / high 8100 tok/MP。首日按真实 usage 收敛。
const IMG_TOKEN_PER_MP: Record<string, number> = { low: 250, medium: 2050, high: 8100 };

// 三类 token 费率($/1M):output 图 $30、input 图 $8(编辑输入底图,高保真)、input 文本 $5(prompt)。
// 按 output 费率折算(output-equivalent):input 图 token ×(8/30)、input 文本 token ×(5/30)。
// 这样只存一个 output token 费率(priceRate),input 费率随之同比缩放(管理员改价三类同步)。
const IN_IMG_RATIO = 8 / 30; // 输入图 token → output-equivalent
const IN_TXT_RATIO = 5 / 30; // 输入文本 token → output-equivalent
// reserve 估算:每张高保真输入底图 token 上界(宁高勿低,settle 按实 usage 退差)。gpt-image-2 输入恒高保真。
const INPUT_IMAGE_TOKENS_UPPER = 4000;

/** token 计价可计费量(output-equivalent):output + 输入图×(8/30) + 输入文本×(5/30)。
 *  各类 token 按 OpenAI 费率折成 output 当量,再统一乘 output 费率结算,商业自负盈亏(不漏输入底图成本)。
 *  input 明细(input_tokens_details)缺失时按 mode 兜底:编辑输入按图算(贵,recover),文生图按文本算。 */
function usageBillableTokens(usage: ImageUsage, mode: string): number {
  let imgTok = usage.inputImageTokens;
  let txtTok = usage.inputTextTokens;
  if (imgTok == null && txtTok == null) {
    if (mode === 'img2img') { imgTok = usage.inputTokens; txtTok = 0; }
    else { txtTok = usage.inputTokens; imgTok = 0; }
  }
  return usage.outputTokens + (imgTok ?? 0) * IN_IMG_RATIO + (txtTok ?? 0) * IN_TXT_RATIO;
}

/** gpt-image-2 reserve 估算:按(画质, 像素)取 output token 上界(宁高勿低,settle 按实退差)。 */
export function estImageOutputTokens(quality: string | undefined, width: number, height: number): number {
  const perMp = IMG_TOKEN_PER_MP[quality ?? 'high'] ?? IMG_TOKEN_PER_MP.high!;
  const mp = (width * height) / 1_000_000;
  return Math.max(1, Math.ceil(mp * perMp));
}

/** token 计价模型每 output token 的真实成本元:快照优先(reserve==settle)→ model_pricing(仅 token 单位)→ 代码回落。
 *  ⚠ 只认 unit='token' 的行:admin 若经「每张」定价表误填 ¥/张(如 0.029)会被当 ¥/token 读,
 *    134× 灌爆价(9:16 4K medium 17004 token × 0.029 × 35 = 17260 积分,QA 实测)。故辨识单位,
 *    非 token 单位 → 回落代码常量 def.priceRate(= $30/1M×7.2),防误配赔穿/坑用户。 */
export function imageTokenRate(def: { key: string; priceRate?: number }, snapshot?: number): number {
  if (typeof snapshot === 'number' && snapshot > 0) return snapshot;
  const mp = lookupCost(def.key);
  if (mp && mp.unit === 'token' && mp.realCostYuan > 0) return mp.realCostYuan; // 仅 token 单位的行才是合法 token 费率
  return def.priceRate ?? 0; // 无 token 行 / 误填 ¥/张 → 代码常量兜底
}

/** token 计价每次出图售价积分 = sellPrice(output_tokens × 每 token 成本元)。 */
function imageTokenCredits(outputTokens: number, rate: number): number {
  return sellPrice(outputTokens * rate); // rate/tokens ≤0 → sellPrice 抛错(misconfig,assertProfitable 应已拦)
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

// ── 文生视频(text2video)计价:秒 × priceTier(每秒售价积分)──
// 价格对齐(2026-06):各模型 1080P/720P 真实比值不同(大师1.67、HappyHorse1.78、可灵无声1.33),
// 单个全局 resFactor 装不下 → 改为「priceTier 已是该(模型,分辨率,有声)组合的每秒售价积分」,
// 由 deriveVideoT2VParams 按 resolution+audio 选好后快照(reserve==settle)。
// ∴ 此处 resFactor / audioFactor 全取 1(价格已在 priceTier 里编码完毕)。
const VIDEO_RES_FACTOR: Record<string, number> = { '480P': 1, '720P': 1, '1080P': 1 };
const AUDIO_FACTOR = 1; // 有声加价已并入 priceTier(可灵有声单价单列);此处不再乘
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

// 视频后台改价:统一定价表 model_pricing 按 "{key}:{variant}" 存真实成本/秒;查到→sellPrice 算售价。
// 2026-06 收口:从 video_model_override 改读 model_pricing(单一价格真源,lookupCost),只认 enabled 行。
// variant 命名:audio-1080P / audio-720P / 1080P / 720P。
function videoOverrideCost(modelKey: string, variant: string): number | null {
  const mp = lookupCost(`${modelKey}:${variant}`);
  return mp && mp.enabled ? mp.realCostYuan : null;
}
function videoVariant(resolution: string, audio: boolean): string {
  const res = resolution === '1080P' ? '1080P' : resolution === '480P' ? '480P' : '720P';
  return audio ? `audio-${res}` : res;
}

/** 取(模型,分辨率,有声)对应的每秒售价积分(无快照时回落用;与 jobs.ts 同规则)。
 *  优先 video_model_override 真实成本 → sellPrice(后台可改、接全局倍率);无行则回落代码 priceTier 常数。
 *  缺省档回落:有声1080→有声720→1080→720。 */
export function videoPriceTier(def: ReturnType<typeof getVideoModel>, resolution: string, audio: boolean): number {
  const ovCost = videoOverrideCost(def.key, videoVariant(resolution, audio));
  if (ovCost != null) return sellPrice(ovCost); // 后台录了真实成本 → 自动售价(接倍率)
  // 回落:代码常数(已是售价积分,迁移前/未录成本的兜底)
  const is480 = resolution === '480P';
  const is1080 = resolution === '1080P';
  if (audio) {
    if (is1080) return def.priceTierAudio1080 ?? def.priceTierAudio ?? def.priceTier1080 ?? def.priceTier;
    if (is480) return def.priceTierAudio480 ?? def.priceTierAudio ?? def.priceTier480 ?? def.priceTier;
    return def.priceTierAudio ?? def.priceTier;
  }
  if (is1080) return def.priceTier1080 ?? def.priceTier;
  if (is480) return def.priceTier480 ?? def.priceTier;
  return def.priceTier;
}

// 文转语音(TTS)计价:按字数 × 每字单价。
// 价格对齐(2026-06):qwen3-tts-flash / cosyvoice-v3.5-flash 真实 0.8元/万字符 = 0.00008/字符。
// 售价 = 成本 × 3.5 = 0.00028/字符 → 取 0.0028(留 10 倍安全垫?不:0.00008×35=0.0028,正好3.5倍)。
// 旧扁价 0.02 是真实成本的 ~7 倍(超收),订正为 0.0028。
// 注:cosyvoice 高阶档(plus 1.5~2元/万)真实成本更高,分层售价(0.00525/0.007)待加 per-model 字段(TODO),
// 当前扁价按主力 flash 档(0.0028)统一,高阶档暂亏本不上架。
const TTS_PRICE_PER_CHAR = 0.0028; // flash 档售价/字符(0.8元/万 × 3.5);兜底常数
// TTS 真实成本/字符(platform_config:tts_cost_per_char,默认 0.00008 = 0.8元/万)。
// 售价/字 = 真实成本 × markup_x35(接全局倍率,后台改倍率 TTS 也随之变)。不在此 floor(floor 在每单总价)。
function ttsPricePerChar(): number {
  // 2026-06 收口:TTS 成本从统一定价表 model_pricing(id='tts')读;售价/字 = 成本 × 全局倍率。
  //   迁移前/未录 → 回落旧 platform_config.tts_cost_per_char → 再回落兜底常数。
  const mp = lookupCost('tts');
  const cost = mp && mp.enabled ? mp.realCostYuan : Number(getConfig('tts_cost_per_char'));
  if (Number.isFinite(cost) && cost > 0) {
    // 接全局倍率;round 到 1e-10 抹掉 IEEE-754 浮尘(0.00008×35=0.0028000000000000004 → 0.0028),
    // 否则下游 ceil(10000×单价) 会把 28.0000…4 多收成 29(与整数 markup 同理的浮点多收)。
    return Math.round(cost * markupX35() * 1e10) / 1e10;
  }
  return TTS_PRICE_PER_CHAR; // 未配 → 兜底常数
}
/** TTS 费用预估:ceil(字数 × 每字单价)。pricePerChar 缺省 = 配置真实成本×倍率(无则兜底常数)。
 *  pricePerChar 形参保留:遗留 job 的 costFor 读旧快照走它,保 reserve==settle(byte-identical)。 */
export function estimateTtsCost(textLength: number, pricePerChar?: number): number {
  const per = typeof pricePerChar === 'number' ? pricePerChar : ttsPricePerChar();
  return Math.max(MIN_COST, Math.ceil(textLength * per));
}

// ── AI 音乐(Fun-Music)按秒计价 ──
// Fun-Music 请求体无「时长」参数(模型自定),按返回的 usage.duration 秒计费。故:
//  - 提交时按慷慨上限 AI_MUSIC_RESERVE_SECONDS 预估并 reserve(估高,留余量);
//  - 完成后 worker 用实际 duration 结算,且封顶 reserved(actual ≤ reserve → 只退不补,
//    绝不击穿"不允许负余额");settle() 已支持变额(diff=退/补,见本文件 settle)。
// Fun-Music 真实成本 0.002 元/秒(文档);售价 = 成本 × 全局倍率(markupX35,默认 ×35 → 0.07 积分/秒)。
// 接全局倍率:后台改倍率,音乐单价随之变。round 抹 IEEE-754 浮尘(同 TTS 范式)。
const AI_MUSIC_COST_PER_SECOND_YUAN = 0.002;
function aiMusicPricePerSecond(): number {
  return Math.round(AI_MUSIC_COST_PER_SECOND_YUAN * markupX35() * 1e10) / 1e10;
}
export const AI_MUSIC_RESERVE_SECONDS = 240; // 时长无法预估时的慷慨上限(约 4 分钟)
// 时长预估上下限 + 安全系数:reserve 必须 ≥ 实际(只退不补,绝不击穿)。
const AI_MUSIC_MIN_SECONDS = 30;
const AI_MUSIC_MAX_SECONDS = 300;
const AI_MUSIC_DUR_SAFETY = 1.3; // 估高余量,避免实际略超估值导致结算补扣
const AI_MUSIC_CHARS_PER_SECOND = 3.3; // 中文演唱速率(字/秒)粗估;英文按词≈字近似
const AI_MUSIC_INTRO_OUTRO_SECONDS = 20; // 前奏/间奏/尾奏无歌词时长的余量
/** 从歌词/提示词估算预期歌曲时长(秒)。Fun-Music 无时长入参,按文本量估 → 字越多歌越长。
 *  歌词优先(更准);仅提示词时按提示词量粗估。乘安全系数 + clamp[30,300],保 reserve≥实际。 */
export function estimateAiMusicSeconds(input: { lyrics?: unknown; prompt?: unknown }): number {
  const lyrics = typeof input.lyrics === 'string' ? input.lyrics.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  // 同传以歌词为准(与 Fun-Music 行为一致);仅提示词时按提示词量(更短,粗估)。
  const text = lyrics || prompt;
  if (!text) return AI_MUSIC_RESERVE_SECONDS; // 无文本(异常)→ 慷慨上限
  // 去掉 [verse]/[chorus] 等结构标记与空白,只数实际可唱字符。
  const singable = text.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, '').length;
  const raw = singable / AI_MUSIC_CHARS_PER_SECOND + AI_MUSIC_INTRO_OUTRO_SECONDS;
  const withSafety = raw * AI_MUSIC_DUR_SAFETY;
  return Math.min(AI_MUSIC_MAX_SECONDS, Math.max(AI_MUSIC_MIN_SECONDS, Math.ceil(withSafety)));
}
/** AI 音乐费用预估:ceil(秒数 × 每秒售价)。提交用估算秒(reserve),结算用实际秒(worker 封顶 reserved)。
 *  round 到 1e-6 抹 IEEE-754 浮尘(0.002×35×200=14.0000…2 → 否则 ceil 多收成 15)。 */
export function estimateAiMusicCost(durationSeconds: number): number {
  const raw = Math.round(durationSeconds * aiMusicPricePerSecond() * 1e6) / 1e6;
  return Math.max(MIN_COST, Math.ceil(raw));
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
        typeof input.speed === 'number' ? input.speed : undefined,
      );
    case 'ai_image': {
      // mode 感知 + model-aware(外部声音 P1/P2):priceTier 替代基价,maxImages 限张数。
      const resolution = typeof input.resolution === 'string' ? input.resolution : undefined;
      const mode = input.mode === 'img2img' ? 'img2img' : 'text2img';
      const def = getImageModel(typeof input.model === 'string' ? input.model : undefined, mode);
      // token 计价模型(gpt-image-2,Design B):有 def.priceRate → 走真实用量结算,不用 priceTier。
      //   有 usageSnapshot(worker 回写)→ 按实际 output token;无(reserve/estimate 阶段)→ 上界估算。
      //   build/estimate/settle 三处同经此分支 → 报价≡预扣、settle 只退不补(worker Math.min 封顶 reserved)。
      if (def.priceRate != null) {
        const rate = imageTokenRate(def, typeof input.priceRateSnapshot === 'number' ? input.priceRateSnapshot : undefined);
        const usage = input.usageSnapshot as ImageUsage | undefined;
        // 实结:usage 覆盖整请求全 N 张;output + 输入底图($8/1M)+ 输入文本($5/1M)全计入(商业自负盈亏)。
        if (usage && usage.outputTokens > 0) return imageTokenCredits(usageBillableTokens(usage, mode), rate);
        // reserve 上界估算:output×n + 编辑输入底图 token 上界(每张高保真,$8/1M 折 output-equivalent)。
        //   ×n:未来放开多出图时 usage 覆盖全 N 张,估算须 ×N,否则 reserve 偏低、settle 封顶吃差(评审 LOW#1)。
        const wh = imagePixelWH(def, typeof input.ratio === 'string' ? input.ratio : undefined, resolution);
        const quality = typeof input.quality === 'string' ? input.quality : undefined;
        const n = clampImageCount(input.count, def.maxImages);
        const numInputImages = mode === 'img2img'
          ? (Array.isArray(input.imageRefs) ? input.imageRefs.length
             : (typeof input.inputImageCount === 'number' ? input.inputImageCount : 0))
          : 0;
        const outEquiv = estImageOutputTokens(quality, wh?.width ?? 1024, wh?.height ?? 1024) * n
          + numInputImages * INPUT_IMAGE_TOKENS_UPPER * IN_IMG_RATIO;
        return imageTokenCredits(outEquiv, rate);
      }
      // P3:优先读提交时快照(admin 改价 mid-flight 不破 reserve==settle);无快照(老 job)按档实时回落。
      const priceTier = typeof input.priceTierSnapshot === 'number' ? input.priceTierSnapshot : imagePriceTier(def, resolution);
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
      const billable = typeof input.billableSecondsSnapshot === 'number' ? input.billableSecondsSnapshot : 0;
      const resolution = typeof input.resSnapshot === 'string'
        ? input.resSnapshot
        : (typeof input.resolution === 'string' ? input.resolution : '720P');
      // 无快照(老 job)→ 按分辨率派生每秒价(编辑无声)。
      const priceTier = typeof input.priceTierSnapshot === 'number' ? input.priceTierSnapshot : videoPriceTier(def, resolution, false);
      return estimateVideoCost(billable, priceTier, resolution, false);
    }
    case 'video_t2v':
    case 'video_i2v':
    case 'video_r2v': {
      // 文生视频 / 图转影片 / 多模态参考生:同计价(秒×档×tier)。i2v audio 恒 false;
      // r2v audio 由快照决定(Seedance generate_audio,eng-review P1#1:不硬编码 false → 不漏钱)。读快照(reserve==settle);
      // 无快照(老 job)回落实时派生(同 build 规则,R5.1 DRY)。
      const def = getVideoModel(typeof input.model === 'string' ? input.model : undefined);
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
      // 无快照(老 job)→ 按(分辨率,有声)派生每秒价(与 deriveVideoT2VParams 同规则)。
      const priceTier = typeof input.priceTierSnapshot === 'number' ? input.priceTierSnapshot : videoPriceTier(def, resolution, audio);
      return estimateVideoCost(duration, priceTier, resolution, audio);
    }
    case 'tts': {
      // 读快照单价(reserve==settle);老 job 无快照 → 回落扁价(estimateTtsCost 默认),byte-identical。
      const pricePerChar =
        typeof input.pricePerCharSnapshot === 'number' ? input.pricePerCharSnapshot : undefined;
      return estimateTtsCost(typeof input.text === 'string' ? input.text.length : 0, pricePerChar);
    }
    case 'ai_music': {
      // 有 durationSnapshot(worker 写入的实际秒)→ 按实际算;无(reserve/estimate 阶段)
      // → 按歌词/提示词估算预期时长(字越多歌越长,乘安全系数 + clamp,保 reserve≥实际)。
      // worker settle 时再 min(本值, reserved) 封顶,保只退不补。
      const seconds =
        typeof input.durationSnapshot === 'number'
          ? input.durationSnapshot
          : estimateAiMusicSeconds(input);
      return estimateAiMusicCost(seconds);
    }
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
  orderId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO credit_ledger (id,tenant_id,kind,amount,job_id,order_id,note,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), tenantId, kind, amount, jobId, orderId, note, now());
}

/** 当前余额 = 所有流水之和。 */
export function balance(tenantId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS bal FROM credit_ledger WHERE tenant_id=?`)
    .get(tenantId) as { bal: number };
  return row.bal;
}

export interface UsageSummary {
  balance: number; // 当前余额
  granted: number; // 累计发放(后台/充值入账)
  released: number; // 失败任务退还(不计费)累计
  consumed: number; // 累计净消耗(成功扣费,已扣掉失败退还)= granted - balance
  genCount: number; // 累计完成生成次数(结算行数)
  monthSpend: number; // 本自然月净消耗
  todaySpend: number; // 今日净消耗
  todayGenCount: number; // 今日完成生成次数
  trend30: number[]; // 近 30 天逐日净消耗(含今天,共 30 桶)
  spend30: number; // 近 30 天净消耗合计
}

// ── 按成员用量(2026-07 隐私隔离的正面补偿)──
// 背景:admin 收窄到看不见他人的作品与资产后,仍需回答「谁在烧钱、烧在哪」。
// 这里给出**纯聚合**口径:成员 / 次数 / 点数 / 按工具分布 —— 全是数字,不含任何文案或产物。
// 这是隐私与管理之间的那条线:管理员看得到「张三本月用了 1200 点、其中 AI 图片占 70%」,
// 但看不到张三生成了什么。
export interface MemberToolUsage {
  toolType: string; // job.type(video / ai_image / tts …)
  spend: number; // 该工具净消耗
  genCount: number; // 该工具完成次数
}
export interface MemberUsage {
  userId: string | null; // job.created_by;NULL = 无主老数据(本次不迁移,故这个桶会长期存在)
  userName: string | null; // 展示名;用户已删 → null,前端回退「已删除成员」
  spend: number; // 净消耗(口径与 usageSummary.consumed 完全一致)
  genCount: number; // 完成生成次数(settle 行数)
  byTool: MemberToolUsage[]; // 按工具分布(spend 降序)
}

/**
 * 按成员聚合用量(仅 admin 可读,见 /credits/usage-by-member 路由)。
 *
 * 净消耗口径与 usageSummary 严格一致(-SUM(amount) over kind in reserve/settle/release),
 * 保证「各成员之和 == 租户净消耗」—— 口径漂移会让管理员当场失去对数字的信任。
 * 有测试守这条恒等式。
 *
 * grant 行无 job_id,JOIN 不上 job → 天然不计入任何成员(发放是机构钱包入账,不是谁的消耗)。
 * since 省略 → 全时段累计。
 */
export function usageByMember(tenantId: string, since = 0): MemberUsage[] {
  const SPEND = `SUM(CASE WHEN l.kind IN ('reserve','settle','release') THEN -l.amount ELSE 0 END)`;
  const GEN = `SUM(CASE WHEN l.kind='settle' THEN 1 ELSE 0 END)`;
  const rows = db
    .prepare(
      `SELECT j.created_by AS userId,
              COALESCE(u.display_name, u.username) AS userName,
              j.type AS toolType,
              COALESCE(${SPEND},0) AS spend,
              COALESCE(${GEN},0)   AS genCount
         FROM credit_ledger l
         JOIN job j ON l.job_id = j.id
         LEFT JOIN user u ON j.created_by = u.id
        WHERE l.tenant_id = ? AND l.created_at >= ?
        GROUP BY j.created_by, j.type`,
    )
    .all(tenantId, since) as { userId: string | null; userName: string | null; toolType: string; spend: number; genCount: number }[];

  // 成员维度合并(SQL 出的是 成员×工具 的笛卡尔行,这里折叠成 成员 → byTool[])。
  const byUser = new Map<string, MemberUsage>();
  for (const r of rows) {
    const key = r.userId ?? '__unowned__'; // NULL 归一个桶(不与真实 id 撞:真实 id 是 UUID)
    let m = byUser.get(key);
    if (!m) {
      m = { userId: r.userId, userName: r.userName, spend: 0, genCount: 0, byTool: [] };
      byUser.set(key, m);
    }
    m.spend += r.spend;
    m.genCount += r.genCount;
    // 零消耗的工具行不进分布(reserve+release 相抵的纯失败任务),避免一堆 0 噪音;
    // 但它的 genCount=0 也不影响成员合计,故只过滤展示层。
    if (r.spend !== 0 || r.genCount !== 0) {
      m.byTool.push({ toolType: r.toolType, spend: r.spend, genCount: r.genCount });
    }
  }
  for (const m of byUser.values()) m.byTool.sort((a, b) => b.spend - a.spend);
  return [...byUser.values()].sort((a, b) => b.spend - a.spend); // 消耗高的排前
}

/**
 * 用量统计汇总(整租户,非个人)。修「客户端从分页 ledger 现算 → 只见一页」的欠计。
 * 净消耗口径:每笔 reserve/settle/release 对余额的负向影响 = -amount。
 *   成功任务 = 实扣;失败任务 reserve+release 相抵 = 0;token 模型 reserve 高估 + settle 退差 = 实扣。
 *   即净消耗 = -SUM(amount) over kind in (reserve,settle,release)。累计发放/退还单列(便于对账)。
 */
export function usageSummary(tenantId: string): UsageSummary {
  const DAY = 86_400_000;
  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(amount),0) AS balance,
         COALESCE(SUM(CASE WHEN kind='grant'   THEN amount ELSE 0 END),0) AS granted,
         COALESCE(SUM(CASE WHEN kind='release' THEN amount ELSE 0 END),0) AS released,
         COALESCE(SUM(CASE WHEN kind IN ('reserve','settle','release') THEN -amount ELSE 0 END),0) AS consumed,
         COALESCE(SUM(CASE WHEN kind='settle'  THEN 1 ELSE 0 END),0) AS genCount
       FROM credit_ledger WHERE tenant_id=?`,
    )
    .get(tenantId) as { balance: number; granted: number; released: number; consumed: number; genCount: number };

  // 周期净消耗 + 完成次数(created_at 为 ms epoch)。
  const periodStmt = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN kind IN ('reserve','settle','release') THEN -amount ELSE 0 END),0) AS spend,
       COALESCE(SUM(CASE WHEN kind='settle' THEN 1 ELSE 0 END),0) AS genCount
     FROM credit_ledger WHERE tenant_id=? AND created_at>=?`,
  );
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const month = periodStmt.get(tenantId, monthStart.getTime()) as { spend: number; genCount: number };
  const today = periodStmt.get(tenantId, dayStart.getTime()) as { spend: number; genCount: number };

  // 近 30 天逐日净消耗(日历日分桶,含今天)。
  const today0 = dayStart.getTime();
  const cutoff = today0 - 29 * DAY;
  const rows = db
    .prepare(`SELECT kind, amount, created_at FROM credit_ledger WHERE tenant_id=? AND created_at>=? AND kind IN ('reserve','settle','release')`)
    .all(tenantId, cutoff) as { kind: string; amount: number; created_at: number }[];
  const trend30 = new Array<number>(30).fill(0);
  for (const r of rows) {
    const d = new Date(r.created_at); d.setHours(0, 0, 0, 0);
    const idx = 29 - Math.round((today0 - d.getTime()) / DAY);
    if (idx >= 0 && idx < 30) trend30[idx]! += -r.amount; // 净消耗贡献 = -amount
  }
  const spend30 = trend30.reduce((a, b) => a + b, 0);

  return {
    balance: agg.balance, granted: agg.granted, released: agg.released, consumed: agg.consumed,
    genCount: agg.genCount, monthSpend: month.spend, todaySpend: today.spend, todayGenCount: today.genCount,
    trend30, spend30,
  };
}

/** 后台发放(admin)。orderId 关联充值订单(幂等部分唯一索引 + 审计);后台手动发放传 null。 */
export function grant(tenantId: string, amount: number, note = '后台发放', orderId: string | null = null): void {
  if (amount <= 0) throw new Error('发放积分必须为正');
  insert(tenantId, 'grant', amount, null, note, orderId);
}

/**
 * 在线支付退款追回(kind='refund',负数行)。grant() 拒负数的护栏语义不变——退款是
 * 唯一合法的负向发放,只经这一个入口(决策10/16,docs/designs/online-payments.md)。
 * - 余额可负:负余额下 reserve 自然失败(积分不足)→ 服务停用直至再充值,无需封禁逻辑。
 * - 幂等双保险:idx_ledger_order_refund 部分唯一索引 —— 同一订单第二次追回被 UNIQUE 拦。
 * - 显式排除出消耗统计:usageSummary/consumed 只认 reserve/settle/release,refund 只动 balance。
 */
export function refundClawback(tenantId: string, amount: number, note: string, orderId: string): void {
  if (amount <= 0) throw new Error('退款追回积分必须为正');
  insert(tenantId, 'refund', -amount, null, note, orderId);
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

/** 某 job 已预扣的绝对额(reserve 是负数,这里返回正值)。
 *  导出供 worker 做"结算封顶 reserved"(AI 音乐按实际秒结算,actual ≤ reserved → 只退不补)。 */
export function reservedFor(jobId: string): number {
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

/** 从 job.input_json 解析「作品文案摘要」:按工具类型取主文本字段,trim 后截前 24 字。
 *  让计费明细的「关联任务」列从一串 UUID 变成看得懂的作品(如配音文本/提示词前几字)。
 *  字段口径:video=script / ai_image·video_edit·video_*=prompt / tts=text / ai_music=prompt|lyrics。
 *  坏 JSON、空文案、无 job → 返回 null(前端回退显工具名或「—」)。 */
const TITLE_MAX = 24;
function summarizeJobInput(toolType: string | null | undefined, inputJson: string | null | undefined): string | null {
  if (!toolType || !inputJson) return null;
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputJson) as Record<string, unknown>;
  } catch {
    return null; // 坏 JSON 不应让计费查询失败 — 安全回退空
  }
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  let text: string | null;
  switch (toolType) {
    case 'video':
      text = pick('script');
      break;
    case 'tts':
      text = pick('text');
      break;
    case 'ai_music':
      text = pick('prompt', 'lyrics');
      break;
    default:
      // ai_image / video_edit / video_t2v / video_i2v 等都以 prompt 为主文案
      text = pick('prompt');
      break;
  }
  if (!text) return null;
  return text.length > TITLE_MAX ? text.slice(0, TITLE_MAX) + '…' : text;
}

/** 消费记录(可查询/导出,验收第H3)。 */
/** 消费明细 + 归属 + 关联作品:LEFT JOIN job(取工具 type / 文案 / 产物类型)+ user(取消费人名)。
 *  归属与作品摘要经 JOIN + input_json 解析派生(一次查询,前端不用 N 次 getJob),不冗余存 ledger;
 *  grant 行无 job_id → toolType/userName/taskTitle 空;老 job 的 created_by NULL → userName 空(前端显「—」)。
 *
 *  隔离口径「只看账不看内容」(产品决策 2026-07-25):
 *    行的可见性 —— admin 看全机构(机构要管预算,得知道谁花了多少);creator 只看自己 + grant。
 *    行的内容   —— taskTitle(提示词摘要)与 outputKind(可点开预览成品)只对**本人**下发。
 *  两者是不同的闸门:admin 能看见「张三 · AI 图片 · 36 积分」,但看不到他生成了什么、也点不开。 */
export function ledger(
  tenantId: string,
  limit = 100,
  actingUserId?: string,
  isAdmin = false,
  offset = 0,
): LedgerRow[] {
  // 账号隔离:creator 只看自己消费的行 + 机构发放(grant)行(发放是机构钱包入账,与「余额共享」一致)。
  // grant 行 job_id=NULL → JOIN 后 j.created_by 也 NULL,故必须 OR l.kind='grant' 才不把发放对 creator 隐藏(eng-review 1B)。
  // admin / 无 actingUserId(内部调用)→ 看全机构。
  const scoped = !isAdmin && actingUserId !== undefined;
  const scopeClause = scoped ? ` AND (j.created_by = ? OR l.kind = 'grant')` : '';
  const scopeParams = scoped ? [actingUserId] : [];
  const rows = db
    .prepare(
      `SELECT l.*, j.type AS toolType, j.input_json AS jobInput,
              j.output_kind AS jobOutputKind, j.output_url AS jobOutput,
              j.created_by AS jobOwner,
              COALESCE(u.display_name, u.username) AS userName
         FROM credit_ledger l
         LEFT JOIN job j ON l.job_id = j.id
         LEFT JOIN user u ON j.created_by = u.id
        WHERE l.tenant_id = ?${scopeClause}
        ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(tenantId, ...scopeParams, limit, offset) as (LedgerRow & {
    jobInput?: string | null;
    jobOutputKind?: string | null;
    jobOutput?: string | null;
    jobOwner?: string | null;
  })[];
  // 解析放在 JS 层:SQLite 不便解 JSON,且解析逻辑要与各工具字段口径对齐(summarizeJobInput)。
  return rows.map(({ jobInput, jobOutputKind, jobOutput, jobOwner, ...r }) => {
    // 内容闸门:只有本人才拿得到文案摘要与产物入口。actingUserId 缺省(内部调用/导出脚本)时不放行,
    // 宁可少给也不越权 —— 少给的表现是前端回退显工具名,越权的表现是提示词泄漏。
    const isOwn = !!actingUserId && !!jobOwner && jobOwner === actingUserId;
    return {
      ...r,
      taskTitle: isOwn ? summarizeJobInput(r.toolType, jobInput) : null,
      // outputKind 只在有成品(output_url 非空)时暴露 → 前端据此判断「可点预览」。
      // output_kind 列有 DEFAULT 'video',queued/failed 行也非空,故不能用它判产物;以 output_url 为准。
      // 他人行恒为 null:即便前端被改也点不开,真正的闸门在 /api/jobs/:id(getJobForTenant 会 404)。
      outputKind: isOwn && jobOutput ? jobOutputKind ?? null : null,
    };
  });
}

/** 消费明细总条数(分页用;与 ledger() 同隔离口径)。 */
export function countLedger(tenantId: string, actingUserId?: string, isAdmin = false): number {
  const scoped = !isAdmin && actingUserId !== undefined;
  // 注:与 ledger() 同口径需 JOIN job 才能按 created_by 隔离;COUNT 也走同 JOIN。
  const scopeClause = scoped ? ` AND (j.created_by = ? OR l.kind = 'grant')` : '';
  const scopeParams = scoped ? [actingUserId] : [];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM credit_ledger l
         LEFT JOIN job j ON l.job_id = j.id
        WHERE l.tenant_id = ?${scopeClause}`,
    )
    .get(tenantId, ...scopeParams) as { n: number };
  return row.n;
}
