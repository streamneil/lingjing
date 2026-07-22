// 灵镜 AI 图片 — 分辨率分档计价(Nano Banana)测试。
//
// 决策来源:/plan-eng-review 2026-07-04(D1-D9 全裁决):
//   D8: mergeDef 无 override 行时也查 model_pricing(修「硬编码 priceTier 与定价表/倍率脱钩」);
//       imagePriceTier 两级链:变体行(model_pricing id="{key}:{档}")→ def.priceTier。
//   D2/D9: keyword 档集模型未传 resolution → 显式补默认档(含'2K'则'2K')写入 input;
//       build 与 estimate 共用补档+校验,报价≡实扣逐字节。
//   D5: 变体行被禁用 = 该档下架(/image-models 过滤 + build/estimate 400),绝不回落降价。
//   D6: 种子只在基础行仍为 doc 默认价时灌变体(不架空 admin 调价)。
//   D3: admin 图片模型表单保存,有变体行 → 响应带 variantNote 提醒。
//   D7: '512' 档已真实 API 实测(2026-07-04,HTTP 200 有图)→ 照种。
//
// 期望积分(markup=35):Flash 512/1K/2K/4K = 12/17/26/39;Pro 1K/2K/4K = 34/34/61。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.SUPERADMIN_USER = 'admin';
process.env.SUPERADMIN_PASS = 'superpw123';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { bootstrapSuperadmin } = await import('../src/auth/platform.js');
const { grant, costFor } = await import('../src/credits/index.js');
const { setConfig } = await import('../src/credits/pricing.js');
const { getImageModel } = await import('../src/gateway/image-models.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');
const { getJob } = await import('../src/queue/index.js');
const { Client } = await import('./helpers.js');

const FLASH = 'gemini-3.1-flash-image';
const PRO = 'gemini-3-pro-image';

const app = createApp();
const client = new Client(app);
let tenantId: string;

beforeAll(async () => {
  seedPlatformDefaults(); // 种默认模型 + model_pricing(含 gemini 基础行 + 变体行)
  await bootstrapSuperadmin();
  const t = createTenant('分档计价测试台');
  tenantId = t.id;
  await createUser(tenantId, 'creator1', 'pw123456', 'creator');
  grant(tenantId, 100000);
  const r = await client.login('creator1', 'pw123456');
  expect(r.status).toBe(200);
});

// ── imagePriceTier 两级链(单元)──────────────────────────────────────────
describe('imagePriceTier:变体行 → def.priceTier 两级链', () => {
  it('Flash 逐档:512/1K/2K/4K = 12/17/26/39', async () => {
    const { imagePriceTier } = await import('../src/credits/index.js');
    const def = getImageModel(FLASH);
    expect(imagePriceTier(def, '512')).toBe(12); // ⌈0.32×35⌉
    expect(imagePriceTier(def, '1K')).toBe(17); // ⌈0.48×35⌉
    expect(imagePriceTier(def, '2K')).toBe(26); // ⌈0.73×35⌉
    expect(imagePriceTier(def, '4K')).toBe(39); // ⌈1.09×35⌉
  });

  it('Pro 逐档:1K/2K/4K = 34/34/61', async () => {
    const { imagePriceTier } = await import('../src/credits/index.js');
    const def = getImageModel(PRO);
    expect(imagePriceTier(def, '1K')).toBe(34); // ⌈0.96×35⌉
    expect(imagePriceTier(def, '2K')).toBe(34);
    expect(imagePriceTier(def, '4K')).toBe(61); // ⌈1.73×35⌉
  });

  it("空 resolution → def.priceTier(基础行售价),绝不拼 'key:undefined' 查库", async () => {
    const { imagePriceTier } = await import('../src/credits/index.js');
    // 埋一行恶意 'key:undefined' 低价行:若实现真拼了字符串,会错误命中 → 抓现行
    db.prepare(
      `INSERT INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
       VALUES ('${PRO}:undefined','${PRO}','image','张','undefined',0.01,'doc',1,0,0)`,
    ).run();
    try {
      const def = getImageModel(PRO);
      expect(imagePriceTier(def, undefined)).toBe(34); // 基础行 0.96×35,非 0.01×35=1
    } finally {
      db.prepare(`DELETE FROM model_pricing WHERE id='${PRO}:undefined'`).run();
    }
  });

  it('无变体行模型回落 def.priceTier(qwen-image=9)', async () => {
    const { imagePriceTier } = await import('../src/credits/index.js');
    const def = getImageModel('qwen-image');
    expect(imagePriceTier(def, '1K')).toBe(9);
    expect(imagePriceTier(def, '2K')).toBe(9);
  });

  it('D8:无 override 行的模型(Flash)priceTier 跟随定价表与全局倍率', () => {
    // Flash 只有 model_pricing 基础行(0.73),无 image_model_override 行。
    // 修脱钩后:def.priceTier = sellPrice(0.73),改倍率应跟随;修前是代码常量 26 纹丝不动。
    expect(getImageModel(FLASH).priceTier).toBe(26); // ⌈0.73×35⌉
    setConfig('markup_x35', '40');
    try {
      expect(getImageModel(FLASH).priceTier).toBe(30); // ⌈0.73×40⌉=⌈29.2⌉
    } finally {
      setConfig('markup_x35', '35');
    }
  });
});

// ── 端点:estimate ≡ build 逐档(报价=实扣)───────────────────────────────
describe('estimate ≡ build:逐档报价一致且值正确', () => {
  const flashTiers: [string, number][] = [['512', 12], ['1K', 17], ['2K', 26], ['4K', 39]];

  it('Flash text2img 逐档:estimate 与提交 cost 一致', async () => {
    for (const [resolution, want] of flashTiers) {
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'text2img', count: 1, resolution });
      expect(est.status, `estimate ${resolution}`).toBe(200);
      expect(est.body.cost, `estimate ${resolution}`).toBe(want);
      const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'text2img', prompt: '测试猫', count: 1, resolution });
      expect(job.status, `build ${resolution}`).toBe(202);
      expect(job.body.cost, `build ${resolution}`).toBe(want);
    }
  });

  it('Pro 4K 恢复毛利:34 → 61;1K/2K 仍 34', async () => {
    for (const [resolution, want] of [['1K', 34], ['2K', 34], ['4K', 61]] as [string, number][]) {
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: PRO, mode: 'text2img', count: 1, resolution });
      expect(est.body.cost, `estimate ${resolution}`).toBe(want);
      const job = await client.post('/api/jobs', { type: 'ai_image', model: PRO, mode: 'text2img', prompt: '测试狗', count: 1, resolution });
      expect(job.body.cost, `build ${resolution}`).toBe(want);
    }
  });

  it('D2:不传 resolution → 显式默认 2K 写入 input,收 2K 价(estimate 同值)', async () => {
    const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'text2img', count: 1 });
    expect(est.body.cost).toBe(26);
    const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'text2img', prompt: '默认档', count: 1 });
    expect(job.status).toBe(202);
    expect(job.body.cost).toBe(26);
    const row = getJob(job.body.id)!;
    expect(JSON.parse(row.input_json as unknown as string).resolution).toBe('2K'); // 三层同值:校验/生成/计费
  });

  it('img2img(图片编辑)同样按档计价:Flash 1K 编辑 = 17', async () => {
    const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'img2img', count: 1, resolution: '1K' });
    expect(est.body.cost).toBe(17);
    const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'img2img', prompt: '改成蓝色', imageRefs: [`image-inputs/${tenantId}/x.png`], count: 1, resolution: '1K' });
    expect(job.status).toBe(202);
    expect(job.body.cost).toBe(17);
  });

  it("D9:非法档 '3K' → build 400 且 estimate 也 400(不再对不存在的档出价)", async () => {
    const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'text2img', prompt: 'x', resolution: '3K' });
    expect(job.status).toBe(400);
    const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'text2img', resolution: '3K' });
    expect(est.status).toBe(400);
  });
});

// ── D5:禁用变体 = 该档下架 ───────────────────────────────────────────────
describe('D5:变体行禁用 = 该档下架(绝不回落降价)', () => {
  it('禁用 Pro:4K → /image-models 档集不含 4K,build/estimate 均 400', async () => {
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE id='${PRO}:4K'`).run();
    try {
      const list = await client.get('/api/image-models');
      const pro = (list.body.models as Array<{ key: string; resolutionTiers?: string[] }>).find((m) => m.key === PRO)!;
      expect(pro.resolutionTiers).toEqual(['1K', '2K']);
      const job = await client.post('/api/jobs', { type: 'ai_image', model: PRO, mode: 'text2img', prompt: 'x', resolution: '4K' });
      expect(job.status).toBe(400); // 下架,不是按 34 卖成本 ¥1.73 的图
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: PRO, mode: 'text2img', resolution: '4K' });
      expect(est.status).toBe(400);
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE id='${PRO}:4K'`).run();
    }
  });

  it('全档禁用 → 任何档都拒绝(不落回 maxResolution 旧逻辑)', async () => {
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE model_key='${PRO}' AND variant IS NOT NULL`).run();
    try {
      const job = await client.post('/api/jobs', { type: 'ai_image', model: PRO, mode: 'text2img', prompt: 'x', resolution: '1K' });
      expect(job.status).toBe(400);
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE model_key='${PRO}' AND variant IS NOT NULL`).run();
    }
  });

  it('enabledTiers:无变体行的模型档集原样(豆包不受影响)', async () => {
    const { enabledTiers } = await import('../src/gateway/image-models.js');
    expect(enabledTiers(getImageModel('doubao-seedream-4.0'))).toEqual(['1K', '2K', '4K']);
    expect(enabledTiers(getImageModel('qwen-image'))).toBeUndefined(); // 无档集模型
  });
});

// ── 快照:reserve == settle ──────────────────────────────────────────────
describe('快照:admin 中途改变体价不破 reserve==settle', () => {
  it('提交后改价:老 job 按快照结算,新提交用新价', async () => {
    const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'text2img', prompt: '快照', count: 1, resolution: '1K' });
    expect(job.body.cost).toBe(17);
    db.prepare(`UPDATE model_pricing SET real_cost_yuan=2.0 WHERE id='${FLASH}:1K'`).run();
    try {
      const input = JSON.parse(getJob(job.body.id)!.input_json as unknown as string);
      expect(costFor('ai_image', input)).toBe(17); // settle 读快照,与 reserve 相等
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'text2img', count: 1, resolution: '1K' });
      expect(est.body.cost).toBe(70); // 新报价 ⌈2.0×35⌉
    } finally {
      db.prepare(`UPDATE model_pricing SET real_cost_yuan=0.48 WHERE id='${FLASH}:1K'`).run();
    }
  });

  it('老 job 无快照 → costFor 实时按档回落', () => {
    expect(costFor('ai_image', { model: FLASH, mode: 'text2img', resolution: '1K', count: 1 })).toBe(17);
    expect(costFor('ai_image', { model: FLASH, mode: 'text2img', resolution: '4K', count: 1 })).toBe(39);
  });
});

// ── 存量模型回归(CRITICAL):无变体行模型价格逐积分不变 ────────────────────
describe('存量模型回归:无变体行模型价格逐积分不变(CRITICAL)', () => {
  it('costFor 旧口径全部不变', () => {
    expect(costFor('ai_image', { count: 2, resolution: '1K' })).toBe(9); // 默认 qwen-image,clamp 2→1
    expect(costFor('ai_image', {})).toBe(9);
    expect(costFor('ai_image', { mode: 'img2img', resolution: '1K' })).toBe(11); // qwen-image-edit
    expect(costFor('ai_image', { model: 'z-image', count: 1, resolution: '1K' })).toBe(4);
    expect(costFor('ai_image', { model: 'wan2.2-flash', count: 4, resolution: '1K' })).toBe(20); // 4×5
  });

  it('keyword 档集模型(万相2.7 Pro)不传 resolution:计费不变(18/张),input 显式 2K', async () => {
    const job = await client.post('/api/jobs', { type: 'ai_image', model: 'wan2.7-image-pro', mode: 'text2img', prompt: 'x', count: 1 });
    expect(job.status).toBe(202);
    expect(job.body.cost).toBe(18); // 全档扁价,分档改造后不变
    expect(JSON.parse(getJob(job.body.id)!.input_json as unknown as string).resolution).toBe('2K'); // D2 显式化(=sizeParams 旧默认)
  });
});

// ── 补充分支覆盖(coverage audit 2026-07-04)────────────────────────────────
describe('imagePriceTier 双保险:变体行 disabled 时老 job 结算回落基础价', () => {
  it('禁用 Flash:4K → costFor 无快照老 job 按基础价 26(不 39、不崩)', () => {
    // resolutionAllowed 层已拒新提交;此分支只在「老 job 无快照回落 + 档中途下架」命中(双保险)。
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE id='${FLASH}:4K'`).run();
    try {
      expect(costFor('ai_image', { model: FLASH, mode: 'text2img', resolution: '4K', count: 1 })).toBe(26); // ⌈0.73×35⌉ 基础行
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE id='${FLASH}:4K'`).run();
    }
  });
});

describe('resolveImageRes 补充分支(默认首档 / 旧守卫 / resolutions 表)', () => {
  it('resolutionAllowed:档集模型未传 resolution → 按首个在售档判定(true)', async () => {
    const { resolutionAllowed } = await import('../src/gateway/image-models.js');
    expect(resolutionAllowed(getImageModel(PRO), undefined)).toBe(true); // resolution ?? tiers[0]
  });

  it("2K 档下架 → 不传 resolution 默认首个在售档 '512',build/estimate 同价 12", async () => {
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE id='${FLASH}:2K'`).run();
    try {
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'text2img', count: 1 });
      expect(est.status).toBe(200);
      expect(est.body.cost).toBe(12); // 首个在售档 512
      const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'text2img', prompt: '默认首档', count: 1 });
      expect(job.status).toBe(202);
      expect(job.body.cost).toBe(12);
      expect(JSON.parse(getJob(job.body.id)!.input_json as unknown as string).resolution).toBe('512');
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE id='${FLASH}:2K'`).run();
    }
  });

  it("旧守卫模型(z-image maxRes 2K)超档 '4K' → build 400 且 estimate 也 400(D9 统一)", async () => {
    const job = await client.post('/api/jobs', { type: 'ai_image', model: 'z-image', mode: 'text2img', prompt: 'x', count: 1, resolution: '4K' });
    expect(job.status).toBe(400);
    expect(String(job.body.error)).toContain('最高支持');
    const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: 'z-image', mode: 'text2img', count: 1, resolution: '4K' });
    expect(est.status).toBe(400); // 改造前 estimate 不校验旧守卫 → 对不可提交的档出价;现与 build 同 400
  });

  it('resolutions 表模型:非法比例 build/estimate 双 400;合法比例报价≡实扣 + 尺寸快照', async () => {
    db.prepare(
      `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,resolutions,created_at)
       VALUES ('tier-res-test','像素表测试','qwen-image',1,10,1,'qwen-image','text2img',99,?,0)`,
    ).run(JSON.stringify([{ ratio: '1:1', width: 1024, height: 1024, isDefault: true }, { ratio: '16:9', width: 2688, height: 1536 }]));
    try {
      const bad = await client.post('/api/jobs', { type: 'ai_image', model: 'tier-res-test', mode: 'text2img', prompt: 'x', ratio: '9:16' });
      expect(bad.status).toBe(400);
      expect(String(bad.body.error)).toContain('不支持比例');
      const badEst = await client.post('/api/jobs/estimate', { type: 'ai_image', model: 'tier-res-test', mode: 'text2img', ratio: '9:16' });
      expect(badEst.status).toBe(400); // 改造前 estimate 静默回落出价;现共用 resolveImageRes → 同 400
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: 'tier-res-test', mode: 'text2img', count: 1, ratio: '16:9' });
      const job = await client.post('/api/jobs', { type: 'ai_image', model: 'tier-res-test', mode: 'text2img', prompt: 'x', count: 1, ratio: '16:9' });
      expect(job.status).toBe(202);
      expect(job.body.cost).toBe(10); // 2688×1536=4.1MP→'4K' 档,IMG_RES_FACTOR=1 → price_tier=10
      expect(est.body.cost).toBe(job.body.cost); // 报价≡实扣(D9)
      const input = JSON.parse(getJob(job.body.id)!.input_json as unknown as string);
      expect(input.width).toBe(2688); // P1-c 尺寸快照走 resolveImageRes.sizeSnap
      expect(input.height).toBe(1536);
    } finally {
      db.prepare(`DELETE FROM image_model_override WHERE key='tier-res-test'`).run();
    }
  });
});

// ── admin D3:表单保存带变体提醒 ─────────────────────────────────────────
describe('admin D3:有变体行的模型,表单保存响应带提醒', () => {
  async function padminLogin() {
    const c = new Client(app);
    const r = await c.login('admin', 'superpw123', '/admin/login');
    expect(r.status).toBe(200);
    return c;
  }

  it('PUT 有变体行的模型 → variantNote;无变体行 → 无', async () => {
    const c = await padminLogin();
    const body = { label: 'Nano Banana Pro', modelId: 'gemini-3-pro-image', realCostYuan: 0.96, maxImages: 1, modes: ['text2img', 'img2img'], enabled: true };
    const r = await c.put(`/admin/api/image-models/${PRO}`, body);
    expect(r.status).toBe(200);
    expect(String(r.body.variantNote ?? '')).toContain('分档'); // 提醒去统一定价页改各档
    const r2 = await c.put('/admin/api/image-models/qwen-image', { label: '标准', modelId: 'qwen-image', realCostYuan: 0.25, maxImages: 1, modes: ['text2img'], enabled: true });
    expect(r2.status).toBe(200);
    expect(r2.body.variantNote).toBeUndefined();
  });

  it('POST 新增模型:key 已有变体行(统一定价页先建档)→ 201 也带 variantNote', async () => {
    const c = await padminLogin();
    db.prepare(
      `INSERT INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
       VALUES ('postnote-x:1K','postnote-x','image','张','1K',0.5,'doc',1,0,0)`,
    ).run();
    try {
      const r = await c.post('/admin/api/image-models', {
        key: 'postnote-x', label: '变体提醒测试', modelId: 'qwen-image', realCostYuan: 0.5, maxImages: 1,
        enabled: false, shapeTemplate: 'qwen-image', modes: ['text2img'], sortOrder: 99,
      });
      expect(r.status).toBe(201);
      expect(String(r.body.variantNote ?? '')).toContain('分档'); // D3:POST 同样提醒
    } finally {
      db.prepare(`DELETE FROM model_pricing WHERE model_key='postnote-x'`).run();
      db.prepare(`DELETE FROM image_model_override WHERE key='postnote-x'`).run();
    }
  });
});

// ── pre-landing review 修复(red-team / specialists 2026-07-05)────────────
describe('review 修复:像素推档下架 / estimate 拒绝路径 / 全档下架不下发 / admin 一致性', () => {
  async function padminLogin() {
    const c = new Client(app);
    const r = await c.login('admin', 'superpw123', '/admin/login');
    expect(r.status).toBe(200);
    return c;
  }

  it('RT1:resolutions 表模型像素推到已下架档 → build/estimate 双 400,重新上架按档价卖', async () => {
    // 给 Pro 挂比例表(1:1 → 4096²=4K 档),再禁用 Pro:4K 变体行 —— 像素推档绕过下架检查
    // 会复活「禁用 4K 按基础价 34 卖成本 ¥1.73 的图」。
    db.prepare(
      `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,resolutions,created_at)
       VALUES ('${PRO}','Nano Banana Pro','gemini-3-pro-image',1,34,1,'${PRO}','text2img,img2img',0,?,0)
       ON CONFLICT(key) DO UPDATE SET resolutions=excluded.resolutions`,
    ).run(JSON.stringify([{ ratio: '1:1', width: 4096, height: 4096, isDefault: true }]));
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE id='${PRO}:4K'`).run();
    try {
      const job = await client.post('/api/jobs', { type: 'ai_image', model: PRO, mode: 'text2img', prompt: 'x', ratio: '1:1' });
      expect(job.status).toBe(400);
      expect(String(job.body.error)).toContain('下架');
      const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: PRO, mode: 'text2img', ratio: '1:1' });
      expect(est.status).toBe(400);
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE id='${PRO}:4K'`).run(); // 重新上架
      const ok = await client.post('/api/jobs', { type: 'ai_image', model: PRO, mode: 'text2img', prompt: 'x', ratio: '1:1' });
      expect(ok.status).toBe(202);
      expect(ok.body.cost).toBe(61); // 4K 档价,不是基础价 34
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE id='${PRO}:4K'`).run();
      db.prepare(`UPDATE image_model_override SET resolutions=NULL WHERE key='${PRO}'`).run();
    }
  });

  it('RT5:estimate 拒绝路径与 build 一致:未知模型 400、模式不支持 400', async () => {
    const unk = await client.post('/api/jobs/estimate', { type: 'ai_image', model: 'no-such-model', mode: 'text2img' });
    expect(unk.status).toBe(400); // 此前静默回落默认模型报 9 积分,提交却 400
    const badMode = await client.post('/api/jobs/estimate', { type: 'ai_image', model: 'z-image', mode: 'img2img', resolution: '1K' });
    expect(badMode.status).toBe(400); // z-image 仅 text2img
  });

  it('F7:全档下架的模型不再下发到 /image-models;直接提交给「暂无在售档」明示', async () => {
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE model_key='${PRO}' AND variant IS NOT NULL`).run();
    try {
      const list = await client.get('/api/image-models');
      expect((list.body.models as Array<{ key: string }>).some((m) => m.key === PRO)).toBe(false); // 前端不可选,防 tiers:[] 回落假档集
      const job = await client.post('/api/jobs', { type: 'ai_image', model: PRO, mode: 'text2img', prompt: 'x' });
      expect(job.status).toBe(400);
      expect(String(job.body.error)).toContain('暂无在售档');
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE model_key='${PRO}' AND variant IS NOT NULL`).run();
    }
  });

  it('img2img 不传 resolution:默认 2K 档价 26,input 写 2K(D2 补全)', async () => {
    const est = await client.post('/api/jobs/estimate', { type: 'ai_image', model: FLASH, mode: 'img2img', count: 1 });
    expect(est.body.cost).toBe(26);
    const job = await client.post('/api/jobs', { type: 'ai_image', model: FLASH, mode: 'img2img', prompt: 'x', imageRefs: [`image-inputs/${tenantId}/x.png`], count: 1 });
    expect(job.status).toBe(202);
    expect(job.body.cost).toBe(26);
    expect(JSON.parse(getJob(job.body.id)!.input_json as unknown as string).resolution).toBe('2K');
  });

  it('RT4:admin 模型列表价/启停与 model_pricing 同源(改基础价/停用即反映)', async () => {
    const c = await padminLogin();
    db.prepare(`UPDATE model_pricing SET real_cost_yuan=0.9 WHERE id='${FLASH}'`).run();
    try {
      let list = await c.get('/admin/api/image-models');
      let flash = (list.body.models as Array<{ key: string; priceTier: number; enabled: boolean }>).find((m) => m.key === FLASH)!;
      expect(flash.priceTier).toBe(32); // ⌈0.9×35⌉;此前显示代码常量 26 与实收价脱节
      db.prepare(`UPDATE model_pricing SET enabled=0 WHERE id='${FLASH}'`).run();
      list = await c.get('/admin/api/image-models');
      flash = (list.body.models as Array<{ key: string; priceTier: number; enabled: boolean }>).find((m) => m.key === FLASH)!;
      expect(flash.enabled).toBe(false); // 此前 no-override 模型恒显 启用
    } finally {
      db.prepare(`UPDATE model_pricing SET real_cost_yuan=0.73, enabled=1 WHERE id='${FLASH}'`).run();
    }
  });

  it('mergeDef 语义钉死:基础行 disabled 仍按其成本算回落价(下架由列表/isEnabled 管)', () => {
    db.prepare(`UPDATE model_pricing SET enabled=0 WHERE id='${FLASH}'`).run();
    try {
      expect(getImageModel(FLASH).priceTier).toBe(26); // 价照算(在飞/老 job 兼容);不可购由 listEnabledModels 过滤
    } finally {
      db.prepare(`UPDATE model_pricing SET enabled=1 WHERE id='${FLASH}'`).run();
    }
  });

  it('RT3:统一定价页可对合法「模型:档」直接建行;非法 404', async () => {
    const c = await padminLogin();
    try {
      const r = await c.put('/admin/api/pricing/models/doubao-seedream-4.0:2K', { realCostYuan: 0.3 });
      expect(r.status).toBe(200);
      expect(r.body.created).toBe(true);
      const { imagePriceTier } = await import('../src/credits/index.js');
      expect(imagePriceTier(getImageModel('doubao-seedream-4.0'), '2K')).toBe(11); // ⌈0.3×35⌉,建档即生效
      const bad1 = await c.put('/admin/api/pricing/models/doubao-seedream-4.0:5K', { realCostYuan: 0.3 });
      expect(bad1.status).toBe(404); // 档不在该模型档集
      const bad2 = await c.put('/admin/api/pricing/models/qwen-image:2K', { realCostYuan: 0.3 });
      expect(bad2.status).toBe(404); // 无档集模型不能建档
    } finally {
      db.prepare(`DELETE FROM model_pricing WHERE id='doubao-seedream-4.0:2K'`).run();
    }
  });

  it('RT3-alert:预期分档模型缺变体行 → 定价页 alerts 提示;补齐后无提示', async () => {
    const c = await padminLogin();
    db.prepare(`DELETE FROM model_pricing WHERE id='${FLASH}:1K'`).run();
    try {
      const r = await c.get('/admin/api/pricing/models');
      expect((r.body.alerts as string[]).some((a) => a.includes(FLASH) && a.includes('1K'))).toBe(true);
    } finally {
      seedPlatformDefaults(); // 基础行仍 doc 价 → 1K 补种
    }
    const r2 = await c.get('/admin/api/pricing/models');
    expect((r2.body.alerts as string[]).some((a) => a.includes(FLASH))).toBe(false);
  });

  it('RT2:删除模型连带删分档行(不留孤儿压价);重种恢复', async () => {
    const c = await padminLogin();
    const r = await c.del(`/admin/api/image-models/${FLASH}`);
    expect(r.status).toBe(200);
    const left = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE model_key='${FLASH}'`).get() as { c: number };
    expect(left.c).toBe(0); // 基础行 + 4 变体行全清 —— 否则重建录新价后旧档价仍优先且无端点可删
    seedPlatformDefaults();
    const back = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE model_key='${FLASH}' AND variant IS NOT NULL`).get() as { c: number };
    expect(back.c).toBe(4);
  });

  it('ADV:删除撞名图片模型不连坐其他模态定价行(modality 限定)', async () => {
    const c = await padminLogin();
    // 造一个与视频 model_key 撞名的图片模型 + 一条该 key 的视频变体行
    db.prepare(
      `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,created_at)
       VALUES ('clash-key','撞名测试','qwen-image',0,10,1,'qwen-image','text2img',99,0)`,
    ).run();
    db.prepare(
      `INSERT INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
       VALUES ('clash-key:720P','clash-key','video','秒','720P',0.6,'doc',1,0,0)`,
    ).run();
    try {
      const r = await c.del('/admin/api/image-models/clash-key');
      expect(r.status).toBe(200);
      const video = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE id='clash-key:720P'`).get() as { c: number };
      expect(video.c).toBe(1); // 视频行必须幸存 —— 不限定 modality 会被连坐删掉,视频价静默回落
    } finally {
      db.prepare(`DELETE FROM model_pricing WHERE model_key='clash-key'`).run();
      db.prepare(`DELETE FROM image_model_override WHERE key='clash-key'`).run();
    }
  });

  it('ADV:幽灵模型(模板已亡)不能建变体行(getImageModel 回落默认不放行)', async () => {
    const c = await padminLogin();
    db.prepare(
      `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,created_at)
       VALUES ('ghost-model','幽灵','ghost-model',1,10,1,'dead-template','text2img',99,0)`,
    ).run();
    try {
      const r = await c.put('/admin/api/pricing/models/ghost-model:1K', { realCostYuan: 0.3 });
      expect(r.status).toBe(404); // isKnownModel 过但 mergeDef undefined→回落默认模型;def.key≠请求 key 必须拒
      const stray = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE id='ghost-model:1K'`).get() as { c: number };
      expect(stray.c).toBe(0);
    } finally {
      db.prepare(`DELETE FROM image_model_override WHERE key='ghost-model'`).run();
    }
  });

  it('RT6:改模型排序,变体行 sort_order 跟随基础行(定价页不分家)', async () => {
    const c = await padminLogin();
    const body = { label: 'Nano Banana Pro', modelId: 'gemini-3-pro-image', realCostYuan: 0.96, maxImages: 1, modes: ['text2img', 'img2img'], enabled: true, sortOrder: 9 };
    const r = await c.put(`/admin/api/image-models/${PRO}`, body);
    expect(r.status).toBe(200);
    const rows = db.prepare(`SELECT sort_order FROM model_pricing WHERE model_key='${PRO}' AND variant IS NOT NULL`).all() as { sort_order: number }[];
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.sort_order).toBe(9);
  });
});

// ── 种子:幂等 + D6 护栏(有状态破坏,置于最后)─────────────────────────────
describe('种子:变体行幂等 + D6 不架空 admin 调价', () => {
  it('重跑种子:不重复、不覆盖', () => {
    const before = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE variant IS NOT NULL AND model_key LIKE 'gemini%'`).get() as { c: number };
    expect(before.c).toBe(7); // Flash 512/1K/2K/4K + Pro 1K/2K/4K
    const r = seedPlatformDefaults();
    expect(r.pricing).toBe(0); // 幂等:全部已存在
  });

  it('D6:基础行被 admin 改过价 → 该模型变体跳过;恢复 doc 价后补种', () => {
    db.prepare(`DELETE FROM model_pricing WHERE model_key='${FLASH}' AND variant IS NOT NULL`).run();
    db.prepare(`UPDATE model_pricing SET real_cost_yuan=0.9, cost_source='doc' WHERE id='${FLASH}'`).run();
    seedPlatformDefaults();
    const after = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE model_key='${FLASH}' AND variant IS NOT NULL`).get() as { c: number };
    expect(after.c).toBe(0); // 护栏:不灌 doc 价变体架空 admin 的 0.9
    // 恢复 doc 默认价 → 变体补种
    db.prepare(`UPDATE model_pricing SET real_cost_yuan=0.73 WHERE id='${FLASH}'`).run();
    seedPlatformDefaults();
    const restored = db.prepare(`SELECT COUNT(*) AS c FROM model_pricing WHERE model_key='${FLASH}' AND variant IS NOT NULL`).get() as { c: number };
    expect(restored.c).toBe(4);
  });
});
