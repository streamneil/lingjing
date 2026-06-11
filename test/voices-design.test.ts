// 灵镜 — 声音设计服务 + POST /voices/design 端点测试(Lane B,eng-review E4/E5)。
//
// 覆盖:
//   - createDesignVoice 入库 kind=design、status=ready、无授权(authorization_id null)
//   - countCustomVoices / countRecentDesignVoices 配额 helper
//   - POST /voices/design:未登录 401、viewer 403、空/超长 prompt 400、
//     总数上限 429、频率上限 429、正常 201 + previewUrl + 入库 kind=design

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

// gateway mock:createDesignedVoice 不打 Qwen,返假 voice id + 预览 buffer
vi.mock('../src/gateway/cosyvoice.js', () => ({
  createDesignedVoice: vi.fn(async (prompt: string) => {
    if (prompt.includes('BOOM')) throw new Error('Qwen mock 崩');
    return { voiceId: 'qwen-design-' + Math.random().toString(36).slice(2, 7), previewAudio: Buffer.from('preview') };
  }),
  // 其余被 server import 链间接引用的导出留空 stub(本测试不触发合成)
  createClonedVoice: vi.fn(),
  synthesizeSpeechHttp: vi.fn(),
}));

// storage mock:putObject/getSignedUrl identity(不打 MinIO)
vi.mock('../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/index.js')>('../src/storage/index.js');
  return {
    ...actual,
    putObject: vi.fn(async (k: string) => k),
    getSignedUrl: vi.fn(async (k: string) => 'https://signed/' + k),
  };
});

const { db } = await import('../src/db/index.js');
const voices = await import('../src/voices/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const creator = new Client(app);
const viewer = new Client(app);

let tid = '';

beforeAll(async () => {
  const t = createTenant('设计测试台');
  tid = t.id;
  createUser(t.id, 'dgcreator', 'pw123456', 'creator');
  createUser(t.id, 'dgviewer', 'pw123456', 'viewer');
  expect((await creator.login('dgcreator', 'pw123456')).status).toBe(200);
  expect((await viewer.login('dgviewer', 'pw123456')).status).toBe(200);
}, 30000);

beforeEach(() => {
  db.prepare('DELETE FROM voice').run();
});

describe('createDesignVoice 服务', () => {
  it('入库 kind=design、ready、无授权', () => {
    const v = voices.createDesignVoice({ tenantId: tid, name: '温柔女声', providerVoiceId: 'qwen-x' });
    expect(v.kind).toBe('design');
    expect(v.status).toBe('ready');
    expect(v.provider_voice_id).toBe('qwen-x');
    expect(v.authorization_id).toBeNull(); // 合成音色无真人,无授权存证
    expect(voices.isUsableVoice(v.id, tid)).toBe(true);
  });
  it('countCustomVoices 计克隆+设计', () => {
    voices.createDesignVoice({ tenantId: tid, name: 'a', providerVoiceId: 'q1' });
    voices.createCloneVoice({ tenantId: tid, userId: 'u', name: 'b', sourceKey: 'k', consent: true, providerVoiceId: 'c1' });
    expect(voices.countCustomVoices(tid)).toBe(2);
  });
  it('countRecentDesignVoices 只计窗口内设计', () => {
    voices.createDesignVoice({ tenantId: tid, name: 'a', providerVoiceId: 'q1' });
    expect(voices.countRecentDesignVoices(tid, 60_000)).toBe(1); // 近 1 分钟内 → 计入
    expect(voices.countRecentDesignVoices(tid, -1)).toBe(0); // since=now+1,无任何 created_at 满足 → 0
  });
});

describe('POST /api/voices/design', () => {
  it('未登录 → 401', async () => {
    const c = new Client(app);
    const r = await c.post('/api/voices/design', { name: 'x', voicePrompt: '年轻女声' });
    expect(r.status).toBe(401);
  });

  it('viewer → 403', async () => {
    const r = await viewer.post('/api/voices/design', { name: 'x', voicePrompt: '年轻女声' });
    expect(r.status).toBe(403);
  });

  it('空 voicePrompt → 400', async () => {
    const r = await creator.post('/api/voices/design', { name: 'x', voicePrompt: '   ' });
    expect(r.status).toBe(400);
  });

  it('超长 voicePrompt(>2048)→ 400', async () => {
    const r = await creator.post('/api/voices/design', { name: 'x', voicePrompt: '声'.repeat(2049) });
    expect(r.status).toBe(400);
  });

  it('正常 → 201 + previewUrl + 入库 kind=design', async () => {
    const r = await creator.post('/api/voices/design', { name: '我的设计', voicePrompt: '年轻活泼的女声,语速偏快' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('ready');
    expect(r.body.previewUrl).toContain('signed');
    const v = voices.getVoice(r.body.id, tid);
    expect(v?.kind).toBe('design');
  });

  it('总数上限 → 429', async () => {
    // 直插 50 个自建音色顶满配额
    for (let i = 0; i < 50; i++)
      voices.createDesignVoice({ tenantId: tid, name: 'q' + i, providerVoiceId: 'q' + i });
    const r = await creator.post('/api/voices/design', { name: 'x', voicePrompt: '年轻女声' });
    expect(r.status).toBe(429);
    expect(r.body.error).toContain('上限');
  });

  it('创建频率上限 → 429', async () => {
    // 窗口内已有 5 个设计(频率上限),再建 → 429(未顶总数上限)
    for (let i = 0; i < 5; i++)
      voices.createDesignVoice({ tenantId: tid, name: 'r' + i, providerVoiceId: 'r' + i });
    const r = await creator.post('/api/voices/design', { name: 'x', voicePrompt: '年轻女声' });
    expect(r.status).toBe(429);
    expect(r.body.error).toContain('频繁');
  });
});
