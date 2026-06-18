// 灵镜 — PR-2a 第三个 provider:Google AI Studio(Gemini / Nano Banana)。
// 决策来源:ceo-plans/2026-06-16-model-access-platform PR-2a。
// 验证 provider 抽象对「完全异构」厂商成立:① providerForModel→google-ai-studio
//   ② getGateway 选 GeminiGateway ③ x-goog-api-key 鉴权头(非 Bearer)④ contents 请求体
//   ⑤ base64 响应解析 + 转存为 URL ⑥ 无图响应抛错。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-gemini-vitest32';
const { db } = await import('../src/db/index.js');
const { setProviderKey } = await import('../src/gateway/provider-keys.js');
const { getGateway, providerForModel } = await import('../src/gateway/baichuan.js');
const { GeminiGateway } = await import('../src/gateway/gemini.js');
const storageMod = await import('../src/storage/index.js');
const publisherMod = await import('../src/gateway/media-publisher.js');

// gemini 模型需 model_pricing 行才 enabled(getImageModel 显式 key 仍解析,但定价测试需要)。
beforeEach(() => {
  setProviderKey('google-ai-studio', 'gkey-test-123');
  process.env.MASTER_KEY = 'test-master-key-for-gemini-vitest32';
  // 存储/发布桩:gemini 适配器 base64→putObject→publish 转 URL。
  vi.spyOn(storageMod.storage, 'putObject').mockResolvedValue('stored://ok');
  vi.spyOn(publisherMod, 'getMediaPublisher').mockReturnValue({ publish: async (k: string) => `https://cdn/${k}` } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('providerForModel + getGateway(Gemini)', () => {
  it('gemini 模型 → google-ai-studio', () => {
    expect(providerForModel('gemini-3.1-flash-image')).toBe('google-ai-studio');
    expect(providerForModel('gemini-3-pro-image')).toBe('google-ai-studio');
  });
  it('getGateway 选 GeminiGateway(sync image 形状)', () => {
    const gw = getGateway('gemini-3.1-flash-image') as unknown;
    expect(gw).toBeInstanceOf(GeminiGateway);
  });
});

describe('GeminiGateway 请求/响应', () => {
  it('generateImageSync:x-goog-api-key 头 + contents[text] + :generateContent 端点', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: Buffer.from('img').toString('base64') } }] } }],
      }), { status: 200 });
    });
    const urls = await new GeminiGateway().generateImageSync(
      { model: 'gemini-3.1-flash-image', prompt: '一只猫', resolution: '2K', ratio: '16:9' },
      new AbortController().signal,
    );
    expect(urls.length).toBe(1);
    expect(urls[0]).toContain('https://cdn/'); // 来自 publish 桩(base64→putObject→publish 转 URL)
    expect(captured.url).toContain('/v1beta/models/gemini-3.1-flash-image:generateContent'); // v1beta(实测 v1 不认 image-gen)
    expect(captured.headers['x-goog-api-key']).toBe('gkey-test-123'); // 非 Bearer
    expect(captured.headers.Authorization).toBeUndefined();
    expect(captured.body.contents[0].parts[0]).toEqual({ text: '一只猫' });
    expect(captured.body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(captured.body.generationConfig.imageConfig.aspectRatio).toBe('16:9');
  });

  it('editImage:输入图 URL → 拉取转 base64 inline_data', async () => {
    let captured: any = null;
    let fetchCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      fetchCount++;
      if (String(url).startsWith('https://in/')) {
        // 输入图拉取
        return new Response(Buffer.from('inputimg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: Buffer.from('out').toString('base64') } }] } }],
      }), { status: 200 });
    });
    await new GeminiGateway().editImage(
      { model: 'gemini-3-pro-image', prompt: '改成夜景', imageUrls: ['https://in/a.jpg'] },
      new AbortController().signal,
    );
    const inlinePart = captured.contents[0].parts.find((p: any) => p.inline_data);
    expect(inlinePart.inline_data.mime_type).toBe('image/jpeg');
    expect(inlinePart.inline_data.data).toBe(Buffer.from('inputimg').toString('base64'));
  });

  it('thinking 模型:跳过 thought:true 中间图,只取最终成品', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { inline_data: { mime_type: 'image/png', data: Buffer.from('think1').toString('base64') }, thought: true },  // 中间思考图,跳过
        { inline_data: { mime_type: 'image/png', data: Buffer.from('think2').toString('base64') }, thought: true },  // 中间思考图,跳过
        { inline_data: { mime_type: 'image/png', data: Buffer.from('FINAL').toString('base64') }, thought_signature: 'sigB' }, // 成品
      ] } }],
    }), { status: 200 }) as any);
    const urls = await new GeminiGateway().generateImageSync({ model: 'gemini-3-pro-image', prompt: 'x' }, new AbortController().signal);
    expect(urls.length).toBe(1); // 只 1 张成品(2 张 thought 被跳过)
  });

  it('两个 Nano Banana 模型都发 imageSize + aspectRatio(均 3.x)', async () => {
    // 2.5 已下线;产品仅余 3.1 Flash 与 3 Pro,两者都支持 imageSize。
    // 网关 startsWith('gemini-3') 守卫保留(无害、未来若再接非-3.x 模型仍正确)。
    let flash: any = null, pro: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      const b = JSON.parse(init.body);
      if (b.contents) { if (!pro) pro = b; else flash = b; }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: Buffer.from('x').toString('base64') } }] } }] }), { status: 200 });
    });
    await new GeminiGateway().generateImageSync({ model: 'gemini-3-pro-image', prompt: 'x', resolution: '2K', ratio: '16:9' }, new AbortController().signal);
    await new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x', resolution: '4K', ratio: '1:1' }, new AbortController().signal);
    expect(pro.generationConfig.imageConfig.imageSize).toBe('2K');
    expect(pro.generationConfig.imageConfig.aspectRatio).toBe('16:9');
    expect(flash.generationConfig.imageConfig.imageSize).toBe('4K');
    expect(flash.generationConfig.imageConfig.aspectRatio).toBe('1:1');
  });

  it('camelCase 响应(inlineData)也能解析', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('z').toString('base64') } }] } }],
    }), { status: 200 }) as any);
    const urls = await new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x' }, new AbortController().signal);
    expect(urls.length).toBe(1);
  });

  it('无图响应(被安全策略拦)→ 抛错', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '拒绝' }] }, finishReason: 'SAFETY' }],
    }), { status: 200 }) as any);
    await expect(
      new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow();
  });

  it('HTTP 错误 → 抛错(带 error 信息)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'API key invalid' } }), { status: 400 }) as any);
    await expect(
      new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow();
  });
});
