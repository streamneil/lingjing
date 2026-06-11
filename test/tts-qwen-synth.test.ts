// 灵镜 — Qwen-TTS HTTP 合成 + transport 路由测试(Lane A,eng-review E1/E2)。
//
// 覆盖:
//   - synthesizeSpeechHttp 双解析:output.audio.url(fetch)→Buffer | output.audio.data(base64)→Buffer
//   - synthesizeSpeechHttp HTTP 错误 / 无音频 → throw
//   - resolveVoice transport 路由:design→http+designModel、clone→ws+cloneModel、preset→ws+ttsModel
//   - 回退:provider_voice_id 空 → 预置回退(ws)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { db } = await import('../src/db/index.js');
const { config } = await import('../src/config.js');
const { synthesizeSpeechHttp } = await import('../src/gateway/cosyvoice.js');
const { resolveVoice } = await import('../src/queue/worker.js');

const T = 'qwen-tenant';
const now = () => Date.now();

// 直插 voice 行(绕过 service,精确控制 kind/provider_voice_id)
function insertVoice(kind: 'clone' | 'design', providerVoiceId: string | null) {
  const id = `v-${kind}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,provider_voice_id,authorization_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, T, kind, kind, 'ready', null, providerVoiceId, null, now());
  return id;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});
beforeEach(() => {
  db.prepare('DELETE FROM voice').run();
});

describe('synthesizeSpeechHttp:双解析', () => {
  it('output.audio.url → fetch 拉取成 Buffer', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('multimodal-generation')) {
        return new Response(JSON.stringify({ output: { audio: { url: 'https://signed/a.wav' } } }), {
          status: 200,
        });
      }
      // 第二次:拉音频 URL
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as any;

    const buf = await synthesizeSpeechHttp({ text: '你好', voice: 'qwen-v-1', model: 'qwen3-tts-vd-x' });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(4);
    expect(calls.some((u) => u.includes('multimodal-generation'))).toBe(true);
    expect(calls.some((u) => u === 'https://signed/a.wav')).toBe(true);
  });

  it('output.audio.data(base64)→ decode 成 Buffer(不再 fetch)', async () => {
    const b64 = Buffer.from('FAKE-AUDIO').toString('base64');
    let fetchCount = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ output: { audio: { data: b64 } } }), { status: 200 });
    }) as any;

    const buf = await synthesizeSpeechHttp({ text: '你好', voice: 'qwen-v-1', model: 'qwen3-tts-vd-x' });
    expect(buf.toString()).toBe('FAKE-AUDIO');
    expect(fetchCount).toBe(1); // 内联:只调一次(不二次 fetch url)
  });

  it('HTTP 非 200 → throw', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: '配额不足' }), { status: 429 }),
    ) as any;
    await expect(
      synthesizeSpeechHttp({ text: 'x', voice: 'v', model: 'm' }),
    ).rejects.toThrow('Qwen-TTS 合成失败');
  });

  it('无 audio.url/data → throw', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ output: {} }), { status: 200 }),
    ) as any;
    await expect(synthesizeSpeechHttp({ text: 'x', voice: 'v', model: 'm' })).rejects.toThrow('无音频');
  });
});

describe('resolveVoice:transport 路由', () => {
  it('预置(Qwen 音色)→ http + qwenTtsModel', () => {
    const r = resolveVoice('Cherry', T);
    expect(r.transport).toBe('http');
    expect(r.model).toBe(config.baichuan.qwenTtsModel);
    expect(r.voice).toBe('Cherry');
  });

  it('克隆 → ws + cloneModel(用 provider_voice_id)', () => {
    const id = insertVoice('clone', 'cosyvoice-v1-x-abc');
    const r = resolveVoice(id, T);
    expect(r.transport).toBe('ws');
    expect(r.model).toBe(config.baichuan.cloneModel);
    expect(r.voice).toBe('cosyvoice-v1-x-abc');
  });

  it('设计 → http + designModel(用 provider_voice_id)', () => {
    const id = insertVoice('design', 'qwen-voice-xyz');
    const r = resolveVoice(id, T);
    expect(r.transport).toBe('http');
    expect(r.model).toBe(config.baichuan.designModel);
    expect(r.voice).toBe('qwen-voice-xyz');
  });

  it('provider_voice_id 空 → 回退预置(Qwen,http)', () => {
    const id = insertVoice('design', null);
    const r = resolveVoice(id, T);
    expect(r.transport).toBe('http');
    expect(r.model).toBe(config.baichuan.qwenTtsModel);
  });
});
