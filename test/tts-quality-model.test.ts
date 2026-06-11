// 灵镜 — TTS 品质模型选择 + 按 tier 计价(T-TTS-QUALITY-MODEL)。
//
// 钱路重点(reserve==settle):
//   - estimateTtsCost(len) 默认单价不变(老调用/job byte-identical)
//   - estimateTtsCost(len, pricePerChar) 按模型单价
//   - costFor('tts') 读 pricePerCharSnapshot;无快照回落扁价
//   - buildTtsJob 选模型 → 快照单价 + estimate≡build(cost 一致)
//   - 模型⟂音色 transport 不兼容 → 400
//   - resolveVoice(chosenModel) 覆盖合成 model + transport 配套

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

vi.mock('../src/gateway/cosyvoice.js', () => ({
  createDesignedVoice: vi.fn(async () => ({ voiceId: 'qwen-design-x', previewAudio: Buffer.from('p') })),
  createClonedVoice: vi.fn(),
  synthesizeSpeech: vi.fn(),
  synthesizeSpeechHttp: vi.fn(),
}));

const { db } = await import('../src/db/index.js');
const { estimateTtsCost, costFor } = await import('../src/credits/index.js');
const { resolveVoice } = await import('../src/queue/worker.js');
const { config } = await import('../src/config.js');
const { TTS_MODELS } = await import('../src/gateway/tts-models.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const voices = await import('../src/voices/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);
let tid = '';
let designVoiceId = '';

beforeAll(async () => {
  const t = createTenant('品质测试台');
  tid = t.id;
  createUser(t.id, 'qmcreator', 'pw123456', 'creator');
  grant(t.id, 100000);
  expect((await client.login('qmcreator', 'pw123456')).status).toBe(200);
  // 一个设计音色(http transport)
  const dv = voices.createDesignVoice({ tenantId: tid, name: '设计声', providerVoiceId: 'qwen-v-1' });
  designVoiceId = dv.id;
}, 30000);

describe('estimateTtsCost 单价', () => {
  it('默认单价不变(byte-identical):100字 × 0.02 = 2', () => {
    expect(estimateTtsCost(100)).toBe(2);
  });
  it('按模型单价:100字 × 0.05 = 5', () => {
    expect(estimateTtsCost(100, 0.05)).toBe(5);
  });
  it('MIN_COST 兜底:短文本仍 >=1', () => {
    expect(estimateTtsCost(5, 0.02)).toBe(1);
  });
});

describe("costFor('tts') 读快照", () => {
  it('有 pricePerCharSnapshot → 按快照算', () => {
    expect(costFor('tts', { text: '字'.repeat(100), pricePerCharSnapshot: 0.05 })).toBe(5);
  });
  it('无快照 → 回落扁价(老 job byte-identical)', () => {
    expect(costFor('tts', { text: '字'.repeat(100) })).toBe(2);
  });
});

describe('POST /api/jobs (tts) 品质模型', () => {
  // 预置 = Qwen 音色(http);用 'Cherry' 作样例预置
  it('不选模型 → cost 扁价 + input 无 model/快照(byte-identical)', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '字'.repeat(100), voiceRef: 'Cherry' });
    expect(r.status).toBe(202);
    expect(r.body.cost).toBe(2);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.model).toBeUndefined();
    expect(inp.pricePerCharSnapshot).toBeUndefined();
  });

  it('选 qwen3-tts-instruct-flash(http,0.06)→ cost 6 + 快照写入', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '字'.repeat(100), voiceRef: 'Cherry', model: 'qwen3-tts-instruct-flash' });
    expect(r.status).toBe(202);
    expect(r.body.cost).toBe(6);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.model).toBe('qwen3-tts-instruct-flash');
    expect(inp.pricePerCharSnapshot).toBe(0.06);
  });

  it('estimate ≡ build(reserve==settle):同参 cost 一致', async () => {
    const body = { type: 'tts', text: '字'.repeat(100), voiceRef: 'Cherry', model: 'qwen3-tts-instruct-flash' };
    const est = await client.post('/api/jobs/estimate', body);
    const job = await client.post('/api/jobs', body);
    expect(est.body.cost).toBe(job.body.cost);
    expect(est.body.cost).toBe(6);
  });

  it('不兼容:预置(http)+ cosyvoice(ws)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', model: 'cosyvoice-v3.5-flash' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('不兼容');
  });

  it('兼容:设计音色(http)+ qwen(http)→ 通过', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: designVoiceId, model: 'qwen3-tts-flash' });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.model).toBe('qwen3-tts-flash');
    expect(inp.pricePerCharSnapshot).toBe(0.04);
  });

  it('未知模型 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'Cherry', model: 'no-such-model' });
    expect(r.status).toBe(400);
  });
});

describe('resolveVoice(chosenModel) 覆盖合成 model', () => {
  beforeEach(() => db.prepare('DELETE FROM voice').run());
  it('预置 + 选 qwen-instruct → model=qwen3-tts-instruct-flash、transport=http', () => {
    const r = resolveVoice('Cherry', tid, 'qwen3-tts-instruct-flash');
    expect(r.model).toBe('qwen3-tts-instruct-flash');
    expect(r.transport).toBe('http');
  });
  it('预置 + 不选 → 默认 qwenTtsModel、http(byte-identical)', () => {
    const r = resolveVoice('Cherry', tid);
    expect(r.model).toBe(config.baichuan.qwenTtsModel);
    expect(r.transport).toBe('http');
  });
  it('设计音色 + 选 qwen3-tts-flash → modelId、transport=http', () => {
    const dv = voices.createDesignVoice({ tenantId: tid, name: 'd', providerVoiceId: 'qv' });
    const r = resolveVoice(dv.id, tid, 'qwen3-tts-flash');
    expect(r.model).toBe('qwen3-tts-flash');
    expect(r.transport).toBe('http');
  });
});

describe('GET /api/tts-models', () => {
  it('列全部模型 + transport 标记(不漏 pricePerChar/modelId)', async () => {
    const r = await client.post('/api/jobs/estimate', { type: 'tts', text: 'x', voiceRef: 'longjing' }); // warm auth
    expect(r.status).toBe(200);
    const m = await client.get('/api/tts-models');
    expect(m.status).toBe(200);
    expect(m.body.models.length).toBe(Object.keys(TTS_MODELS).length);
    const first = m.body.models[0];
    expect(first).toHaveProperty('transport');
    expect(first).not.toHaveProperty('pricePerChar');
    expect(first).not.toHaveProperty('modelId');
  });
});
