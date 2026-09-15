import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ options: null as any, put: vi.fn(async () => ({})), get: vi.fn(async () => ({ content: Buffer.from('test') })) }));
vi.mock('ali-oss', () => ({
  default: class {
    constructor(options: unknown) { mock.options = options; }
    put = mock.put;
    get = mock.get;
  },
}));
vi.mock('../src/config.js', () => ({ config: { oss: { enabled: true, region: 'oss-cn-hangzhou', bucket: 'test', accessKeyId: 'test-id', accessKeySecret: 'test-secret', timeoutMs: 1800000 } } }));

describe('OSS 请求超时', () => {
  it('上传与下载共用配置的 30 分钟客户端,不再使用 SDK 默认 60 秒', async () => {
    const { storage } = await import('../src/storage/index.js');
    await storage.putObject('videos/test/out.mp4', Buffer.from('video'), 'video/mp4');
    expect(mock.options.timeout).toBe(1800000);
    expect(mock.put).toHaveBeenCalledWith('videos/test/out.mp4', Buffer.from('video'), { mime: 'video/mp4' });
    expect(await storage.getObject('uploads/test/in.png')).toEqual(Buffer.from('test'));
    expect(mock.get).toHaveBeenCalledWith('uploads/test/in.png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('image'), { headers: { 'content-type': 'image/png' } })));
    try {
      await storage.putObjectFromUrl('images/test/out.png', 'https://example.test/out.png');
      expect(mock.put).toHaveBeenLastCalledWith('images/test/out.png', Buffer.from('image'), { mime: 'image/png' });
    } finally { vi.unstubAllGlobals(); }
  });
});
