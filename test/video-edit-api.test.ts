// 灵镜 视频编辑 API 测试 —— buildVideoEditJob 校验(sidecar 时长真相)+ estimate≡build + 对抗。
//
// 覆盖 /plan-eng-review 测试矩阵:
//   - sidecar 缺失 / 时长超模型界 / HH 空 prompt / 参考图超限 → 400
//   - ★ 对抗(E5):提交体伪造 duration/billableSeconds 字段 → 服务端只认 sidecar,伪造无效
//   - estimate≡build(同读 sidecar);/edit-models 投影
//
// storage 模块 mock 成内存 map:sidecar 读写不碰真实 MinIO。

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

// 内存版存储:putObject/getObject 走 map(sidecar 元数据);其余维持桩
const mem = new Map<string, Buffer>();
vi.mock('../src/storage/index.js', () => ({
  putObject: vi.fn(async (key: string, data: Buffer | string) => { mem.set(key, Buffer.from(data)); return key; }),
  getObject: vi.fn(async (key: string) => { const b = mem.get(key); if (!b) throw new Error('NoSuchKey'); return b; }),
  putObjectFromUrl: vi.fn(async (key: string) => key),
  getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  signOutputUrls: vi.fn(async () => []),
  storage: {
    putObject: vi.fn(async (key: string, data: Buffer | string) => { mem.set(key, Buffer.from(data)); return key; }),
    getObject: vi.fn(async (key: string) => { const b = mem.get(key); if (!b) throw new Error('NoSuchKey'); return b; }),
    putObjectFromUrl: vi.fn(async (key: string) => key),
    getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  },
}));

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant, costFor } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);

// 预置两个 sidecar(模拟 /video-uploads 探测产物):8s 视频 + 30s 视频
const VID8 = 'video-inputs/t/vid8.mp4';
const VID30 = 'video-inputs/t/vid30.mp4';
mem.set(`${VID8}.meta.json`, Buffer.from(JSON.stringify({ duration: 8, width: 1280, height: 720, size: 1000 })));
mem.set(`${VID30}.meta.json`, Buffer.from(JSON.stringify({ duration: 30, width: 1920, height: 1080, size: 2000 })));

beforeAll(async () => {
  const t = createTenant('视频编辑测试台');
  createUser(t.id, 'vecreator', 'pw123456', 'creator');
  grant(t.id, 100000);
  const r = await client.login('vecreator', 'pw123456');
  expect(r.status).toBe(200);
}, 30000);

describe('POST /api/jobs (video_edit) 校验', () => {
  it('无 videoRef → 400 请先上传视频', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'wan2.7-videoedit', prompt: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('上传视频');
  });

  it('sidecar 缺失 → 400 元数据丢失', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'wan2.7-videoedit', videoRef: 'video-inputs/t/ghost.mp4', prompt: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('元数据');
  });

  it('30s 视频投 wan(限 2-10s)→ 400 点名界限与实际秒数', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'wan2.7-videoedit', videoRef: VID30, prompt: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('2-10');
    expect(r.body.error).toContain('30.0');
  });

  it('HH 空 prompt → 400 请输入编辑指令', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'happyhorse-1.0-video-edit', videoRef: VID8 });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('编辑指令');
  });

  it('参考图超限(wan 最多 4)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'wan2.7-videoedit', videoRef: VID8, imageRefs: ['a', 'b', 'c', 'd', 'e'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('最多 4');
  });

  it('非 edit 模型 key → 400 未知编辑模型', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'wan2.7-i2v', videoRef: VID8, prompt: 'x' });
    expect(r.status).toBe(400);
  });

  it('HH 不支持截断 → 传 truncateDuration 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_edit', model: 'happyhorse-1.0-video-edit', videoRef: VID30, prompt: 'x', truncateDuration: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('截断');
  });

  it('合法提交(wan 8s + 截断 5s + 原声)→ 202 + 快照 billable=8+5=13', async () => {
    const r = await client.post('/api/jobs', {
      type: 'video_edit', model: 'wan2.7-videoedit', videoRef: VID8, imageRefs: ['ref1'],
      prompt: '把衣服换成参考图', resolution: '720P', truncateDuration: 5, audioSetting: 'origin',
    });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.task).toBe('edit');
    expect(inp.videoRef).toBe(VID8);
    expect(inp.inputDurationSnapshot).toBe(8);
    expect(inp.billableSecondsSnapshot).toBe(13); // 8 + min(5,8)
    expect(inp.truncateDuration).toBe(5);
    expect(inp.audioSetting).toBe('origin');
    expect(inp.priceTierSnapshot).toBe(6);
  });

  it('HH 30s 输入 → billable=30+15=45(输出截 15)', async () => {
    const r = await client.post('/api/jobs', {
      type: 'video_edit', model: 'happyhorse-1.0-video-edit', videoRef: VID30, prompt: '风格化', resolution: '720P',
    });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.billableSecondsSnapshot).toBe(45);
  });

  it('★ 对抗:伪造 duration / billableSeconds / inputDurationSnapshot → 全部无效,只认 sidecar', async () => {
    const r = await client.post('/api/jobs', {
      type: 'video_edit', model: 'wan2.7-videoedit', videoRef: VID8, prompt: 'x', resolution: '720P',
      duration: 1, billableSeconds: 1, billableSecondsSnapshot: 1, inputDurationSnapshot: 1, durationSnapshot: 1,
    });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.inputDurationSnapshot).toBe(8); // sidecar 真相,非伪造的 1
    expect(inp.billableSecondsSnapshot).toBe(16); // 8 + 8
    expect(costFor('video_edit', inp)).toBeGreaterThan(costFor('video_edit', { model: 'wan2.7-videoedit', billableSecondsSnapshot: 2, resSnapshot: '720P', priceTierSnapshot: 6 }));
  });
});

describe('POST /api/jobs/estimate (video_edit) ≡ build', () => {
  it('estimate 与 build 同读 sidecar,cost 一致;返回 inputDuration', async () => {
    const body = { type: 'video_edit', model: 'wan2.7-videoedit', videoRef: VID8, prompt: 'x', resolution: '1080P' };
    const est = await client.post('/api/jobs/estimate', body);
    expect(est.status).toBe(200);
    expect(est.body.inputDuration).toBe(8);
    const sub = await client.post('/api/jobs', body);
    expect(sub.status).toBe(202);
    const inp = JSON.parse(getJob(sub.body.id)!.input_json);
    expect(costFor('video_edit', inp)).toBe(est.body.cost);
  });

  it('estimate 无 sidecar → 400', async () => {
    const r = await client.post('/api/jobs/estimate', { type: 'video_edit', model: 'wan2.7-videoedit', videoRef: 'video-inputs/t/ghost.mp4' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/edit-models', () => {
  it('吐两模型 + 输入视频约束字段;默认 wan', async () => {
    const r = await client.get('/api/edit-models');
    expect(r.status).toBe(200);
    expect(r.body.models.length).toBe(2);
    expect(r.body.default).toBe('wan2.7-videoedit');
    const wan = r.body.models.find((m: any) => m.key === 'wan2.7-videoedit');
    expect(wan.videoDurRange).toEqual([2, 10]);
    expect(wan.supportsTruncate).toBe(true);
    expect(wan.maxRefImages).toBe(4);
    expect(wan.priceTier).toBeUndefined(); // 不泄计费细节
  });
});
