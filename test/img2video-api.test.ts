// 灵镜 图转影片 API 测试 —— buildVideoI2VJob 校验(task 感知)+ /jobs/estimate ≡ build。
//
// 覆盖 /plan-eng-review 测试覆盖图:
//   - 非法 task / media 数错(首帧传2图、首尾帧传1图、参考生超 maxRefImages)→ 400
//   - 首帧 task 空 prompt 通过(R1.4)、参考生空 prompt → 400
//   - 首帧 task 无 ratio 也不 400(R1.3)
//   - 可灵 mode→res 无关(i2v 全 V_DASH);快照写入;estimate≡build

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

beforeAll(async () => {
  const t = createTenant('i2v 测试台');
  await createUser(t.id, 'icreator', 'pw123456', 'creator');
  grant(t.id, 100000);
  const r = await client.login('icreator', 'pw123456');
  expect(r.status).toBe(200);
}, 30000);

describe('POST /api/jobs (video_i2v) task 感知校验', () => {
  it('非法 task(model 不支持)→ 400', async () => {
    // happyhorse-i2v 只支持 first_frame
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'reference', imageRefs: ['k1'] });
    expect(r.status).toBe(400);
  });

  it('首帧传 2 图 → 400(须 1 图)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['k1', 'k2'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('首帧');
  });

  it('首尾帧传 1 图 → 400(须 2 图)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'wan2.7-i2v', task: 'first_last', imageRefs: ['k1'] });
    expect(r.status).toBe(400);
  });

  it('参考生超 maxRefImages → 400(wan2.7-r2v 上限 5)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'wan2.7-r2v', task: 'reference', prompt: '图1', imageRefs: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'] });
    expect(r.status).toBe(400);
  });

  it('参考生空 prompt → 400(R1.4 必填)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'happyhorse-1.0-r2v', task: 'reference', imageRefs: ['k1'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('描述');
  });

  it('首帧 task 空 prompt → 通过(R1.4 可选);无 ratio 不 400(R1.3)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['k1'], resolution: '720P', duration: 5 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.task).toBe('first_frame');
    expect(inp.imageRefs).toEqual(['k1']);
    expect(inp.prompt).toBeUndefined(); // 空 prompt 不存
    expect(inp.ratio).toBeUndefined(); // 首帧无 ratio
    expect(inp.resSnapshot).toBe('720P'); // R5.2:仍快照 res
    expect(typeof inp.priceTierSnapshot).toBe('number');
  });

  it('首尾帧 2 图 + duration → 202 + 快照', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'wan2.7-i2v', task: 'first_last', imageRefs: ['k1', 'k2'], resolution: '1080P', duration: 8 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.imageRefs).toEqual(['k1', 'k2']);
    expect(inp.durationSnapshot).toBe(8);
    expect(inp.resSnapshot).toBe('1080P');
  });

  it('参考生 9 图 + prompt → 202(HappyHorse-r2v 上限 9)', async () => {
    const refs = Array.from({ length: 9 }, (_, i) => 'k' + i);
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'happyhorse-1.0-r2v', task: 'reference', prompt: '[图1]中的女性拿着[图2]', imageRefs: refs, resolution: '720P', ratio: '16:9', duration: 5 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.imageRefs.length).toBe(9);
    expect(inp.ratio).toBe('16:9'); // 参考生有 ratio
  });
});

describe('POST /api/jobs/estimate (video_i2v) ≡ build', () => {
  it('估价随 duration / res 变,且与 build cost 一致', async () => {
    const { costFor } = await import('../src/credits/index.js');
    const body = { type: 'video_i2v', model: 'wan2.7-i2v', task: 'first_frame', imageRefs: ['k1'], resolution: '1080P', duration: 7 };
    const est = await client.post('/api/jobs/estimate', body);
    const sub = await client.post('/api/jobs', { ...body });
    expect(sub.status).toBe(202);
    expect(est.body.cost).toBeGreaterThan(0);
    const inp = JSON.parse(getJob(sub.body.id)!.input_json);
    expect(costFor('video_i2v', inp)).toBe(est.body.cost);
  });

  it('估价按真实分辨率档(HH i2v 720P=32/秒、1080P=56/秒;5s)', async () => {
    const r720 = await client.post('/api/jobs/estimate', { type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['k1'], resolution: '720P', duration: 5 });
    const r1080 = await client.post('/api/jobs/estimate', { type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['k1'], resolution: '1080P', duration: 5 });
    expect(r720.body.cost).toBe(5 * 32); // 160
    expect(r1080.body.cost).toBe(5 * 56); // 280(真实比值 1.78,非 ×2)
  });
});

describe('POST /api/jobs (video_i2v) Seedance 有声(generate_audio)', () => {
  it('Seedance i2v + audio=true → 202,快照 audio=true,reserve==settle', async () => {
    const { costFor } = await import('../src/credits/index.js');
    const body = { type: 'video_i2v', model: 'doubao-seedance-2.0', task: 'first_frame', imageRefs: ['k1'], resolution: '720P', duration: 5, audio: true };
    const est = await client.post('/api/jobs/estimate', body);
    const sub = await client.post('/api/jobs', { ...body });
    expect(sub.status).toBe(202);
    const inp = JSON.parse(getJob(sub.body.id)!.input_json);
    expect(inp.audio).toBe(true);        // ark.ts 据此发 generate_audio=true
    expect(inp.audioSnapshot).toBe(true);
    expect(costFor('video_i2v', inp)).toBe(est.body.cost); // 有声计价 reserve==settle
  });

  it('Seedance i2v 有声比无声贵(priceTierAudio)', async () => {
    const base = { type: 'video_i2v', model: 'doubao-seedance-2.0', task: 'first_frame', imageRefs: ['k1'], resolution: '720P', duration: 5 };
    const silent = await client.post('/api/jobs/estimate', { ...base, audio: false });
    const voiced = await client.post('/api/jobs/estimate', { ...base, audio: true });
    expect(voiced.body.cost).toBeGreaterThan(silent.body.cost);
  });

  it('Seedance i2v 不传 audio → 后端默认无声(默认开在前端;后端契约同 r2v)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'doubao-seedance-2.0', task: 'first_frame', imageRefs: ['k1'], resolution: '720P', duration: 5 });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.audioSnapshot).toBe(false);
    expect(inp.audio).toBeUndefined();
  });

  it('非 supportsAudio 模型(happyhorse i2v)传 audio=true → 400,不静默吞', async () => {
    const r = await client.post('/api/jobs', { type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'first_frame', imageRefs: ['k1'], resolution: '720P', duration: 5, audio: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('有声');
  });
});
