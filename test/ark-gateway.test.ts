// 灵镜 — PR-2a provider 抽象 + 火山(豆包)适配器。
// 决策来源:ceo-plans/2026-06-16-model-access-platform PR-2a。
// 验证:① providerForModel 解析(豆包→volc-ark,其余→bailian)② getGateway 按模型选对适配器
//   ③ ark 请求体组装(视频 content[] / 图片 size)④ ark 响应解析(小写 status 归一、video_url、data[].url)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-ark-vitest-32b';
const { db } = await import('../src/db/index.js');
const { setProviderKey } = await import('../src/gateway/provider-keys.js');
const { getGateway, providerForModel, BaichuanGateway } = await import('../src/gateway/baichuan.js');
const { ArkGateway } = await import('../src/gateway/ark.js');

beforeEach(() => {
  // 迁移已种子 volc-ark provider;给它配 key(否则 ark 调用取不到 key)。
  setProviderKey('volc-ark', 'sk-ark-test-key');
  process.env.MASTER_KEY = 'test-master-key-for-ark-vitest-32b';
});
afterEach(() => { vi.restoreAllMocks(); });

describe('providerForModel 解析', () => {
  it('豆包视频 → volc-ark', () => {
    expect(providerForModel('doubao-seedance-2.0')).toBe('volc-ark');
    expect(providerForModel('doubao-seedance-2.0-fast')).toBe('volc-ark');
  });
  it('豆包图片 → volc-ark', () => {
    expect(providerForModel('doubao-seedream-4.0')).toBe('volc-ark');
    expect(providerForModel('doubao-seedream-5.0-lite')).toBe('volc-ark');
  });
  it('百炼模型 → bailian', () => {
    expect(providerForModel('wan2.7-t2v')).toBe('bailian');
    expect(providerForModel('qwen-image')).toBe('bailian');
  });
  it('未知 / 空 → bailian(老 job 兼容)', () => {
    expect(providerForModel('unknown-xyz')).toBe('bailian');
    expect(providerForModel(undefined)).toBe('bailian');
  });
});

describe('getGateway 按模型选适配器', () => {
  it('豆包模型 → ArkGateway', () => {
    expect(getGateway('doubao-seedance-2.0')).toBeInstanceOf(ArkGateway);
    expect(getGateway('doubao-seedream-4.0')).toBeInstanceOf(ArkGateway);
  });
  it('百炼模型 / 无参 / s2v → BaichuanGateway', () => {
    expect(getGateway('wan2.7-t2v')).toBeInstanceOf(BaichuanGateway);
    expect(getGateway()).toBeInstanceOf(BaichuanGateway); // s2v 无 model
    expect(getGateway('qwen-image')).toBeInstanceOf(BaichuanGateway);
  });
});

describe('ArkGateway 视频:请求体组装 + 响应解析', () => {
  it('submitVideoT2V 组 content[text]+resolution小写+generate_audio,取 json.id', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'cgt-ark-123' }), { status: 200 });
    });
    const gw = new ArkGateway();
    const id = await gw.submitVideoT2V({ model: 'doubao-seedance-2.0', prompt: '小猫打哈欠', resolution: '720P', duration: 5, audio: true });
    expect(id).toBe('cgt-ark-123');
    expect(captured.model).toBe('doubao-seedance-2.0');
    expect(captured.resolution).toBe('720p'); // 火山小写
    expect(captured.content[0]).toEqual({ type: 'text', text: '小猫打哈欠' });
    expect(captured.generate_audio).toBe(true); // supportsAudio 模型透传 audio
  });

  it('submitVideoT2V 首帧 i2v:imageRefs → content image_url role=first_frame', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'cgt-2' }), { status: 200 });
    });
    await new ArkGateway().submitVideoT2V({ model: 'doubao-seedance-2.0', prompt: 'x', task: 'first_frame', imageRefs: ['https://img/a.png'] });
    const img = captured.content.find((c: any) => c.type === 'image_url');
    expect(img.image_url.url).toBe('https://img/a.png');
    expect(img.role).toBe('first_frame');
  });

  it('fetchJobStatus:小写 status 归一 + 取 content.video_url', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'succeeded', content: { video_url: 'https://v/out.mp4' } }), { status: 200 }) as any,
    );
    const r = await new ArkGateway().fetchJobStatus('cgt-ark-123');
    expect(r.status).toBe('succeeded');
    expect(r.videoUrl).toBe('https://v/out.mp4');
  });

  it('fetchJobStatus:running/queued/failed 归一', async () => {
    const gw = new ArkGateway();
    for (const [arkStatus, want] of [['running', 'running'], ['queued', 'pending'], ['failed', 'failed']] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: arkStatus, error: { message: 'boom' } }), { status: 200 }) as any,
      );
      const r = await gw.fetchJobStatus('x');
      expect(r.status).toBe(want);
      if (want === 'failed') expect(r.error).toBe('boom');
      vi.restoreAllMocks();
      setProviderKey('volc-ark', 'sk-ark-test-key');
    }
  });
});

describe('ArkGateway 图片:同步生成', () => {
  it('generateImageSync POST /images/generations,取 data[].url', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: [{ url: 'https://img/gen1.jpg' }] }), { status: 200 });
    });
    const urls = await new ArkGateway().generateImageSync(
      { model: 'doubao-seedream-4.0', prompt: '一只猫', resolution: '2K' },
      new AbortController().signal,
    );
    expect(urls).toEqual(['https://img/gen1.jpg']);
    expect(captured.url).toContain('/images/generations');
    expect(captured.body.model).toBe('doubao-seedream-4.0');
    expect(captured.body.size).toBe('2K');
  });

  it('editImage 多图融合:image 传数组', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ url: 'https://img/edit.jpg' }] }), { status: 200 });
    });
    await new ArkGateway().editImage(
      { model: 'doubao-seedream-4.0', prompt: '融合', imageUrls: ['https://a.png', 'https://b.png'] },
      new AbortController().signal,
    );
    expect(captured.image).toEqual(['https://a.png', 'https://b.png']);
  });

  it('图片无 url 返回 → 抛错(不静默)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: '审核拒绝' } }), { status: 200 }) as any,
    );
    await expect(
      new ArkGateway().generateImageSync({ model: 'doubao-seedream-4.0', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow();
  });
});
