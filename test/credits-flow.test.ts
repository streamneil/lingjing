// 灵镜 Slice 3 集成 —— 生成流程的积分扣减:成功 settle、失败 release。
// mock 网关:script 含 BOOM → 崩(应 release);其它成功(应 settle)。

import { describe, it, expect, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.BAICHUAN_AVATAR_MODEL = 'test-model';

vi.mock('../src/gateway/baichuan.js', () => ({
  getGateway: () => ({
    async submitVideo(input: { script: string }) {
      if (input.script.includes('BOOM')) throw new Error('mock 崩');
      return 'ptask-' + Math.random().toString(36).slice(2);
    },
    async fetchJobStatus() {
      return { status: 'succeeded', videoUrl: 'http://fake/v.mp4', aiLabel: 'none' as const };
    },
  }),
}));

vi.mock('../src/storage/index.js', () => ({
  storage: {
    putObjectFromUrl: vi.fn(async (k: string) => k),
    getSignedUrl: vi.fn(async (k: string) => k),
  },
  getSignedUrl: vi.fn(async (k: string) => k),
}));

const { db } = await import('../src/db/index.js');
const { enqueueVideo } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');
const { grant, reserve, balance, estimateCost } = await import('../src/credits/index.js');

const T = 'flow-tenant';

function submit(script: string) {
  // 模拟 API 层:入队 + reserve(API 真实路径在 jobs.ts)
  const cost = estimateCost(script.length);
  const id = enqueueVideo({ avatarRef: 'a', voiceRef: 'v', script }, T);
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
