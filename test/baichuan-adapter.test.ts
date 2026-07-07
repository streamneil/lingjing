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
    const { urls } = await gw.editImage(
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

describe('同步文生图 generateImageSync(S+text2img,eng 外部声音 P1-a/P3-b)', () => {
  it('纯文本 content(无输入图)→ choices[].image 数组', async () => {
    const gw = new BaichuanGateway();
    let sentBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      sentBody = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://gen/a.png' }] } }] } }),
          { status: 200 },
        ),
      );
    });
    const { urls } = await gw.generateImageSync(
      { model: 'qwen-image-2.0-pro', prompt: '一只猫', ratio: '1:1', resolution: '2K' },
      new AbortController().signal,
    );
    expect(urls).toEqual(['https://gen/a.png']);
    // P3-b:content 是 [{text}](非空,不触空 content 抛错);无 image 部分
    const content = ((sentBody.input as Record<string, unknown>).messages as Array<Record<string, unknown>>)[0]!
      .content as Array<Record<string, unknown>>;
    expect(content).toEqual([{ text: '一只猫' }]);
  });

  it('命脉:已 abort 的 signal → 抛错(不冻 worker)', async () => {
    const gw = new BaichuanGateway();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      const sig = (opts as RequestInit | undefined)?.signal;
      if (sig?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      gw.generateImageSync({ model: 'qwen-image-2.0-pro', prompt: 'x' }, ac.signal),
    ).rejects.toThrow();
  });
});

describe('seed 透传(A4)', () => {
  function spyCapture() {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      body = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({ output: { task_id: 't1', choices: [{ message: { content: [{ image: 'https://x/a.png' }] } }] } }),
          { status: 200 },
        ),
      );
    });
    return () => body;
  }

  it('有 seed → parameters.seed = 数字', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.generateImageSync({ model: 'qwen-image-2.0-pro', prompt: 'x', seed: 12345 }, new AbortController().signal);
    expect(((get().parameters as Record<string, unknown>).seed)).toBe(12345);
  });

  it('无 seed → 不加 seed 字段(随机)', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.generateImageSync({ model: 'qwen-image-2.0-pro', prompt: 'x' }, new AbortController().signal);
    expect(((get().parameters as Record<string, unknown>).seed)).toBeUndefined();
  });

  it('submitImage(异步)同样透传 seed', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitImage({ model: 'qwen-image', prompt: 'x', seed: 7 });
    expect(((get().parameters as Record<string, unknown>).seed)).toBe(7);
  });
});

describe('万相2.7 异步编辑 submitImageEdit(A_EDIT,含图体 + bbox_list)', () => {
  function spyCapture() {
    let body: Record<string, unknown> = {}; let url = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation((u, opts) => {
      url = String(u); body = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve(new Response(JSON.stringify({ output: { task_id: 'wan-task-1' } }), { status: 200 }));
    });
    return () => ({ body, url });
  }

  it('提交体:image-generation 端点 + messages 含图体 + n + size:"2K" + 返回 task_id', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    const taskId = await gw.submitImageEdit({
      model: 'wan2.7-image', mode: 'img2img', prompt: '换背景',
      imageRefs: ['https://in/1.png', 'https://in/2.png'], count: 2, resolution: '2K',
    });
    expect(taskId).toBe('wan-task-1');
    const { body, url } = get();
    expect(url).toContain('/services/aigc/image-generation/generation');
    const content = ((body.input as any).messages[0].content) as Array<Record<string, unknown>>;
    expect(content).toEqual([{ image: 'https://in/1.png' }, { image: 'https://in/2.png' }, { text: '换背景' }]);
    const params = body.parameters as Record<string, unknown>;
    expect(params.n).toBe(2);
    expect(params.size).toBe('2K'); // keyword
  });

  it('bbox_list 透传(对齐输入图;空框图 [] 保留)', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitImageEdit({
      model: 'wan2.7-image', mode: 'img2img', prompt: 'x',
      imageRefs: ['https://in/1.png', 'https://in/2.png'],
      bboxList: [[[10, 10, 50, 50]], []],
    });
    expect((get().body.parameters as Record<string, unknown>).bbox_list).toEqual([[[10, 10, 50, 50]], []]);
  });

  it('无 bbox → 不带 bbox_list 字段', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitImageEdit({ model: 'wan2.7-image', mode: 'img2img', prompt: 'x', imageRefs: ['https://in/1.png'] });
    expect((get().body.parameters as Record<string, unknown>).bbox_list).toBeUndefined();
  });
});

describe('fetchImageStatus 双解析(万相2.7 编辑回包是 choices-content)', () => {
  it('无 results[] → 解 choices[].message.content[].image 多图', async () => {
    const gw = new BaichuanGateway();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [{ image: 'https://wan/a.png' }, { image: 'https://wan/b.png' }] } }],
          },
        }),
        { status: 200 },
      ),
    );
    const r = await gw.fetchImageStatus('wan-task-1');
    expect(r.status).toBe('succeeded');
    expect(r.imageUrls).toEqual(['https://wan/a.png', 'https://wan/b.png']);
  });
});

describe('submitVideoT2V 体形(按 shape 组体)', () => {
  function spyCapture() {
    let body: Record<string, unknown> = {}; let url = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation((u, opts) => {
      url = String(u); body = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve(new Response(JSON.stringify({ output: { task_id: 't-1', task_status: 'PENDING' } }), { status: 200 }));
    });
    return () => ({ body, url });
  }

  it('V_DASH(wan2.7):resolution+ratio+duration、含 negative_prompt/prompt_extend、统一端点、无 mode', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    const taskId = await gw.submitVideoT2V({
      model: 'wan2.7-t2v', prompt: '一只猫', resolution: '1080P', ratio: '9:16',
      duration: 8, negativePrompt: '花朵', promptExtend: false, seed: 123,
    });
    expect(taskId).toBe('t-1');
    const { body, url } = get();
    expect(url).toContain('/services/aigc/video-generation/video-synthesis');
    // 入参 model 用内部 key 'wan2.7-t2v',但发给百炼的 body.model 是厂商真实 modelId(带日期版本)
    expect(body.model).toBe('wan2.7-t2v-2026-04-25');
    expect((body.input as any).prompt).toBe('一只猫');
    expect((body.input as any).negative_prompt).toBe('花朵');
    const p = body.parameters as Record<string, unknown>;
    expect(p.resolution).toBe('1080P');
    expect(p.ratio).toBe('9:16');
    expect(p.duration).toBe(8);
    expect(p.prompt_extend).toBe(false);
    expect(p.watermark).toBe(false);
    expect(p.seed).toBe(123);
    expect(p.mode).toBeUndefined();
  });

  it('V_KLING(可灵):mode+aspect_ratio+audio、modelId 带 kling/ 前缀、无 resolution', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'kling-v3-t2v', prompt: '小猫奔跑', mode: 'pro', ratio: '1:1', duration: 5, audio: true });
    const { body } = get();
    expect(body.model).toBe('kling/kling-v3-video-generation');
    const p = body.parameters as Record<string, unknown>;
    expect(p.mode).toBe('pro');
    expect(p.aspect_ratio).toBe('1:1');
    expect(p.audio).toBe(true);
    expect(p.resolution).toBeUndefined();
  });

  it('happyhorse:无 negative/prompt_extend/audio(模型不支持)', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'happyhorse-1.0-t2v', prompt: '微型城市', resolution: '720P', ratio: '16:9', duration: 5 });
    const { body } = get();
    expect((body.input as any).negative_prompt).toBeUndefined();
    const p = body.parameters as Record<string, unknown>;
    expect(p.prompt_extend).toBeUndefined();
    expect(p.audio).toBeUndefined();
  });
});
