// 灵镜 — TTS 情绪 + 音高(T-TTS-EMOTION)。
//
// 覆盖:
//   - buildInstruction:情绪→指令短语、音高→升/降调短语、auto/0→空
//   - POST /jobs:情绪/音高仅 supportsInstruction 模型可用,否则 400
//   - 非法情绪 / 音高越界 → 400
//   - 通过时 emotion/pitch 入库;auto/0 不入库(byte-identical)
//   - /tts-models 吐 emotions(只 key/label)

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

vi.mock('../src/gateway/cosyvoice.js', () => ({
  createDesignedVoice: vi.fn(),
  createClonedVoice: vi.fn(),
  synthesizeSpeech: vi.fn(),
  synthesizeSpeechHttp: vi.fn(),
}));

const { buildInstruction, getEmotion, EMOTIONS } = await import('../src/gateway/tts-models.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);

beforeAll(async () => {
  const t = createTenant('情绪测试台');
  createUser(t.id, 'emocreator', 'pw123456', 'creator');
  grant(t.id, 100000);
  expect((await client.login('emocreator', 'pw123456')).status).toBe(200);
}, 30000);

describe('buildInstruction', () => {
  it('情绪 → 指令短语', () => {
    expect(buildInstruction('cheerful')).toContain('开朗');
  });
  it('音高 >0 → 升调、<0 → 降调', () => {
    expect(buildInstruction(undefined, 3)).toContain('提高');
    expect(buildInstruction(undefined, -3)).toContain('压低');
  });
  it('情绪+音高 → 两段拼接', () => {
    const s = buildInstruction('calm', 2);
    expect(s).toContain('沉稳');
    expect(s).toContain('提高');
  });
  it('auto / 0 / 空 → 空串', () => {
    expect(buildInstruction('auto', 0)).toBe('');
    expect(buildInstruction(undefined, undefined)).toBe('');
  });
  it('getEmotion 未知 → undefined', () => {
    expect(getEmotion('nope')).toBeUndefined();
    expect(getEmotion('cheerful')?.label).toBe('开朗');
  });
});

describe('POST /api/jobs (tts) 情绪/音高', () => {
  it('情绪 + 非指令模型(cosyvoice-v1)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'longjing', model: 'cosyvoice-v1', emotion: 'cheerful' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('指令');
  });

  it('音高 + 默认模型(无 model = 无指令能力)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'longjing', pitch: 5 });
    expect(r.status).toBe(400);
  });

  it('情绪 + 指令模型(v3.5-flash)→ 202 + emotion/pitch 入库', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'longjing', model: 'cosyvoice-v3.5-flash', emotion: 'cheerful', pitch: 3 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.emotion).toBe('cheerful');
    expect(inp.pitch).toBe(3);
  });

  it('auto + pitch 0 + 指令模型 → 不入库(byte-identical)', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'longjing', model: 'cosyvoice-v3.5-flash', emotion: 'auto', pitch: 0 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.emotion).toBeUndefined();
    expect(inp.pitch).toBeUndefined();
  });

  it('非法情绪 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'longjing', model: 'cosyvoice-v3.5-flash', emotion: 'rage' });
    expect(r.status).toBe(400);
  });

  it('音高越界(>12)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'longjing', model: 'cosyvoice-v3.5-flash', pitch: 20 });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/tts-models emotions', () => {
  it('吐情绪列表(只 key/label,不漏 instruction)', async () => {
    const m = await client.get('/api/tts-models');
    expect(m.body.emotions.length).toBe(Object.keys(EMOTIONS).length);
    expect(m.body.emotions[0]).toHaveProperty('label');
    expect(m.body.emotions[0]).not.toHaveProperty('instruction');
  });
});
