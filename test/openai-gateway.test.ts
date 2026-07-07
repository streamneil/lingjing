// 灵镜 — 第 4 个 provider:OpenAI GPT Image 2(文生图,token 计价)。
// 覆盖:① providerForModel→openai + getGateway 选 OpenAIImageGateway
//   ② Bearer 鉴权 + /images/generations + 体 {model,prompt,n,size,quality}
//   ③ size = pixelMatrix 派生 WxH(`x` 分隔,非 `*`)④ b64_json→URL + usage 解析
//   ⑤ 错误可读:空 key / 403 组织未验证 / 400 内容审核 ⑥ b64 缺失抛错 ⑦ editImage 抛错
//   ⑧ pixelMatrix 全档满足 ÷16 / 比例 1:3~3:1 / ≤3840×2160(guard 不触发)。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-openai-vitest32';
const pkMod = await import('../src/gateway/provider-keys.js');
const { setProviderKey } = pkMod;
const { getGateway, providerForModel } = await import('../src/gateway/baichuan.js');
const { OpenAIImageGateway } = await import('../src/gateway/openai.js');
const { IMAGE_MODELS, imagePixelWH } = await import('../src/gateway/image-models.js');
const storageMod = await import('../src/storage/index.js');
const publisherMod = await import('../src/gateway/media-publisher.js');

function okImageResponse(usage?: Record<string, number>) {
  return new Response(JSON.stringify({
    created: 0,
    data: [{ b64_json: Buffer.from('img').toString('base64') }],
    usage: usage ?? { input_tokens: 20, output_tokens: 7033, total_tokens: 7053 },
  }), { status: 200 });
}

beforeEach(() => {
  setProviderKey('openai', 'sk-test-openai-123');
  process.env.MASTER_KEY = 'test-master-key-for-openai-vitest32';
  delete process.env.OPENAI_PROXY;
  vi.spyOn(storageMod.storage, 'putObject').mockResolvedValue('stored://ok');
  vi.spyOn(publisherMod, 'getMediaPublisher').mockReturnValue({ publish: async (k: string) => `https://cdn/${k}` } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('providerForModel + getGateway(OpenAI)', () => {
  it('gpt-image-2 → openai + 选 OpenAIImageGateway', () => {
    expect(providerForModel('gpt-image-2')).toBe('openai');
    expect(getGateway('gpt-image-2')).toBeInstanceOf(OpenAIImageGateway);
  });
});

describe('OpenAIImageGateway 请求/响应', () => {
  it('Bearer + /images/generations + 体 {model,prompt,n,size(x 分隔),quality} + b64→URL + usage', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return okImageResponse();
    });
    const { urls, usage } = await new OpenAIImageGateway().generateImageSync(
      { model: 'gpt-image-2', prompt: '一只猫', quality: 'high', resolution: '1K', ratio: '3:2' },
      new AbortController().signal,
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('https://cdn/openai-tmp/'); // b64→putObject→publish 转 URL
    expect(captured.url).toContain('/images/generations');
    expect(captured.headers.Authorization).toBe('Bearer sk-test-openai-123'); // Bearer,非 x-goog-api-key
    expect(captured.body.model).toBe('gpt-image-2-2026-04-21'); // registry modelId
    expect(captured.body.prompt).toBe('一只猫');
    expect(captured.body.quality).toBe('high');
    expect(captured.body.size).toBe('1536x1024'); // 1K × 3:2 → pixelMatrix,`x` 分隔(非 1536*1024)
    // usage 解析(token 计价结算真相)
    expect(usage).toEqual({ inputTokens: 20, outputTokens: 7033, totalTokens: 7053 });
  });

  it('未传 quality → 体不含 quality 字段(可选)', async () => {
    let body: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => { body = JSON.parse(init.body); return okImageResponse(); });
    await new OpenAIImageGateway().generateImageSync({ model: 'gpt-image-2', prompt: 'x', resolution: '1K', ratio: '1:1' }, new AbortController().signal);
    expect(body.size).toBe('1024x1024');
    expect('quality' in body).toBe(false);
  });

  it('usage 缺失 → usage=undefined(结算回落估算,不崩)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('x').toString('base64') }] }), { status: 200 }),
    );
    const { usage } = await new OpenAIImageGateway().generateImageSync({ model: 'gpt-image-2', prompt: 'x' }, new AbortController().signal);
    expect(usage).toBeUndefined();
  });
});

describe('OpenAIImageGateway 错误可读', () => {
  it('空 key(getProviderKey 抛)→ 可读中文(未裸 401)', async () => {
    vi.spyOn(pkMod, 'getProviderKey').mockImplementation(() => { throw new Error('PROVIDER_KEY_MISSING'); });
    await expect(
      new OpenAIImageGateway().generateImageSync({ model: 'gpt-image-2', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/未配置/);
  });

  it('403 → 组织未验证提示', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Your organization must be verified', code: 'verification_required' } }), { status: 403 }),
    );
    await expect(
      new OpenAIImageGateway().generateImageSync({ model: 'gpt-image-2', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/组织未验证/);
  });

  it('400 content_policy → 审核拦截提示', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'blocked', code: 'content_policy_violation' } }), { status: 400 }),
    );
    await expect(
      new OpenAIImageGateway().generateImageSync({ model: 'gpt-image-2', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/审核拦截/);
  });

  it('data[].b64_json 全空 → 清晰错误(不 b64ToPublicUrl(undefined) 裸崩)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{}] }), { status: 200 }));
    await expect(
      new OpenAIImageGateway().generateImageSync({ model: 'gpt-image-2', prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/未返回图片/);
  });

});

describe('OpenAIImageGateway 图片编辑(/images/edits)', () => {
  it('输入图 → data URL + POST /images/edits(JSON,size 仅标准尺寸)+ b64→URL + usage', async () => {
    let editBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      const u = String(url);
      if (u.startsWith('https://in/')) return new Response(Buffer.from('inimg'), { status: 200, headers: { 'content-type': 'image/png' } });
      editBody = JSON.parse(init.body);
      return okImageResponse();
    });
    const { urls, usage } = await new OpenAIImageGateway().editImage(
      { model: 'gpt-image-2', imageUrls: ['https://in/1.png', 'https://in/2.png'], prompt: '换成水彩风', quality: 'high', ratio: '3:2' },
      new AbortController().signal,
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('https://cdn/openai-tmp/');
    expect(editBody.model).toBe('gpt-image-2-2026-04-21');
    expect(editBody.prompt).toBe('换成水彩风');
    expect(editBody.quality).toBe('high');
    expect(editBody.size).toBe('1536x1024'); // 3:2 横向 → 标准横图(编辑不收任意 WxH)
    expect(editBody.images).toHaveLength(2);
    expect(editBody.images[0].image_url).toMatch(/^data:image\/png;base64,/); // 输入图内联 data URL,不发裸 OSS URL
    expect(usage).toEqual({ inputTokens: 20, outputTokens: 7033, totalTokens: 7053 });
  });

  it('无输入图 → 清晰错误', async () => {
    await expect(
      new OpenAIImageGateway().editImage({ model: 'gpt-image-2', imageUrls: [], prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/至少 1 张输入图/);
  });

  it('超过 maxInputImages(9)→ 清晰错误', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://in/${i}.png`);
    await expect(
      new OpenAIImageGateway().editImage({ model: 'gpt-image-2', imageUrls: many, prompt: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/最多 9 张/);
  });
});

describe('GPT_IMAGE2_PIXELS 全档满足 API 约束(guard 不触发)', () => {
  it('每格 ÷16、比例 ∈ [1:3,3:1]、≤3840×2160', () => {
    const def = IMAGE_MODELS['gpt-image-2']!;
    const tiers = Object.keys(def.pixelMatrix!);
    const ratios = Object.keys(def.pixelMatrix!['1K']!);
    for (const tier of tiers) {
      for (const ratio of ratios) {
        const wh = imagePixelWH(def, ratio, tier)!;
        expect(wh, `${tier}/${ratio}`).toBeTruthy();
        expect(wh.width % 16, `${tier}/${ratio} w÷16`).toBe(0);
        expect(wh.height % 16, `${tier}/${ratio} h÷16`).toBe(0);
        const r = wh.width / wh.height;
        expect(r, `${tier}/${ratio} ratio`).toBeGreaterThanOrEqual(1 / 3);
        expect(r, `${tier}/${ratio} ratio`).toBeLessThanOrEqual(3);
        expect(wh.width, `${tier}/${ratio} w≤3840`).toBeLessThanOrEqual(3840);
        expect(wh.height, `${tier}/${ratio} h≤3840`).toBeLessThanOrEqual(3840);
        expect(wh.width * wh.height, `${tier}/${ratio} px≤3840×2160`).toBeLessThanOrEqual(3840 * 2160);
      }
    }
  });
});
