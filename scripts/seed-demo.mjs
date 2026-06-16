#!/usr/bin/env node
// 灵镜 — 一键种子:建演示机构 + 管理员 + 发放积分。
// 用法:DB_FILE=lingjing.db npx tsx scripts/seed-demo.mjs
// 用户名全局唯一,登录只需 用户名 + 密码(无需机构 ID)。

import { createTenant, createUser } from '../src/auth/index.ts';
import { grant } from '../src/credits/index.ts';
import { db } from '../src/db/index.ts';

// 幂等:逐个用户名独立判断(用户名全局唯一)。
// 之前只查 demoadmin 一个,若 demoadmin 不存在但 editor 已存在,会在建 editor 时撞唯一索引崩溃。
// 现在每个用户存在就跳过,租户也只在两个演示用户都不存在时才新建,避免重复同名租户。
// 注意:admin 是平台超管保留字(见 RESERVED_USERNAMES),演示租户管理员用 demoadmin。
const userExists = (u) => !!db.prepare('SELECT 1 FROM user WHERE username=?').get(u);

if (userExists('demoadmin') && userExists('editor')) {
  console.log('\n演示账号已存在,直接登录即可:demoadmin / pw123456(或 editor / pw123456)\n');
} else {
  // 复用已有演示用户所在的租户(若有);否则新建一个,避免重复同名"演示融媒体中心"。
  const existing = db.prepare('SELECT tenant_id FROM user WHERE username IN (?,?)').get('demoadmin', 'editor');
  const tenantId = existing ? existing.tenant_id : createTenant('演示融媒体中心', 'hosted').id;
  if (!userExists('demoadmin')) createUser(tenantId, 'demoadmin', 'pw123456', 'admin'); // admin 是保留字,管理员用 demoadmin
  if (!userExists('editor')) createUser(tenantId, 'editor', 'pw123456', 'creator');
  // 仅新租户发初始积分(已存在的租户不重复发)
  if (!existing) grant(tenantId, 5000);
  console.log('\n=== 灵镜演示账号已就绪 ===');
  console.log('机构管理员: demoadmin / pw123456');
  console.log('创作者    : editor / pw123456');
  console.log('初始积分  : 5000');
  console.log('(平台超管 admin 由 SUPERADMIN_PASS 环境变量首启自动创建,登录 /admin/login)');
}

// ── 图片模型定价 + 能力(成本驱动,2026-06 价格页确价)──
// 幂等:只插缺失的行,绝不覆盖 admin 已改的价/能力。price_tier = ceil(真实元/张 × 35)。
// 含 DB-only 模型(qwen-image-2.0 无代码模板,靠 shape_template 指向模板);
// 纯代码模板模型(z-image/qwen-image 等)无 override 行也能跑(回落模板),这里一并落库便于运营调价。
const IMG_SEED = [
  // key, label, modelId, priceTier(=cost×35), realCost, maxImages, shapeTemplate, modes, sort
  ['qwen-image',        '标准',            'qwen-image',         9,  0.25, 1, 'qwen-image',        'text2img',           0],
  ['z-image',           '极速',            'z-image-turbo',      4,  0.10, 1, 'z-image',           'text2img',           1],
  ['qwen-image-2.0',    '千问2.0',         'qwen-image-2.0',     7,  0.20, 6, 'qwen-image-2.0-pro','text2img',           2],
  ['qwen-image-2.0-pro','专业 (千问2.0 Pro)','qwen-image-2.0-pro',18, 0.50, 6, 'qwen-image-2.0-pro','text2img,img2img',  3],
  // 万相2.6(wan2.6-image)已移除:纯文生图只支持 SSE 流式 interleave 路径,本平台网关全是非流式
  //   同步/异步,无法对接 → 删除,不在 AI 图片下拉出现。详见 2026-06-16 QA。
  ['qwen-image-edit',   '图像编辑',         'qwen-image-edit',    11, 0.30, 1, 'qwen-image-edit',   'img2img',            5],
  ['wan2.2-flash',      '万相2.2 极速',     'wan2.2-t2i-flash',   5,  0.14, 4, 'wan2.2-flash',      'text2img',           6],
  // 万相2.7 编辑/Pro:旧靠"代码模板默认启用"上线,现 isEnabled 需 DB 行 → 必须种子(否则下线)。
  ['wan2.7-image',      '万相2.7 编辑',     'wan2.7-image',       7,  0.20, 4, 'wan2.7-image',      'text2img,img2img',   7],
  ['wan2.7-image-pro',  '万相2.7 编辑 Pro', 'wan2.7-image-pro',   18, 0.50, 4, 'wan2.7-image-pro',  'text2img,img2img',   8],
];
const imgRowExists = db.prepare('SELECT 1 FROM image_model_override WHERE key=?');
const insImg = db.prepare(
  `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,real_cost_yuan,cost_source,max_images,shape_template,modes,sort_order,created_at)
   VALUES (?,?,?,1,?,?,'doc',?,?,?,?,?)`,
);
let seeded = 0;
for (const [key, label, modelId, tier, cost, maxImg, tmpl, modes, sort] of IMG_SEED) {
  if (imgRowExists.get(key)) continue; // 已存在(含 admin 改过的)→ 不动
  insImg.run(key, label, modelId, tier, cost, maxImg, tmpl, modes, sort, Date.now());
  seeded++;
}
if (seeded) console.log(`图片模型定价已种子 ${seeded} 个(真实成本×35,cost_source=doc)`);

// ── 视频模型真实成本(video_model_override;按文档真实元/秒,非 ÷35 反推)──
// 一模型多档=多行,id="{key}:{variant}";enabled=1(视频现状全部可用,种子保持)。
// variant:720P/1080P/audio-720P/audio-1080P。售价由 sellPrice(成本×倍率) 实时算,这里只存成本。
const VIDEO_SEED = [
  // 大师(万相2.7)t2v/i2v/r2v/编辑:720P 0.6、1080P 1.0 元/秒
  ['wan2.7-t2v','720P',0.6],['wan2.7-t2v','1080P',1.0],
  ['wan2.7-i2v','720P',0.6],['wan2.7-i2v','1080P',1.0],
  ['wan2.7-r2v','720P',0.6],['wan2.7-r2v','1080P',1.0],
  ['wan2.7-videoedit','720P',0.6],['wan2.7-videoedit','1080P',1.0],
  // HappyHorse t2v/i2v/r2v/编辑:720P 0.9、1080P 1.6 元/秒
  ['happyhorse-1.0-t2v','720P',0.9],['happyhorse-1.0-t2v','1080P',1.6],
  ['happyhorse-1.0-i2v','720P',0.9],['happyhorse-1.0-i2v','1080P',1.6],
  ['happyhorse-1.0-r2v','720P',0.9],['happyhorse-1.0-r2v','1080P',1.6],
  ['happyhorse-1.0-video-edit','720P',0.9],['happyhorse-1.0-video-edit','1080P',1.6],
  // 可灵 V3:无声 720P 0.6 / 1080P 0.8;有声 720P 0.9 / 1080P 1.2
  ['kling-v3-t2v','720P',0.6],['kling-v3-t2v','1080P',0.8],
  ['kling-v3-t2v','audio-720P',0.9],['kling-v3-t2v','audio-1080P',1.2],
];
const vovExists = db.prepare('SELECT 1 FROM video_model_override WHERE id=?');
const insVov = db.prepare(
  `INSERT INTO video_model_override (id,model_key,variant,real_cost_yuan,cost_source,enabled,updated_at)
   VALUES (?,?,?,?, 'doc', 1, ?)`,
);
let vSeeded = 0;
for (const [key, variant, cost] of VIDEO_SEED) {
  const id = `${key}:${variant}`;
  if (vovExists.get(id)) continue;
  insVov.run(id, key, variant, cost, Date.now());
  vSeeded++;
}
if (vSeeded) console.log(`视频模型成本已种子 ${vSeeded} 行(真实元/秒,enabled=1)`);

// ── TTS 真实成本/字符 + 全局参数兜底(platform_config 建表时已 seed markup;这里补 TTS 成本)──
db.prepare(`INSERT OR IGNORE INTO platform_config (key,value) VALUES ('tts_cost_per_char','0.00008')`).run(); // 0.8元/万字符

// ── model_pricing:全模态统一定价表直种(2026-06,新装直种免依赖 db/index.ts 迁移)──
// 复用上面 IMG_SEED / VIDEO_SEED 的真实成本;TTS 单行。INSERT OR IGNORE 幂等(已有则不动 admin 改过的)。
const insMp = db.prepare(
  `INSERT OR IGNORE INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
   VALUES (?,?,?,?,?,?,'doc',?,?,?)`,
);
let mpSeeded = 0;
for (const [key, , , , cost, , , , sort] of IMG_SEED) {
  if (insMp.run(key, key, 'image', '张', null, cost, 1, sort ?? 0, Date.now()).changes) mpSeeded++;
}
for (const [key, variant, cost] of VIDEO_SEED) {
  if (insMp.run(`${key}:${variant}`, key, 'video', '秒', variant, cost, 1, 0, Date.now()).changes) mpSeeded++;
}
if (insMp.run('tts', 'tts', 'tts', '万字', '每字', 0.00008, 1, 0, Date.now()).changes) mpSeeded++;

// ── 火山豆包真实定价(PR-2a;火山文档价格示例折算)──
// 图片:固定元/张(doc)。视频:5秒 720p 价格示例折每秒(2.0=4.97/5≈1.0、fast=4.0/5=0.8)。
// 真实成本入库 → sellPrice=⌈成本×35⌉ 自动算 → isEnabled=true 上线。
const DOUBAO_SEED = [
  // [id, model_key, modality, unit, variant, realCost]
  ['doubao-seedream-4.0', 'doubao-seedream-4.0', 'image', '张', null, 0.20],
  ['doubao-seedream-4.5', 'doubao-seedream-4.5', 'image', '张', null, 0.25],
  ['doubao-seedream-5.0-lite', 'doubao-seedream-5.0-lite', 'image', '张', null, 0.22],
  ['doubao-seedance-2.0:720P', 'doubao-seedance-2.0', 'video', '秒', '720P', 1.0],   // 4.97/5 秒 ≈ 1.0
  ['doubao-seedance-2.0:1080P', 'doubao-seedance-2.0', 'video', '秒', '1080P', 2.5], // 12.39/5 秒 ≈ 2.48→2.5
  ['doubao-seedance-2.0-fast:720P', 'doubao-seedance-2.0-fast', 'video', '秒', '720P', 0.8], // 4.0/5 秒 = 0.8
  // Google Gemini(Nano Banana):美元×7.2 汇率折人民币(后台可调)。
  ['gemini-2.5-flash-image', 'gemini-2.5-flash-image', 'image', '张', null, 0.28], // $0.039×7.2≈0.28→⌈×35⌉=10
  ['gemini-3-pro-image', 'gemini-3-pro-image', 'image', '张', null, 0.96],         // $0.134×7.2≈0.96→⌈×35⌉=34
];
for (const [id, key, modality, unit, variant, cost] of DOUBAO_SEED) {
  if (insMp.run(id, key, modality, unit, variant, cost, 1, 0, Date.now()).changes) mpSeeded++;
}
if (mpSeeded) console.log(`统一定价表 model_pricing 已种子 ${mpSeeded} 行(图片/视频/TTS/豆包/Gemini)`);

// 强制 WAL checkpoint:让写入立即落主库,避免另起的服务进程读到旧快照
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* noop */ }

console.log('登录: http://localhost:9372/login.html  (用户名 admin,密码 pw123456,无需机构 ID)\n');
