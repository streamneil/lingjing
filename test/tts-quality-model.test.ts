// 灵镜 — TTS 全 Qwen-TTS:无品质模型 + 扁价 + 情绪驱动 flash/instruct。
//
// 钱路重点(reserve==settle):
//   - estimateTtsCost(len) 扁价 0.02/字(byte-identical)
//   - estimateTtsCost(len, pricePerChar) 仍按传入单价(遗留 job 快照回放)
//   - costFor('tts') 有遗留快照按快照、无快照回落扁价
//   - buildTtsJob 恒扁价、input 无 model/快照
//   - resolveVoice(withEmotion) 按情绪选 instruct/flash,全 http(无 transport 字段)

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

vi.mock('../src/gateway/cosyvoice.js', () => ({
  createDesignedVoice: vi.fn(async () => ({ voiceId: 'qwen-design-x', previewAudio: Buffer.from('p') })),
  createClonedVoice: vi.fn(),
  synthesizeSpeechHttp: vi.fn(),
}));

const { db } = await import('../src/db/index.js');
const { estimateTtsCost, costFor } = await import('../src/credits/index.js');
const { resolveVoice } = await import('../src/queue/worker.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const voices = await import('../src/voices/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);
let tid = '';
let uid = '';

beforeAll(async () => {
  const t = createTenant('品质测试台');
  tid = t.id;
  uid = (await createUser(t.id, 'qmcreator', 'pw123456', 'creator')).id;
  grant(t.id, 100000);
  expect((await client.login('qmcreator', 'pw123456')).status).toBe(200);
}, 30000);

describe('estimateTtsCost 扁价', () => {
  it('默认单价 0.02:100字 × 0.02 = 2', () => {
    expect(estimateTtsCost(100)).toBe(2);
  });
  it('遗留快照单价仍生效:100字 × 0.05 = 5', () => {
    expect(estimateTtsCost(100, 0.05)).toBe(5);
  });
  it('MIN_COST 兜底:短文本仍 >=1', () => {
    expect(estimateTtsCost(5, 0.02)).toBe(1);
  });
});

describe("costFor('tts') 读快照", () => {
  it('有遗留 pricePerCharSnapshot → 按快照算', () => {
    expect(costFor('tts', { text: '字'.repeat(100), pricePerCharSnapshot: 0.05 })).toBe(5);
  });
  it('无快照 → 扁价', () => {
    expect(costFor('tts', { text: '字'.repeat(100) })).toBe(2);
  });
});

describe('POST /api/jobs (tts) 全扁价无品质模型', () => {
  it('cost 扁价 + input 无 model/快照(byte-identical)', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '字'.repeat(100), voiceRef: 'Cherry' });
    expect(r.status).toBe(202);
    expect(r.body.cost).toBe(2);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.model).toBeUndefined();
    expect(inp.pricePerCharSnapshot).toBeUndefined();
  });

  it('带情绪 → cost 仍扁价 2(情绪不影响计价)+ input 存 emotion', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '字'.repeat(100), voiceRef: 'Cherry', emotion: 'cheerful' });
    expect(r.status).toBe(202);
    expect(r.body.cost).toBe(2);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.emotion).toBe('cheerful');
    expect(inp.model).toBeUndefined();
  });

  it('estimate ≡ build(reserve==settle):同参 cost 一致', async () => {
    const body = { type: 'tts', text: '字'.repeat(100), voiceRef: 'Cherry', emotion: 'cheerful' };
    const est = await client.post('/api/jobs/estimate', body);
    const job = await client.post('/api/jobs', body);
    expect(est.body.cost).toBe(job.body.cost);
    expect(est.body.cost).toBe(2);
  });

  it('无 model 字段被接受(品质下拉已移除,旧 model 入参忽略不报错或不影响计价)', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry' });
    expect(r.status).toBe(202);
  });
});

describe('resolveVoice(withEmotion) 按情绪选模型,全 http', () => {
  beforeEach(() => db.prepare('DELETE FROM voice').run());

  it('预置 + 无情绪 → qwenTtsModel(flash)', () => {
    const r = resolveVoice('Cherry', tid, false);
    expect(r.model).toBe(config.baichuan.qwenTtsModel);
    expect(r.voice).toBe('Cherry');
    expect((r as Record<string, unknown>).transport).toBeUndefined();
  });

  it('预置 + 带情绪 → qwenInstructModel(instruct)', () => {
    const r = resolveVoice('Cherry', tid, true);
    expect(r.model).toBe(config.baichuan.qwenInstructModel);
  });

  it('设计音色 → designModel(用 provider_voice_id),情绪忽略', () => {
    const dv = voices.createDesignVoice({ tenantId: tid, name: 'd', providerVoiceId: 'qv', userId: uid });
    const r = resolveVoice(dv.id, tid, true);
    expect(r.model).toBe(config.baichuan.designModel);
    expect(r.voice).toBe('qv');
  });

  it('克隆音色 → vcModel(用 provider_voice_id),情绪忽略', () => {
    const id = `v-clone-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,provider_voice_id,authorization_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, tid, 'c', 'clone', 'ready', null, 'qcv', null, Date.now());
    const r = resolveVoice(id, tid, true);
    expect(r.model).toBe(config.baichuan.vcModel);
    expect(r.voice).toBe('qcv');
  });
});

describe('GET /api/tts-models', () => {
  it('只吐 emotions(无 models 品质列表)', async () => {
    const m = await client.get('/api/tts-models');
    expect(m.status).toBe(200);
    expect(m.body.models).toBeUndefined();
    expect(Array.isArray(m.body.emotions)).toBe(true);
    expect(m.body.emotions[0]).toHaveProperty('key');
    expect(m.body.emotions[0]).toHaveProperty('label');
  });
});
