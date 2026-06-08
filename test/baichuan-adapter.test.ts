// 灵镜 百炼 adapter 测试 —— 隔离 globalThis.fetch spy 的专用文件。
//
// 为什么独立:这些测试 mock 进程级 globalThis.fetch。vitest 并行跑多文件时,若 fetch spy
// 残留(尤其"永不 resolve"的超时测试),会泄漏到其它文件的真实 fetch 调用(rbac /estimate 偶发失败)。
// 放独立文件 + 每测 afterEach 还原,把 fetch 污染面收窄到本文件。
//
// 覆盖:文生图 fetchImageStatus(results[] 数组)+ 图生图 editImage(同步 choices[].content[].image
// + AbortController 超时命脉,eng-review E2)。

import { describe, it, expect, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { BaichuanGateway } = await import('../src/gateway/baichuan.js');

afterEach(() => vi.restoreAllMocks());

describe('文生图 fetchImageStatus 解析 results[] 数组(外部声音 P2)', () => {
  it('SUCCEEDED → output.results[].url 多图(非 video_url 对象)', async () => {
    const gw = new BaichuanGateway();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ url: 'https://dashscope/a.png' }, { url: 'https://dashscope/b.png' }],
          },
        }),
        { status: 200 },
      ),
    );
    const r = await gw.fetchImageStatus('task-1');
    expect(r.status).toBe('succeeded');
    expect(r.imageUrls).toEqual(['https://dashscope/a.png', 'https://dashscope/b.png']);
  });

  it('FAILED → status failed + error', async () => {
    const gw = new BaichuanGateway();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: { task_status: 'FAILED', message: '内容违规' } }), { status: 200 }),
    );
    const r = await gw.fetchImageStatus('task-2');
    expect(r.status).toBe('failed');
    expect(r.error).toContain('内容违规');
  });
});

describe('图生图 editImage 同步解析 + AbortController 超时(E2 命脉)', () => {
  it('同步返回 → output.choices[0].message.content[].image(非 results[])', async () => {
    const gw = new BaichuanGateway();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://edit/a.png' }] } }] } }),
        { status: 200 },
      ),
    );
    const urls = await gw.editImage(
      { imageUrls: ['https://in/1.png'], prompt: '换背景' },
      new AbortController().signal,
    );
    expect(urls).toEqual(['https://edit/a.png']);
  });

  it('空 content → 抛错(内容被拒)', async () => {
    const gw = new BaichuanGateway();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: { choices: [{ message: { content: [] } }] } }), { status: 200 }),
    );
    await expect(
      gw.editImage({ imageUrls: ['https://in/1.png'], prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow();
  });

  it('命脉:已 abort 的 signal → fetch 立即 reject AbortError → editImage 抛错(worker 据此 markFailed+release,不冻)', async () => {
    const gw = new BaichuanGateway();
    // mock fetch:模拟真实 fetch 对 aborted signal 的行为 —— 立即 reject(不留 pending promise,
    // 避免 spy 在并行跑时泄漏成"挂起"污染别的文件)。先 abort 再调,语义等价于"超时已触发"。
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const sig = (opts as RequestInit | undefined)?.signal;
      if (sig?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const ac = new AbortController();
    ac.abort(); // 模拟硬超时已触发
    await expect(
      gw.editImage({ imageUrls: ['https://in/1.png'], prompt: 'x' }, ac.signal),
    ).rejects.toThrow();
  });
});
