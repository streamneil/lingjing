// 灵镜 pollUntilDone 单测(eng-review CQ1)—— 抽出的共享轮询循环全路径覆盖。
//
// renderSegment / runImageGenJob / runVideoT2VJob 三处共用它,改了现有工作代码 →
// 这份单测 + 现有 worker 集成测(s2v/图片轮询不变)一起守回归(IRON RULE)。
//
// 覆盖:pending→running→succeeded(返结果)、连续 failed(throw)、超 deadline(throw,
// sawRunning 区分「排队/生成」文案)、onProgress 映射(running→50、其它→5、有 progress 用真值)。

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.POLL_INTERVAL_MS = '1'; // 轮询间隔压到 1ms,单测快(模块加载时读)

const { pollUntilDone } = await import('../src/queue/worker.js');

const farDeadline = () => Date.now() + 60_000;

describe('pollUntilDone 全路径', () => {
  it('pending → running → succeeded:返成功结果(调用方取自己的字段)', async () => {
    const seq = [
      { status: 'pending' as const },
      { status: 'running' as const },
      { status: 'succeeded' as const, videoUrl: 'https://x/v.mp4' },
    ];
    let i = 0;
    const r = await pollUntilDone(async () => seq[i++]!, () => {}, farDeadline());
    expect(r.status).toBe('succeeded');
    expect((r as any).videoUrl).toBe('https://x/v.mp4');
  });

  it('failed → 抛 error(用厂商 error 文案)', async () => {
    await expect(
      pollUntilDone(async () => ({ status: 'failed' as const, error: '厂商炸了' }), () => {}, farDeadline()),
    ).rejects.toThrow('厂商炸了');
  });

  it('failed 无 error → 抛默认文案', async () => {
    await expect(
      pollUntilDone(async () => ({ status: 'failed' as const }), () => {}, farDeadline()),
    ).rejects.toThrow('厂商任务失败');
  });

  it('超 deadline 且从未 running → 抛「排队超时」', async () => {
    await expect(
      pollUntilDone(async () => ({ status: 'pending' as const }), () => {}, Date.now() - 1),
    ).rejects.toThrow('排队超时');
  });

  it('超 deadline 且曾 running → 抛「生成超时」', async () => {
    // 先返一次 running(置 sawRunning),下一轮 deadline 已过。
    let first = true;
    const deadline = Date.now() + 5;
    await expect(
      pollUntilDone(
        async () => {
          if (first) { first = false; return { status: 'running' as const }; }
          await new Promise((r) => setTimeout(r, 10)); // 拖过 deadline
          return { status: 'running' as const };
        },
        () => {},
        deadline,
      ),
    ).rejects.toThrow('生成超时');
  });

  it('onProgress 映射:有 progress 用真值、running→50、其它→5(succeeded 那轮也先调 onProgress 再 return)', async () => {
    const seen: number[] = [];
    const seq = [
      { status: 'pending' as const }, // → 5
      { status: 'running' as const }, // → 50
      { status: 'running' as const, progress: 73 }, // → 73
      { status: 'succeeded' as const }, // → 5(succeeded 无 progress、非 running)然后 return
    ];
    let i = 0;
    await pollUntilDone(async () => seq[i++]!, (p) => seen.push(p), farDeadline());
    expect(seen).toEqual([5, 50, 73, 5]);
  });
});
