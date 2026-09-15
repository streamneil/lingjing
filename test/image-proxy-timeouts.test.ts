import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ agents: [] as any[], fetch: vi.fn(async (_url: unknown, _init: { signal?: AbortSignal }) => { throw new Error('mock network error'); }) }));
vi.mock('undici', () => ({ fetch: mock.fetch, ProxyAgent: class { constructor(options: unknown) { mock.agents.push(options); } } }));
vi.mock('../src/config.js', () => ({ config: { baichuan: { imageTimeoutMs: 900000 } } }));
vi.mock('../src/storage/index.js', () => ({ storage: {} }));
vi.mock('../src/gateway/media-publisher.js', () => ({ getMediaPublisher: () => ({ publish: async (key: string) => key }) }));
vi.mock('../src/gateway/provider-keys.js', () => ({ getProviderKey: () => 'test', getProviderBaseUrl: () => undefined }));
vi.mock('../src/gateway/image-models.js', () => ({ getImageModel: () => ({ modelId: 'gemini-3-pro-image' }) }));

afterEach(() => vi.unstubAllEnvs());

describe('图片代理响应超时', () => {
  it('OpenAI/Gemini 共享代理设置 15 分钟,支付代理保留默认行为', async () => {
    const { proxyDispatcher } = await import('../src/gateway/sync-image-common.js');
    for (const key of ['OPENAI_PROXY', 'GEMINI_PROXY', 'WECHAT_PROXY', 'ALIPAY_PROXY']) {
      vi.stubEnv(key, 'http://proxy.test:7890');
      proxyDispatcher(key);
    }
    expect(mock.agents.slice(0, 2)).toEqual([
      { uri: 'http://proxy.test:7890', headersTimeout: 900000, bodyTimeout: 900000 },
      { uri: 'http://proxy.test:7890', headersTimeout: 900000, bodyTimeout: 900000 },
    ]);
    expect(mock.agents.slice(2, 4)).toEqual(['http://proxy.test:7890', 'http://proxy.test:7890']);
  });

  it('Gemini 独立代理同样设置 15 分钟并保留 AbortSignal', async () => {
    vi.stubEnv('GEMINI_PROXY', 'http://gemini.test:7890');
    const { GeminiGateway } = await import('../src/gateway/gemini.js');
    const signal = new AbortController().signal;
    await expect(new GeminiGateway().generateImageSync({ model: 'gemini-3-pro-image', prompt: 'test' }, signal)).rejects.toThrow('mock network error');
    expect(mock.agents.at(-1)).toEqual({ uri: 'http://gemini.test:7890', headersTimeout: 900000, bodyTimeout: 900000 });
    expect(mock.fetch.mock.calls.at(-1)?.[1]?.signal).toBe(signal);
  });
});
