// 灵镜 图转影片(i2v)后端测试 —— registry / 计价 / submit media 组装。
//
// 覆盖 /plan-eng-review 测试覆盖图的 video_i2v GAP:
//   - i2v/r2v registry 自洽(4 模型 tasks 合法/modelId/maxRefImages/全 V_DASH)
//   - costFor('video_i2v') 并入 video_t2v 分支:秒×档×tier、1080P=2×720P、读快照
//   - submitVideoT2V media 组装:first_frame→1元素、first_last→2元素、reference→N元素

import { describe, it, expect, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { VIDEO_MODELS, getI2VModel, listI2VModels } = await import('../src/gateway/video-models.js');
const { estimateVideoCost, costFor } = await import('../src/credits/index.js');
const { BaichuanGateway } = await import('../src/gateway/baichuan.js');

afterEach(() => vi.restoreAllMocks());

describe('i2v registry 自洽性', () => {
  it('4 模型 tasks 合法 / modelId 非空 / 全 V_DASH', () => {
    const i2v = listI2VModels();
    expect(i2v.length).toBe(4);
    const valid = new Set(['first_frame', 'first_last', 'reference']);
    for (const d of i2v) {
      expect(d.shape).toBe('V_DASH'); // 本轮 4 模型全 V_DASH(可灵 i2v 降范围)
      expect(d.modelId.length).toBeGreaterThan(0);
      expect(d.tasks.length).toBeGreaterThan(0);
      expect(d.tasks.every((t) => valid.has(t))).toBe(true);
    }
  });

  it('happyhorse-i2v:首帧、无 ratio、prompt 可选', () => {
    const d = VIDEO_MODELS['happyhorse-1.0-i2v']!;
    expect(d.tasks).toEqual(['first_frame']);
    expect(d.ratios).toEqual([]); // 比例跟首帧
    expect(d.promptRequired).toBe(false);
  });

  it('happyhorse-r2v:参考生、maxRefImages 9、prompt 必填、有 ratio', () => {
    const d = VIDEO_MODELS['happyhorse-1.0-r2v']!;
    expect(d.tasks).toEqual(['reference']);
    expect(d.maxRefImages).toBe(9);
    expect(d.promptRequired).toBe(true);
    expect(d.ratios.length).toBeGreaterThan(0);
  });

  it('wan2.7-i2v:首帧+首尾帧、无 ratio、negative+promptExtend', () => {
    const d = VIDEO_MODELS['wan2.7-i2v']!;
    expect(d.tasks).toEqual(['first_frame', 'first_last']);
    expect(d.ratios).toEqual([]);
    expect(d.supportsNegative).toBe(true);
    expect(d.supportsPromptExtend).toBe(true);
    expect(d.modelId).toBe('wan2.7-i2v-2026-04-25');
  });

  it('wan2.7-r2v:参考生、maxRefImages 5、prompt 必填', () => {
    const d = VIDEO_MODELS['wan2.7-r2v']!;
    expect(d.tasks).toEqual(['reference']);
    expect(d.maxRefImages).toBe(5);
    expect(d.promptRequired).toBe(true);
  });

  it('getI2VModel:未知/t2v key → 默认 i2v 模型(不回落 t2v)', () => {
    expect(getI2VModel('happyhorse-1.0-i2v').key).toBe('happyhorse-1.0-i2v');
    expect(getI2VModel('wan2.7-t2v').key).toBe('wan2.7-i2v'); // t2v key → 默认 i2v
    expect(getI2VModel('不存在').key).toBe('wan2.7-i2v');
  });
});

describe("costFor('video_i2v') 并入 video_t2v 分支(reserve==settle)", () => {
  it('读快照:秒 × 每秒售价(priceTier 已含分辨率,resFactor=1)', () => {
    // 快照 priceTier=35 = 万相2.7 i2v 1080P 每秒售价 → 10 × 35 = 350
    const cost = costFor('video_i2v', {
      model: 'wan2.7-i2v', durationSnapshot: 10, resSnapshot: '1080P', audioSnapshot: false, priceTierSnapshot: 35,
    });
    expect(cost).toBe(350);
    expect(cost).toBe(estimateVideoCost(10, 35, '1080P', false));
  });

  it('无快照回落:按分辨率派生每秒价(HH i2v 720P=32 / 1080P=56,不再 ×2)', () => {
    // 无 priceTierSnapshot → videoPriceTier 按分辨率选(720P→priceTier、1080P→priceTier1080)
    const p720 = costFor('video_i2v', { model: 'happyhorse-1.0-i2v', durationSnapshot: 5, resSnapshot: '720P' });
    const p1080 = costFor('video_i2v', { model: 'happyhorse-1.0-i2v', durationSnapshot: 5, resSnapshot: '1080P' });
    expect(p720).toBe(5 * 32); // 160
    expect(p1080).toBe(5 * 56); // 280(真实比值 1.78,非 ×2)
  });
});

describe('submitVideoT2V media 组装(i2v)', () => {
  function spyCapture() {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      body = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve(new Response(JSON.stringify({ output: { task_id: 't-1', task_status: 'PENDING' } }), { status: 200 }));
    });
    return () => body;
  }

  it('first_frame → media 1 元素 {type:first_frame}', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['https://x/a.png'], resolution: '720P', duration: 5 });
    const media = (get().input as any).media;
    expect(media).toEqual([{ type: 'first_frame', url: 'https://x/a.png' }]);
  });

  it('first_last → media 2 元素(序 first/last)', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'wan2.7-i2v', task: 'first_last', imageRefs: ['https://x/first.png', 'https://x/last.png'], resolution: '720P', duration: 5 });
    const media = (get().input as any).media;
    expect(media).toEqual([
      { type: 'first_frame', url: 'https://x/first.png' },
      { type: 'last_frame', url: 'https://x/last.png' },
    ]);
  });

  it('reference → media N 元素 {type:reference_image}', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'happyhorse-1.0-r2v', task: 'reference', imageRefs: ['https://x/1.png', 'https://x/2.png', 'https://x/3.png'], prompt: '[图1]中的女性', resolution: '720P', ratio: '16:9', duration: 5 });
    const media = (get().input as any).media;
    expect(media).toEqual([
      { type: 'reference_image', url: 'https://x/1.png' },
      { type: 'reference_image', url: 'https://x/2.png' },
      { type: 'reference_image', url: 'https://x/3.png' },
    ]);
    // 参考生有 ratio,首帧无 ratio
    expect((get().parameters as any).ratio).toBe('16:9');
  });

  it('首帧 task 无 prompt → input 不带 prompt;首帧不带 ratio', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['https://x/a.png'], resolution: '720P', duration: 5 });
    expect((get().input as any).prompt).toBeUndefined();
    expect((get().parameters as any).ratio).toBeUndefined();
  });
});
