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
    expect(providerForModel('doubao-seedance-2.5')).toBe('volc-ark');
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
    expect(getGateway('doubao-seedance-2.5')).toBeInstanceOf(ArkGateway);
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
    // 入参 model 用内部 key 'doubao-seedance-2.0',发给火山的 captured.model 是厂商真实 modelId(带日期版本)
    expect(captured.model).toBe('doubao-seedance-2-0-260128');
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

  it('Seedance 2.5 纯音频参考 → 官方 modelId + reference_audio + 480p/30s', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'cgt-s25-audio' }), { status: 200 });
    });
    await new ArkGateway().submitVideoT2V({
      model: 'doubao-seedance-2.5', task: 'reference', audioRefs: ['https://aud/only.wav'],
      resolution: '480P', duration: 30,
    });
    expect(captured.model).toBe('doubao-seedance-2-5-260628');
    expect(captured.resolution).toBe('480p');
    expect(captured.duration).toBe(30);
    expect(captured.content).toEqual([
      { type: 'audio_url', audio_url: { url: 'https://aud/only.wav' }, role: 'reference_audio' },
    ]);
  });

  it('submitVideoT2V 多模态参考(r2v):图/视频/音频 → typed content + role + ratio', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'cgt-r2v' }), { status: 200 });
    });
    await new ArkGateway().submitVideoT2V({
      model: 'doubao-seedance-2.0', prompt: '[图片1][视频1][音频1]', task: 'reference',
      imageRefs: ['https://img/a.png', 'https://img/b.png'], videoRefs: ['https://vid/v.mp4'], audioRefs: ['https://aud/a.mp3'],
      ratio: '16:9', audio: true,
    });
    const imgs = captured.content.filter((c: any) => c.type === 'image_url');
    const vids = captured.content.filter((c: any) => c.type === 'video_url');
    const auds = captured.content.filter((c: any) => c.type === 'audio_url');
    expect(imgs.map((c: any) => c.role)).toEqual(['reference_image', 'reference_image']);
    expect(vids[0]).toEqual({ type: 'video_url', video_url: { url: 'https://vid/v.mp4' }, role: 'reference_video' });
    expect(auds[0]).toEqual({ type: 'audio_url', audio_url: { url: 'https://aud/a.mp3' }, role: 'reference_audio' });
    expect(captured.ratio).toBe('16:9');
    expect(captured.generate_audio).toBe(true);
  });

  it('fetchJobStatus:小写 status 归一 + 取 content.video_url', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        status: 'succeeded', content: { video_url: 'https://v/out.mp4' },
        usage: { completion_tokens: 216000, total_tokens: 216000 },
      }), { status: 200 }) as any,
    );
    const r = await new ArkGateway().fetchJobStatus('cgt-ark-123');
    expect(r.status).toBe('succeeded');
    expect(r.videoUrl).toBe('https://v/out.mp4');
    expect(r.usage).toEqual({ completionTokens: 216000 });
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
    const { urls } = await new ArkGateway().generateImageSync(
      { model: 'doubao-seedream-4.0', prompt: '一只猫', resolution: '2K' },
      new AbortController().signal,
    );
    expect(urls).toEqual(['https://img/gen1.jpg']);
    expect(captured.url).toContain('/images/generations');
    expect(captured.body.model).toBe('doubao-seedream-4-0-250828'); // 适配器用 registry.modelId(带版本号)
    expect(captured.body.size).toBe('2048x2048'); // 2K + 默认 1:1 → 火山精确像素(矩阵)
    expect(captured.body.sequential_image_generation).toBe('disabled'); // 锁单图输出(文档要求)
  });

  it('editImage 多图融合:image 传数组 + sequential disabled', async () => {
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
    expect(captured.sequential_image_generation).toBe('disabled');
  });

  const grab = () => { let c: any = null; vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => { c = JSON.parse(init.body); return new Response(JSON.stringify({ data: [{ url: 'https://x' }] }), { status: 200 }); }); return () => c; };

  it('档托底:4.5 不支持 1K → 回落最低支持档 2K;4.0 支持 1K → 保留(均按 1:1 出精确像素)', async () => {
    let get = grab();
    await new ArkGateway().generateImageSync({ model: 'doubao-seedream-4.5', prompt: 'x', resolution: '1K' }, new AbortController().signal);
    expect(get().size).toBe('2048x2048'); // 4.5 无 1K 档 → 回落 2K，1:1
    vi.restoreAllMocks(); setProviderKey('volc-ark', 'sk-ark-test-key');
    get = grab();
    await new ArkGateway().generateImageSync({ model: 'doubao-seedream-4.0', prompt: 'x', resolution: '1K' }, new AbortController().signal);
    expect(get().size).toBe('1024x1024'); // 4.0 有 1K 档 → 保留，1:1
  });

  it('比例真正生效:档+比例 → 火山矩阵精确像素(原来比例被丢)', async () => {
    let get = grab();
    await new ArkGateway().generateImageSync({ model: 'doubao-seedream-4.0', prompt: 'x', resolution: '2K', ratio: '16:9' }, new AbortController().signal);
    expect(get().size).toBe('2848x1600'); // 2K × 16:9
    vi.restoreAllMocks(); setProviderKey('volc-ark', 'sk-ark-test-key');
    get = grab();
    await new ArkGateway().generateImageSync({ model: 'doubao-seedream-4.0', prompt: 'x', resolution: '4K', ratio: '9:16' }, new AbortController().signal);
    expect(get().size).toBe('3040x5504'); // 4K × 9:16
  });

  it('3K 档仅 5.0-lite:5.0-lite 选 3K 生效;4.0 选 3K → 回落最低档 1K', async () => {
    let get = grab();
    await new ArkGateway().generateImageSync({ model: 'doubao-seedream-5.0-lite', prompt: 'x', resolution: '3K', ratio: '4:3' }, new AbortController().signal);
    expect(get().size).toBe('3456x2592'); // 5.0-lite 有 3K 档 × 4:3
    vi.restoreAllMocks(); setProviderKey('volc-ark', 'sk-ark-test-key');
    get = grab();
    await new ArkGateway().generateImageSync({ model: 'doubao-seedream-4.0', prompt: 'x', resolution: '3K', ratio: '4:3' }, new AbortController().signal);
    expect(get().size).toBe('1152x864'); // 4.0 无 3K → 回落最低档 1K × 4:3
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
