// 灵镜 — AI 音乐(Fun-Music)。
//
// 覆盖:
//   - generateMusic 体形(prompt/lyrics 二选一、gender)+ url/lyrics/duration 解析 + 非 200 抛错
//   - buildAiMusicJob 校验(mode、prompt/lyrics、纯音乐拒 gender/lyrics、越界、模型)
//   - 计价 estimateAiMusicCost + costFor('ai_music')(有/无 durationSnapshot)
//   - 钱路(reserve==settle 守恒):reserve=慷慨上限;settle 按实际秒且封顶 reserved(只退不补);失败 release
//   - /jobs/estimate(ai_music)≡ build(estimate==reserve)

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

vi.mock('../src/storage/index.js', () => ({
  storage: {
    putObject: vi.fn(async (k: string) => k),
    putObjectFromUrl: vi.fn(async (k: string) => k),
    getSignedUrl: vi.fn(async (k: string) => k),
  },
  getSignedUrl: vi.fn(async (k: string) => k),
}));

const { generateMusic } = await import('../src/gateway/fun-music.js');
const { db } = await import('../src/db/index.js');
const { estimateAiMusicCost, AI_MUSIC_RESERVE_SECONDS, costFor, grant, reserve, balance } = await import('../src/credits/index.js');
const { enqueueJob, getJob } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);
let tid = '';

const origFetch = globalThis.fetch;
beforeAll(async () => {
  const t = createTenant('音乐测试台');
  tid = t.id;
  createUser(t.id, 'musiccreator', 'pw123456', 'creator');
  grant(t.id, 100000);
  expect((await client.login('musiccreator', 'pw123456')).status).toBe(200);
}, 30000);

// ── gateway ──
describe('generateMusic', () => {
  beforeEach(() => { globalThis.fetch = origFetch; });

  it('成功:取 url/lyrics/duration;lyrics 优先(同传仅发 lyrics)', async () => {
    let body: any;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        output: { audio: { url: 'https://oss/song.mp3' }, extra_info: { lyrics: '[verse]词' } },
        usage: { duration: 180 },
      }), { status: 200 });
    }) as any;
    const r = await generateMusic({ model: 'fun-music-v1', prompt: 'p', lyrics: 'L', gender: 'male' });
    expect(r.url).toBe('https://oss/song.mp3');
    expect(r.lyrics).toBe('[verse]词');
    expect(r.duration).toBe(180);
    // lyrics 优先:body.input 有 lyrics 无 prompt;gender 透传
    expect(body.input.lyrics).toBe('L');
    expect(body.input.prompt).toBeUndefined();
    expect(body.input.gender).toBe('male');
  });

  it('仅 prompt:发 prompt 不发 lyrics', async () => {
    let body: any;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ output: { audio: { url: 'https://oss/i.mp3' } }, usage: { duration: 90 } }), { status: 200 });
    }) as any;
    const r = await generateMusic({ model: 'fun-music-v1', prompt: '纯音乐描述' });
    expect(body.input.prompt).toBe('纯音乐描述');
    expect(body.input.lyrics).toBeUndefined();
    expect(r.duration).toBe(90);
    expect(r.lyrics).toBe(''); // 无 extra_info → 空串
  });

  it('非 200(邀测未开通 AccessDenied)→ 抛可读错误透传原文', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'AccessDenied', message: 'Access denied.' }), { status: 403 }),
    ) as any;
    await expect(generateMusic({ model: 'fun-music-v1', prompt: 'p' })).rejects.toThrow('音乐生成失败');
  });

  it('无 audio.url → 抛错', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ output: {} }), { status: 200 })) as any;
    await expect(generateMusic({ model: 'fun-music-v1', prompt: 'p' })).rejects.toThrow('无音频');
  });
});

// ── 计价 ──
describe('estimateAiMusicCost / costFor', () => {
  it('按秒:200 秒 × 0.05 = 10', () => {
    expect(estimateAiMusicCost(200)).toBe(10);
  });
  it('MIN_COST 兜底:短曲仍 >=1', () => {
    expect(estimateAiMusicCost(1)).toBe(1);
  });
  it("costFor('ai_music') 有 durationSnapshot → 按实际秒", () => {
    expect(costFor('ai_music', { mode: 'song', durationSnapshot: 100 })).toBe(estimateAiMusicCost(100));
  });
  it("costFor('ai_music') 无快照 → 按慷慨上限(reserve 口径)", () => {
    expect(costFor('ai_music', { mode: 'song' })).toBe(estimateAiMusicCost(AI_MUSIC_RESERVE_SECONDS));
  });
});

// ── API 校验 ──
describe('POST /api/jobs (ai_music) 校验', () => {
  it('缺 mode → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_music', prompt: 'p' });
    expect(r.status).toBe(400);
  });
  it('歌曲缺 prompt+lyrics → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_music', mode: 'song' });
    expect(r.status).toBe(400);
  });
  it('歌曲 prompt → 202 + cost=reserve 口径', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_music', mode: 'song', prompt: '夏日清新民谣', gender: 'female' });
    expect(r.status).toBe(202);
    expect(r.body.cost).toBe(estimateAiMusicCost(AI_MUSIC_RESERVE_SECONDS));
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.mode).toBe('song');
    expect(inp.gender).toBe('female');
  });
  it('纯音乐带 gender → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_music', mode: 'instrumental', prompt: 'p', gender: 'male' });
    expect(r.status).toBe(400);
  });
  it('纯音乐带 lyrics → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_music', mode: 'instrumental', prompt: 'p', lyrics: '词词词词词' });
    expect(r.status).toBe(400);
  });
  it('非法模型 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_music', mode: 'song', prompt: 'p', model: 'no-such' });
    expect(r.status).toBe(400);
  });
  it('estimate ≡ build(reserve==settle 同口径)', async () => {
    const est = await client.post('/api/jobs/estimate', { type: 'ai_music', mode: 'song' });
    const job = await client.post('/api/jobs', { type: 'ai_music', mode: 'song', prompt: 'x' });
    expect(est.body.cost).toBe(job.body.cost);
  });
});

// ── 钱路:reserve / settle(封顶)/ release ──
describe('AI 音乐钱路(只退不补,绝不负余额)', () => {
  const T = 'music-flow';
  beforeEach(() => {
    db.prepare('DELETE FROM credit_ledger').run();
    db.prepare('DELETE FROM job').run();
    grant(T, 1000);
    globalThis.fetch = origFetch;
  });

  function submit(input: any, durationReturned: number, fail = false) {
    const cost = estimateAiMusicCost(AI_MUSIC_RESERVE_SECONDS); // reserve 上限
    const id = enqueueJob('ai_music', input, T);
    reserve(T, id, cost);
    globalThis.fetch = vi.fn(async () => {
      if (fail) return new Response(JSON.stringify({ code: 'AccessDenied', message: 'denied' }), { status: 403 });
      return new Response(JSON.stringify({ output: { audio: { url: 'https://oss/x.mp3' }, extra_info: { lyrics: 'L' } }, usage: { duration: durationReturned } }), { status: 200 });
    }) as any;
    return { id, reserved: cost };
  }

  it('短曲(实际 < 预估)→ 按实际结算,退差额', async () => {
    const { reserved } = submit({ mode: 'song', prompt: 'p' }, 100); // 100s < 240s 上限
    await tick();
    const actual = estimateAiMusicCost(100);
    expect(actual).toBeLessThan(reserved);
    expect(balance(T)).toBe(1000 - actual); // 退了差额
  });

  it('长于预估(实际 > reserved)→ 封顶 reserved,绝不多扣(只退不补)', async () => {
    const { reserved } = submit({ mode: 'song', prompt: 'p' }, 99999); // 远超上限
    await tick();
    expect(balance(T)).toBe(1000 - reserved); // 封顶=reserved,不会扣更多
  });

  it('生成失败(未开通)→ release 全退', async () => {
    submit({ mode: 'song', prompt: 'p' }, 0, true);
    await tick();
    expect(balance(T)).toBe(1000); // 失败不扣
  });

  it('成功后 durationSnapshot/lyricsResult 写回 input', async () => {
    const { id } = submit({ mode: 'song', prompt: 'p' }, 150);
    await tick();
    const inp = JSON.parse(getJob(id)!.input_json);
    expect(inp.durationSnapshot).toBe(150);
    expect(inp.lyricsResult).toBe('L');
    expect(getJob(id)!.output_kind).toBe('audio');
  });
});
