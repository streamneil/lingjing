// 灵镜 — 平台默认数据种子(开箱即完整,单一真源)。
//
// 覆盖"让平台能用"所需的全部默认数据(不含演示账号):
//   1. image_model_override —— 图片模型能力 + 兜底定价(DB-only 模型如 qwen-image-2.0 靠它给 caps)
//   2. video_model_override —— 视频模型真实成本(每档一行)
//   3. platform_config.tts_cost_per_char —— TTS 成本
//   4. model_pricing —— 全模态「价格 + 启停」统一真源(isEnabled 读它);含豆包 Seedream / Gemini(Nano Banana)
//
// 全部 INSERT OR IGNORE / 存在即跳,幂等,绝不覆盖 admin 改过的。
// 调用点:app 启动(server.ts,仅 isMain,故不污染测试 :memory: 库)+ scripts/seed-demo.mjs(复用)。
//
// 背景:这些默认值以前散在 seed-demo(开发种子)里,生产 deploy.sh 不跑 seed-demo → 线上图片模型/
// 豆包/Gemini 全空(AI 图片下拉"暂无可用模型")。抽到这里由启动自动灌,生产/裸 docker 都开箱即有。

import { db } from '../db/index.js';
import { seedDefaultImageModels, DEFAULT_IMAGE_MODEL_SEED } from '../gateway/image-models.js';
import { variantId } from '../credits/pricing.js';

// 视频模型真实成本(元/秒;一模型多档=多行)。来源:火山/阿里文档价折算。
const VIDEO_SEED: [string, string, number][] = [
  ['wan2.7-t2v', '720P', 0.6], ['wan2.7-t2v', '1080P', 1.0],
  ['wan2.7-i2v', '720P', 0.6], ['wan2.7-i2v', '1080P', 1.0],
  ['wan2.7-r2v', '720P', 0.6], ['wan2.7-r2v', '1080P', 1.0],
  ['wan2.7-videoedit', '720P', 0.6], ['wan2.7-videoedit', '1080P', 1.0],
  ['happyhorse-1.0-t2v', '720P', 0.9], ['happyhorse-1.0-t2v', '1080P', 1.6],
  ['happyhorse-1.0-i2v', '720P', 0.9], ['happyhorse-1.0-i2v', '1080P', 1.6],
  ['happyhorse-1.0-r2v', '720P', 0.9], ['happyhorse-1.0-r2v', '1080P', 1.6],
  ['happyhorse-1.0-video-edit', '720P', 0.9], ['happyhorse-1.0-video-edit', '1080P', 1.6],
  ['kling-v3-t2v', '720P', 0.6], ['kling-v3-t2v', '1080P', 0.8],
  ['kling-v3-t2v', 'audio-720P', 0.9], ['kling-v3-t2v', 'audio-1080P', 1.2],
];

// 火山豆包 + Google Gemini(Nano Banana)真实成本 → model_pricing 直种(这些靠 model_pricing 行启用)。
//   [id, model_key, modality, unit, variant, realCostYuan]
const DOUBAO_SEED: [string, string, string, string, string | null, number][] = [
  ['doubao-seedream-4.0', 'doubao-seedream-4.0', 'image', '张', null, 0.20],
  ['doubao-seedream-4.5', 'doubao-seedream-4.5', 'image', '张', null, 0.25],
  ['doubao-seedream-5.0-lite', 'doubao-seedream-5.0-lite', 'image', '张', null, 0.22],
  // Seedance 2.5 官方按 output token 计价(无视频输入 70 元/百万、含视频 42 元/百万)。
  // 现有账本按输出秒计费,按 2.0 的 720P 实测秒价与刊例 token 单价比 70/46 折算为 1.52 元/秒;
  // 480P 暂同 720P 保守防低估,管理员可在统一定价页按真实 usage 分档校准。
  ['doubao-seedance-2.5:480P', 'doubao-seedance-2.5', 'video', '秒', '480P', 1.52],
  ['doubao-seedance-2.5:720P', 'doubao-seedance-2.5', 'video', '秒', '720P', 1.52],
  ['doubao-seedance-2.5:audio-480P', 'doubao-seedance-2.5', 'video', '秒', 'audio-480P', 1.824],
  ['doubao-seedance-2.5:audio-720P', 'doubao-seedance-2.5', 'video', '秒', 'audio-720P', 1.824],
  ['doubao-seedance-2.0:720P', 'doubao-seedance-2.0', 'video', '秒', '720P', 1.0],
  ['doubao-seedance-2.0:1080P', 'doubao-seedance-2.0', 'video', '秒', '1080P', 2.5],
  ['doubao-seedance-2.0-fast:720P', 'doubao-seedance-2.0-fast', 'video', '秒', '720P', 0.8],
];

// Gemini 分档定价(2026-07 分辨率分档计价,eng-review D1-D9)—— gemini 的基础行 + 变体行唯一真源
// (不再进 DOUBAO_SEED,防基础价两处字面量漂移让 D6 护栏误判)。
// 官方价(美元×7.2):Flash 512/1K/2K/4K=$0.045/0.067/0.101/0.151;Pro 1K-2K/4K=$0.134/0.24。
// '512' 档已真实 API 实测(2026-07-04,imageSize='512' HTTP 200 有图,D7)。
//   [model_key, 基础行 doc 默认价(=2K 档,分档回落用;D6 护栏比对同一字面量), [档, 元/张][]]
export const GEMINI_TIER_SEED: [string, number, [string, number][]][] = [
  ['gemini-3.1-flash-image', 0.73, [['512', 0.32], ['1K', 0.48], ['2K', 0.73], ['4K', 1.09]]],
  ['gemini-3-pro-image', 0.96, [['1K', 0.96], ['2K', 0.96], ['4K', 1.73]]],
];

/** 灌平台默认数据(幂等)。返回各表新增行数。app 启动 + seed-demo 共用(单一真源)。 */
export function seedPlatformDefaults(): { image: number; video: number; pricing: number } {
  const now = Date.now();

  // 1. 图片模型能力 + 兜底定价(image_model_override)
  const image = seedDefaultImageModels();

  // 2. 视频模型成本(video_model_override)
  const vovExists = db.prepare('SELECT 1 FROM video_model_override WHERE id=?');
  const insVov = db.prepare(
    `INSERT INTO video_model_override (id,model_key,variant,real_cost_yuan,cost_source,enabled,updated_at)
     VALUES (?,?,?,?, 'doc', 1, ?)`,
  );
  let video = 0;
  for (const [key, variant, cost] of VIDEO_SEED) {
    const id = `${key}:${variant}`;
    if (vovExists.get(id)) continue;
    insVov.run(id, key, variant, cost, now);
    video++;
  }

  // 3. TTS 成本兜底(platform_config)
  db.prepare(`INSERT OR IGNORE INTO platform_config (key,value) VALUES ('tts_cost_per_char','0.00008')`).run();

  // 4. model_pricing 统一真源(图片 + 视频 + TTS + 豆包/Gemini)。isEnabled 读它。
  const insMp = db.prepare(
    `INSERT OR IGNORE INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
     VALUES (?,?,?,?,?,?,'doc',?,?,?)`,
  );
  let pricing = 0;
  for (const [key, , , , cost, , , , sort] of DEFAULT_IMAGE_MODEL_SEED) {
    if (insMp.run(key, key, 'image', '张', null, cost, 1, sort ?? 0, now).changes) pricing++;
  }
  for (const [key, variant, cost] of VIDEO_SEED) {
    if (insMp.run(`${key}:${variant}`, key, 'video', '秒', variant, cost, 1, 0, now).changes) pricing++;
  }
  if (insMp.run('tts', 'tts', 'tts', '万字', '每字', 0.00008, 1, 0, now).changes) pricing++;
  for (const [id, key, modality, unit, variant, cost] of DOUBAO_SEED) {
    if (insMp.run(id, key, modality, unit, variant, cost, 1, 0, now).changes) pricing++;
  }

  // 5. Gemini 基础行 + 分档变体行(id=variantId(key,档);计价时变体行优先于基础行,imagePriceTier)。
  //    D6 护栏:基础行已被 admin 改价(≠doc 默认)→ 跳过该模型变体 —— 否则 doc 价变体
  //    优先生效,升级会静默架空 admin 的调价。跳过时打日志(统一定价页 PUT 可直接建各档行补价)。
  const readBase = db.prepare('SELECT real_cost_yuan FROM model_pricing WHERE id=?');
  for (const [key, baseDoc, tiers] of GEMINI_TIER_SEED) {
    if (insMp.run(key, key, 'image', '张', null, baseDoc, 1, 0, now).changes) pricing++; // 基础行(幂等)
    const base = readBase.get(key) as { real_cost_yuan: number } | undefined;
    if (base && Math.abs(base.real_cost_yuan - baseDoc) > 1e-9) {
      console.warn(`[seed] ${key} 基础价已被后台改为 ${base.real_cost_yuan}(doc=${baseDoc}),跳过分档变体种子;请到统一定价页对 ${key}:{档} 逐档录价`);
      continue;
    }
    for (const [tier, cost] of tiers) {
      if (insMp.run(variantId(key, tier), key, 'image', '张', tier, cost, 1, 0, now).changes) pricing++;
    }
  }

  // 6. OpenAI gpt-image-2(token 计价,Design B):单行 model_pricing。unit='token',
  //    real_cost_yuan = 每 output token 成本元 = $30/1M × 7.2 ≈ 0.000216(OpenAI 文档 output image token 价)。
  //    enabled=0(eng-review #1:admin 录完 key 再手动启用,避免没 key 的死模型窗口)。
  //    cost_source='doc'($30/1M 是官方文档价,非估算 → assertProfitable 放行)。
  //    不进 DEFAULT_IMAGE_MODEL_SEED / image_model_override(那批是 per-image 价 + enabled=1;此为 token 价 + 默认停用,单独种)。
  if (insMp.run('gpt-image-2', 'gpt-image-2', 'image', 'token', null, 0.000216, 0, 0, now).changes) pricing++;

  return { image, video, pricing };
}
