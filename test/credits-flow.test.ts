// 灵镜 Slice 3 集成 —— 生成流程的积分扣减:成功 settle、失败 release。
// mock 网关:script 含 BOOM → 崩(应 release);其它成功(应 settle)。

import { describe, it, expect, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.BAICHUAN_AVATAR_MODEL = 'test-model';

// TTS mock:BOOM 文案抛错(模拟链路某步失败),其它出假音频
vi.mock('../src/gateway/cosyvoice.js', () => ({
  synthesizeSpeech: vi.fn(async (p: { text: string }) => {
    if (p.text.includes('BOOM')) throw new Error('mock 崩');
    return Buffer.from('fake-audio');
  }),
}));

vi.mock('../src/gateway/baichuan.js', () => ({
  getGateway: () => ({
    async submitVideo() {
      return 'ptask-' + Math.random().toString(36).slice(2);
    },
    async fetchJobStatus() {
      return { status: 'succeeded', videoUrl: 'http://fake/v.mp4', aiLabel: 'none' as const };
    },
  }),
}));

vi.mock('../src/storage/index.js', () => ({
  storage: {
    putObject: vi.fn(async (k: string) => k),
    putObjectFromUrl: vi.fn(async (k: string) => k),
    getSignedUrl: vi.fn(async (k: string) => k),
  },
  getSignedUrl: vi.fn(async (k: string) => k),
}));

vi.mock('../src/pipeline/ai-label.js', () => ({
  applyAiLabel: vi.fn(async (buf: Buffer) => ({ buffer: buf, applied: true })),
  probeAudioDuration: vi.fn(async () => 5),
}));

const _realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (typeof url === 'string' && url.startsWith('http://fake/')) {
    return new Response(Buffer.from('fake-video-bytes'), { status: 200 });
  }
  return _realFetch(url, init);
}) as typeof fetch;

const { db } = await import('../src/db/index.js');
const { enqueueVideo } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');
const { grant, reserve, balance, estimateCost } = await import('../src/credits/index.js');

const T = 'flow-tenant';

function submit(script: string) {
  // 模拟 API 层:入队 + reserve(API 真实路径在 jobs.ts)
  const cost = estimateCost(script.length);
  const id = enqueueVideo({ avatarRef: 'preset-1', voiceRef: 'longjing', script }, T);
  reserve(T, id, cost);
  return { id, cost };
}

describe('生成流程积分扣减', () => {
  it('成功生成:settle,余额 = 发放 - 实扣', async () => {
    db.prepare('DELETE FROM credit_ledger').run();
    grant(T, 1000);
    const { cost } = submit('一条正常的播报文案,字数适中。');
    await tick();
    expect(balance(T)).toBe(1000 - cost);
  });

  it('失败生成:release,余额回到发放值(失败不扣)', async () => {
    db.prepare('DELETE FROM credit_ledger').run();
    grant(T, 1000);
    submit('BOOM 这条会崩');
    await tick();
    expect(balance(T)).toBe(1000);
  });
});
