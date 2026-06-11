// 灵镜 — TTS 情绪 + 音高(T-TTS-EMOTION)。
//
// 覆盖:
//   - buildInstruction:情绪→指令短语、音高→升/降调短语、auto/0→空
//   - POST /jobs:情绪/音高对所有音色开放(系统音色经 instruct 模型落地),无需选品质模型
//   - 非法情绪 / 音高越界 → 400
//   - 通过时 emotion/pitch 入库;auto/0 不入库(byte-identical)
//   - /tts-models 吐 emotions(只 key/label)

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

vi.mock('../src/gateway/cosyvoice.js', () => ({
  createDesignedVoice: vi.fn(),
  createClonedVoice: vi.fn(),
  synthesizeSpeechHttp: vi.fn(),
}));

const { buildInstruction, getEmotion, getSpeed, getLanguage, EMOTIONS, SPEEDS, LANGUAGES } = await import('../src/gateway/tts-models.js');
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
  it('语速 → 指令短语;normal/未知 → 不加', () => {
    expect(buildInstruction(undefined, undefined, 'fast')).toContain('较快');
    expect(buildInstruction(undefined, undefined, 'slow')).toContain('缓慢');
    expect(buildInstruction(undefined, undefined, 'normal')).toBe('');
    expect(buildInstruction(undefined, undefined, 'nope')).toBe('');
  });
  it('情绪 + 语速 + 音高 → 三段拼接', () => {
    const s = buildInstruction('calm', 3, 'faster');
    expect(s).toContain('沉稳');
    expect(s).toContain('加快');
    expect(s).toContain('提高');
  });
  it('getSpeed 已知/未知', () => {
    expect(getSpeed('fast')?.label).toBe('快速');
    expect(getSpeed('nope')).toBeUndefined();
  });
  it('getLanguage 已知/未知(language_type 即 key)', () => {
    expect(getLanguage('English')?.label).toBe('英语');
    expect(getLanguage('Klingon')).toBeUndefined();
  });
});

describe('POST /api/jobs (tts) 情绪/音高', () => {
  // 全 Qwen-TTS:无品质模型;情绪/音高对所有音色开放(系统音色 worker 自动用 instruct 落地)
  it('情绪 + 无 model → 202(系统自动用 instruct)+ emotion 入库', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', emotion: 'cheerful' });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.emotion).toBe('cheerful');
  });

  it('音高 + 无 model → 202(系统自动用 instruct)+ pitch 入库', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', pitch: 5 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.pitch).toBe(5);
  });

  it('情绪 + 音高 → 202 + emotion/pitch 入库', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', emotion: 'cheerful', pitch: 3 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.emotion).toBe('cheerful');
    expect(inp.pitch).toBe(3);
  });

  it('auto + pitch 0 → 不入库(byte-identical)', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', emotion: 'auto', pitch: 0 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.emotion).toBeUndefined();
    expect(inp.pitch).toBeUndefined();
  });

  it('非法情绪 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'Cherry', emotion: 'rage' });
    expect(r.status).toBe(400);
  });

  it('音高越界(>12)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'Cherry', pitch: 20 });
    expect(r.status).toBe(400);
  });

  it('语速档位 → 202 + rate 入库;normal 不入库', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', rate: 'fast' });
    expect(r.status).toBe(202);
    expect(JSON.parse(getJob(r.body.id)!.input_json).rate).toBe('fast');
    const r2 = await client.post('/api/jobs', { type: 'tts', text: '测试', voiceRef: 'Cherry', rate: 'normal' });
    expect(JSON.parse(getJob(r2.body.id)!.input_json).rate).toBeUndefined();
  });

  it('非法语速档位 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'Cherry', rate: '2x' });
    expect(r.status).toBe(400);
  });

  it('语言 → 202 + language 入库;Auto 不入库', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'hello', voiceRef: 'Cherry', language: 'English' });
    expect(r.status).toBe(202);
    expect(JSON.parse(getJob(r.body.id)!.input_json).language).toBe('English');
    const r2 = await client.post('/api/jobs', { type: 'tts', text: '你好', voiceRef: 'Cherry', language: 'Auto' });
    expect(JSON.parse(getJob(r2.body.id)!.input_json).language).toBeUndefined();
  });

  it('非法语言 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'tts', text: 'x', voiceRef: 'Cherry', language: 'Klingon' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/tts-models emotions + speeds', () => {
  it('吐情绪 + 语速列表(只 key/label,不漏 instruction)', async () => {
    const m = await client.get('/api/tts-models');
    expect(m.body.emotions.length).toBe(Object.keys(EMOTIONS).length);
    expect(m.body.emotions[0]).toHaveProperty('label');
    expect(m.body.emotions[0]).not.toHaveProperty('instruction');
    expect(m.body.speeds.length).toBe(Object.keys(SPEEDS).length);
    expect(m.body.speeds[0]).toHaveProperty('label');
    expect(m.body.speeds[0]).not.toHaveProperty('instruction');
    expect(m.body.languages.length).toBe(Object.keys(LANGUAGES).length);
    expect(m.body.languages.find((l: { key: string }) => l.key === 'English').label).toBe('英语');
  });
});
