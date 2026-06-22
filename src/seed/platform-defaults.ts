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
  ['doubao-seedance-2.0:720P', 'doubao-seedance-2.0', 'video', '秒', '720P', 1.0],
  ['doubao-seedance-2.0:1080P', 'doubao-seedance-2.0', 'video', '秒', '1080P', 2.5],
  ['doubao-seedance-2.0-fast:720P', 'doubao-seedance-2.0-fast', 'video', '秒', '720P', 0.8],
  ['gemini-3.1-flash-image', 'gemini-3.1-flash-image', 'image', '张', null, 0.73], // Nano Banana 2
  ['gemini-3-pro-image', 'gemini-3-pro-image', 'image', '张', null, 0.96],         // Nano Banana Pro
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

  return { image, video, pricing };
}
