// 灵镜 文生视频 API 测试 —— buildVideoT2VJob 校验 + /jobs/estimate ≡ build(reserve==settle)。
//
// 覆盖 /plan-eng-review 测试覆盖图:
//   - 非法 model/resolution/duration/mode → 400
//   - prompt 超 maxPromptChars → 400(逐模型)
//   - happyhorse audio=true → 400(R5)
//   - 可灵 mode→resSnapshot 翻译 + 快照写入
//   - /jobs/estimate 随 duration/audio/res 变,且与提交 reserve 逐字节一致(N1/N2)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);
let tenantId: string;

beforeAll(async () => {
  const t = createTenant('视频测试台');
  tenantId = t.id;
  await createUser(tenantId, 'vcreator', 'pw123456', 'creator');
  grant(tenantId, 100000);
  const r = await client.login('vcreator', 'pw123456');
  expect(r.status).toBe(200);
}, 30000); // bcrypt 登录在并行 CPU 争用下偶慢,放宽 hook 超时防 flake

describe('POST /api/jobs (video_t2v) 校验', () => {
  const base = { type: 'video_t2v', model: 'wan2.7-t2v', prompt: '一只猫在月光下奔跑' };

  it('缺 prompt → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_t2v', model: 'wan2.7-t2v' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('prompt');
  });

  it('未知模型 → 400', async () => {
    const r = await client.post('/api/jobs', { ...base, model: '不存在' });
    expect(r.status).toBe(400);
  });

  it('prompt 超 maxPromptChars(可灵 2500)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_t2v', model: 'kling-v3-t2v', prompt: '字'.repeat(2501), ratio: '16:9', mode: 'std' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('2500');
  });

  it('wan2.7 不支持的分辨率 → 400(只 720P/1080P)', async () => {
    const r = await client.post('/api/jobs', { ...base, resolution: '4K', ratio: '16:9' });
    expect(r.status).toBe(400);
  });

  it('happyhorse audio=true → 400(R5,不支持有声)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_t2v', model: 'happyhorse-1.0-t2v', prompt: '微型城市', ratio: '16:9', audio: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('有声');
  });

  it('可灵非法 mode → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_t2v', model: 'kling-v3-t2v', prompt: 'x', ratio: '16:9', mode: 'ultra' });
    expect(r.status).toBe(400);
  });

  it('duration 越界 → 400(wan2.7 2-15)', async () => {
    const r = await client.post('/api/jobs', { ...base, resolution: '720P', ratio: '16:9', duration: 20 });
    expect(r.status).toBe(400);
  });

  it('合法 wan2.7 → 202 + 快照写入', async () => {
    const r = await client.post('/api/jobs', { ...base, resolution: '1080P', ratio: '16:9', duration: 8 });
    expect(r.status).toBe(202);
    const job = getJob(r.body.id);
    const inp = JSON.parse(job!.input_json);
    expect(inp.durationSnapshot).toBe(8);
    expect(inp.resSnapshot).toBe('1080P');
    expect(inp.audioSnapshot).toBe(false);
    expect(typeof inp.priceTierSnapshot).toBe('number');
  });

  it('合法可灵 pro → resSnapshot 由 mode 翻译为 1080P(R3)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_t2v', model: 'kling-v3-t2v', prompt: '小猫', ratio: '16:9', mode: 'pro', duration: 5, audio: true });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.resSnapshot).toBe('1080P');
    expect(inp.audioSnapshot).toBe(true);
  });

  it('Seedance 2.5 支持 480P/30 秒/adaptive/有声,不支持 1080P 或 31 秒', async () => {
    const body = {
      type: 'video_t2v', model: 'doubao-seedance-2.5', prompt: '海边日落延时摄影',
      resolution: '480P', ratio: 'adaptive', duration: 30, audio: true,
    };
    const ok = await client.post('/api/jobs', body);
    expect(ok.status).toBe(202);
    const inp = JSON.parse(getJob(ok.body.id)!.input_json);
    expect(inp.resSnapshot).toBe('480P');
    expect(inp.durationSnapshot).toBe(30);
    expect(inp.audioSnapshot).toBe(true);
    expect((await client.post('/api/jobs', { ...body, resolution: '1080P' })).status).toBe(400);
    expect((await client.post('/api/jobs', { ...body, duration: 31 })).status).toBe(400);
  });
});

describe('GET /api/video-models', () => {
  it('发现列表包含 Seedance 2.5 与既有 Seedance 2.0,不泄漏 modelId', async () => {
    const r = await client.get('/api/video-models');
    expect(r.status).toBe(200);
    const keys = r.body.models.map((m: { key: string }) => m.key);
    expect(keys).toContain('doubao-seedance-2.5');
    expect(keys).toContain('doubao-seedance-2.0');
    const d = r.body.models.find((m: { key: string }) => m.key === 'doubao-seedance-2.5');
    expect(d.resolutions).toEqual(['480P', '720P']);
    expect(d.durationRange).toEqual([4, 30]);
    expect(d).not.toHaveProperty('modelId');
  });
});

describe('POST /api/jobs/estimate (video_t2v) ≡ build(N1/N2,reserve==settle)', () => {
  it('估价随 duration 变', async () => {
    const r5 = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'wan2.7-t2v', resolution: '720P', ratio: '16:9', duration: 5 });
    const r10 = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'wan2.7-t2v', resolution: '720P', ratio: '16:9', duration: 10 });
    expect(r5.body.cost).toBeGreaterThan(0);
    expect(r10.body.cost).toBe(r5.body.cost * 2); // 10s = 2 × 5s
  });

  it('估价按真实分辨率档(大师 720P=21/秒、1080P=35/秒;5s)', async () => {
    const r720 = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'wan2.7-t2v', resolution: '720P', ratio: '16:9', duration: 5 });
    const r1080 = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'wan2.7-t2v', resolution: '1080P', ratio: '16:9', duration: 5 });
    expect(r720.body.cost).toBe(5 * 21); // 105
    expect(r1080.body.cost).toBe(5 * 35); // 175(真实比值 1.67,非 ×2)
  });

  it('可灵 audio=true 加价(1.3×)', async () => {
    const noAudio = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'kling-v3-t2v', mode: 'std', ratio: '16:9', duration: 5, audio: false });
    const withAudio = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'kling-v3-t2v', mode: 'std', ratio: '16:9', duration: 5, audio: true });
    expect(withAudio.body.cost).toBeGreaterThan(noAudio.body.cost);
  });

  it('happyhorse audio=true 估价也 400(与 build 一致)', async () => {
    const r = await client.post('/api/jobs/estimate', { type: 'video_t2v', model: 'happyhorse-1.0-t2v', ratio: '16:9', duration: 5, audio: true });
    expect(r.status).toBe(400);
  });

  it('估价 ≡ 提交后预扣额(reserve==settle 前置:estimate 与 build cost 同)', async () => {
    const body = { type: 'video_t2v', model: 'kling-v3-t2v', prompt: '小猫', mode: 'pro', ratio: '1:1', duration: 7, audio: true };
    const est = await client.post('/api/jobs/estimate', body);
    const sub = await client.post('/api/jobs', { ...body });
    expect(sub.status).toBe(202);
    // 提交记的预扣 = 估价(同 costFor 派生);此处比估价与提交反馈的一致性
    expect(est.body.cost).toBeGreaterThan(0);
    const inp = JSON.parse(getJob(sub.body.id)!.input_json);
    // build 快照算出的 cost 必与 estimate 相等(同 deriveVideoT2VParams + estimateVideoCost)
    const { costFor } = await import('../src/credits/index.js');
    expect(costFor('video_t2v', inp)).toBe(est.body.cost);
  });
});
