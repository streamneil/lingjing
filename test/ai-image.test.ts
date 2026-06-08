// 灵镜 AI 图片(文生图)后端测试 —— 计价 / n clamp / 工具分发 / 多图输出兼容。
//
// 覆盖 /plan-eng-review 测试覆盖图的图片相关 GAP:
//   - costFor('ai_image') 计价 + n clamp [1,4]
//   - costFor('video') 不变(回归)
//   - 未知 type 计价抛错(防御)
//   - signOutputUrls 多图 / 单视频向后兼容(裸字符串)
//   - enqueueJob 写对 type;markDone 写对 output_kind

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { costFor, estimateImageCost, clampImageCount, estimateCost } = await import(
  '../src/credits/index.js'
);
const { enqueueJob, markDone, getJob } = await import('../src/queue/index.js');

describe('AI 图片计价(costFor / estimateImageCost / clampImageCount)', () => {
  it('clampImageCount:夹到 [1,4],非法值兜底 1', () => {
    expect(clampImageCount(1)).toBe(1);
    expect(clampImageCount(4)).toBe(4);
    expect(clampImageCount(0)).toBe(1);
    expect(clampImageCount(5)).toBe(4);
    expect(clampImageCount(-3)).toBe(1);
    expect(clampImageCount(2.9)).toBe(2); // floor
    expect(clampImageCount(undefined)).toBe(1);
    expect(clampImageCount('x' as unknown)).toBe(1);
    expect(clampImageCount(NaN)).toBe(1);
  });

  it('estimateImageCost:图数 × 分辨率系数,n 先 clamp', () => {
    expect(estimateImageCost(1, '1K')).toBe(4); // 1*4*1
    expect(estimateImageCost(2, '1K')).toBe(8); // 2*4*1
    expect(estimateImageCost(4, '2K')).toBe(24); // 4*4*1.5
    expect(estimateImageCost(5, '1K')).toBe(16); // clamp 5→4 → 4*4*1
    expect(estimateImageCost(1, '4K')).toBe(10); // 1*4*2.5
  });

  it("costFor('ai_image') = estimateImageCost(count,resolution)", () => {
    expect(costFor('ai_image', { count: 2, resolution: '1K' })).toBe(estimateImageCost(2, '1K'));
    expect(costFor('ai_image', { count: 5, resolution: '2K' })).toBe(estimateImageCost(5, '2K')); // clamp
    expect(costFor('ai_image', {})).toBe(estimateImageCost(1, '1K')); // 默认 1 张 1K
  });

  it("costFor('video') 与 estimateCost 一致(回归,视频计价不变)", () => {
    expect(costFor('video', { script: 'a'.repeat(100), resolution: '720P' })).toBe(
      estimateCost(100, '720P'),
    );
    expect(costFor('video', {})).toBe(estimateCost(0)); // 空脚本→MIN_COST
  });

  it('未知 type 计价抛错(防御)', () => {
    expect(() => costFor('__proto__', {})).toThrow();
    expect(() => costFor('nope', {})).toThrow();
  });
});

describe('队列:enqueueJob type + markDone output_kind', () => {
  const T = 'tenant-img-test';
  beforeEach(() => {
    db.prepare('DELETE FROM job').run();
  });

  it('enqueueJob 写对 type;markDone 写对 output_kind 与 JSON output_url', () => {
    const id = enqueueJob('ai_image', { prompt: '一只猫', count: 2 }, T);
    let row = getJob(id)!;
    expect(row.type).toBe('ai_image');
    expect(row.output_kind).toBe('video'); // 默认值(未完成)

    markDone(id, JSON.stringify(['images/t/a.png', 'images/t/b.png']), 'none', 'image');
    row = getJob(id)!;
    expect(row.status).toBe('done');
    expect(row.output_kind).toBe('image');
    expect(JSON.parse(row.output_url!)).toEqual(['images/t/a.png', 'images/t/b.png']);
  });

  it('enqueueVideo 仍写 type=video(回归)', async () => {
    const { enqueueVideo } = await import('../src/queue/index.js');
    const id = enqueueVideo({ avatarRef: 'a', voiceRef: 'v', script: 's' } as never, T);
    expect(getJob(id)!.type).toBe('video');
  });
});

describe('imageSize(比例 + 分辨率 → W*H)', () => {
  it('1:1 各分辨率边长正确', async () => {
    const { imageSize } = await import('../src/gateway/baichuan.js');
    expect(imageSize('1:1', '1K')).toBe('1024*1024');
    expect(imageSize('1:1', '2K')).toBe('1440*1440');
    expect(imageSize('1:1', '4K')).toBe('2048*2048');
  });
  it('横/竖比例:长边贴基数,短边按比例 + 8 像素对齐', async () => {
    const { imageSize } = await import('../src/gateway/baichuan.js');
    expect(imageSize('16:9', '1K')).toBe('1024*576'); // 长1024,短=1024*9/16=576
    expect(imageSize('9:16', '1K')).toBe('576*1024'); // 竖,宽短
  });
  it('auto / 未知比例 → 1:1 兜底', async () => {
    const { imageSize } = await import('../src/gateway/baichuan.js');
    expect(imageSize('auto', '1K')).toBe('1024*1024');
    expect(imageSize(undefined, undefined)).toBe('1024*1024');
  });
});

describe('qwen-image adapter:fetchImageStatus 解析 results[] 数组(外部声音 P2)', () => {
  // 关键:fetch spy 是进程级全局,vitest 并行跑多文件时若不还原会泄漏到别的测试(rbac 偶发 404)。
  // afterEach 兜底还原,即使断言抛错也不留 spy。
  afterEach(() => vi.restoreAllMocks());

  it('SUCCEEDED → 从 output.results[].url 取多图(不是 video_url 对象)', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-test';
    const { BaichuanGateway } = await import('../src/gateway/baichuan.js');
    const gw = new BaichuanGateway();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
    spy.mockRestore();
  });

  it('FAILED → status failed + error', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-test';
    const { BaichuanGateway } = await import('../src/gateway/baichuan.js');
    const gw = new BaichuanGateway();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ output: { task_status: 'FAILED', message: '内容违规' } }),
        { status: 200 },
      ),
    );
    const r = await gw.fetchImageStatus('task-2');
    expect(r.status).toBe('failed');
    expect(r.error).toContain('内容违规');
    spy.mockRestore();
  });
});
