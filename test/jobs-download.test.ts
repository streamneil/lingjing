// 灵镜 成品下载代理端点 —— GET /api/jobs/:id/download/:idx
//
// 根因背景:OSS 签名 URL 无 CORS 头,前端 fetch 被拦 → 回落 window.open → 下载一闪而过。
// 正解:同源代理端点,后端拉对象 + Content-Disposition:attachment 回传。
//
// 覆盖:
//   - 鉴权:未登录 → 401
//   - 归属:跨租户下载他人成品 → 404(不泄露存在性)
//   - 边界:idx 越界 / 非整数 → 404;未完成 job → 404
//   - 正常:done 图/视频 → 200 + attachment 头 + 正确 Content-Type + 字节落地
//   - 多产物:idx=1 取第二张图(parseOutputKeys 索引正确)

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

// storage mock:getObject 按 key 返回可辨识的假字节;签名/上传走 identity。
const FAKE: Record<string, Buffer> = {
  'img-key-0': Buffer.from('PNG-IMAGE-ZERO'),
  'img-key-1': Buffer.from('PNG-IMAGE-ONE'),
  'vid-key': Buffer.from('MP4-VIDEO-BYTES'),
};
vi.mock('../src/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/storage/index.js')>(
    '../src/storage/index.js',
  );
  return {
    ...actual, // 保留 parseOutputKeys 等纯函数
    getObject: vi.fn(async (k: string) => {
      if (FAKE[k]) return FAKE[k];
      throw new Error('no such object: ' + k);
    }),
    getSignedUrl: vi.fn(async (k: string) => 'https://signed/' + k),
    putObject: vi.fn(async (k: string) => k),
  };
});

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { enqueueJob, markDone } = await import('../src/queue/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const owner = new Client(app);
const other = new Client(app);

let tid = '';
let imgJobId = '';
let vidJobId = '';
let runningJobId = '';

beforeAll(async () => {
  const t = createTenant('下载测试台');
  tid = t.id;
  createUser(t.id, 'dlowner', 'pw123456', 'creator');
  grant(t.id, 100000);
  expect((await owner.login('dlowner', 'pw123456')).status).toBe(200);

  // 另一个租户(跨租户隔离用)
  const t2 = createTenant('别家');
  createUser(t2.id, 'dlother', 'pw123456', 'creator');
  grant(t2.id, 100000);
  expect((await other.login('dlother', 'pw123456')).status).toBe(200);

  // 图片 job:两产物(JSON key 数组)→ done
  imgJobId = enqueueJob('image', { prompt: 'x' }, tid);
  markDone(imgJobId, JSON.stringify(['img-key-0', 'img-key-1']), 'none', 'image');

  // 视频 job:单产物(裸 key)→ done
  vidJobId = enqueueJob('video', { prompt: 'y' }, tid);
  markDone(vidJobId, 'vid-key', 'none', 'video');

  // 未完成 job(running)
  runningJobId = enqueueJob('image', { prompt: 'z' }, tid);
}, 30000);

describe('GET /api/jobs/:id/download/:idx', () => {
  it('未登录 → 401', async () => {
    const c = new Client(app);
    const r = await c.getRaw(`/api/jobs/${imgJobId}/download/0`);
    expect(r.status).toBe(401);
  });

  it('正常下载图片 idx=0 → 200 + attachment + image/png + 正确字节', async () => {
    const r = await owner.getRaw(`/api/jobs/${imgJobId}/download/0`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(String(r.headers['content-disposition'])).toContain('attachment');
    expect(String(r.headers['content-disposition'])).toContain(`lingjing-${imgJobId}-1.png`);
    expect(r.buf.toString()).toBe('PNG-IMAGE-ZERO');
  });

  it('多产物 idx=1 → 取第二张(parseOutputKeys 索引正确)', async () => {
    const r = await owner.getRaw(`/api/jobs/${imgJobId}/download/1`);
    expect(r.status).toBe(200);
    expect(r.buf.toString()).toBe('PNG-IMAGE-ONE');
    expect(String(r.headers['content-disposition'])).toContain(`lingjing-${imgJobId}-2.png`);
  });

  it('视频单产物 idx=0 → 200 + video/mp4', async () => {
    const r = await owner.getRaw(`/api/jobs/${vidJobId}/download/0`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.buf.toString()).toBe('MP4-VIDEO-BYTES');
  });

  it('idx 越界 → 404', async () => {
    expect((await owner.getRaw(`/api/jobs/${imgJobId}/download/9`)).status).toBe(404);
  });

  it('idx 非整数 → 404', async () => {
    expect((await owner.getRaw(`/api/jobs/${imgJobId}/download/abc`)).status).toBe(404);
  });

  it('未完成 job → 404', async () => {
    expect((await owner.getRaw(`/api/jobs/${runningJobId}/download/0`)).status).toBe(404);
  });

  it('不存在的 job → 404', async () => {
    expect((await owner.getRaw(`/api/jobs/nope-nope/download/0`)).status).toBe(404);
  });

  it('跨租户下载他人成品 → 404(归属隔离,不泄露存在性)', async () => {
    const r = await other.getRaw(`/api/jobs/${imgJobId}/download/0`);
    expect(r.status).toBe(404);
  });
});
