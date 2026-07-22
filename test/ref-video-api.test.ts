// 灵镜 参考生影片(video_r2v)API 测试 —— buildVideoR2VJob 多模态校验 + costFor + 计价快照。
//
// 覆盖 /plan-eng-review 测试覆盖图(video_r2v 全路径):
//   - 多模态组合:图≤9/视频≤3/音频≤3 + 禁「仅音频」「文本+仅音频」(文档约束)
//   - 能力门控:非 r2v 模型(无 maxVideoRefs)发 video_r2v → 400
//   - 有声计价:audio 入快照,costFor 读快照不破 reserve≡settle(eng-review P1#1)
//   - estimate≡build;快照写入(imageRefs/videoRefs/audioRefs/ratio/audio)
//   - 回归:img2video 图片-only reference(video_i2v)未受影响 → 见 img2video-api.test.ts(独立类型,buildVideoI2VJob 未改)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { costFor, estimateVideoCost } = await import('../src/credits/index.js');
const { getR2VModel, listR2VModels } = await import('../src/gateway/video-models.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);

// 本租户输入素材前缀(IDOR 归属校验:输入 key 必须带对应前缀,否则路由 400)。
let II = '', VV = '', AA = '';

beforeAll(async () => {
  const t = createTenant('r2v 测试台');
  II = `image-inputs/${t.id}/`;
  VV = `video-inputs/${t.id}/`;
  AA = `audio-inputs/${t.id}/`;
  await createUser(t.id, 'rcreator', 'pw123456', 'creator');
  grant(t.id, 1000000);
  const r = await client.login('rcreator', 'pw123456');
  expect(r.status).toBe(200);
}, 30000);

describe('r2v 模型注册(能力门控)', () => {
  it('listR2VModels 仅含声明 maxVideoRefs 的模型(Seedance 2.0 / Fast)', () => {
    const keys = listR2VModels().map((d) => d.key).sort();
    expect(keys).toEqual(['doubao-seedance-2.0', 'doubao-seedance-2.0-fast']);
  });
  it('getR2VModel 未知/非 r2v → 回落默认(doubao-seedance-2.0)', () => {
    expect(getR2VModel('wan2.7-r2v').key).toBe('doubao-seedance-2.0'); // wan 无 maxVideoRefs → 不认
    expect(getR2VModel().key).toBe('doubao-seedance-2.0');
  });
  it('Seedance 声明 maxVideoRefs/maxAudioRefs=3 + priceTierAudio', () => {
    const d = getR2VModel('doubao-seedance-2.0');
    expect(d.maxVideoRefs).toBe(3);
    expect(d.maxAudioRefs).toBe(3);
    expect(d.priceTierAudio).toBeGreaterThan(d.priceTier); // 有声更贵
  });
});

describe('POST /api/jobs (video_r2v) 多模态组合校验', () => {
  it('能力门控:非 r2v 模型(wan2.7-r2v 无多模态)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'wan2.7-r2v', prompt: '图片1', imageRefs: [II+'k1'] });
    expect(r.status).toBe(400);
  });
  it('仅音频(无图/视频/文本)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', audioRefs: [AA+'a1'] });
    expect(r.status).toBe(400);
  });
  it('文本+仅音频(无画面来源)→ 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '配乐', audioRefs: [AA+'a1'] });
    expect(r.status).toBe(400);
  });
  it('视频超 3 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '视频1', videoRefs: [VV+'v1', VV+'v2', VV+'v3', VV+'v4'] });
    expect(r.status).toBe(400);
  });
  it('音频超 3 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '图片1', imageRefs: [II+'k1'], audioRefs: [AA+'a1', AA+'a2', AA+'a3', AA+'a4'] });
    expect(r.status).toBe(400);
  });
  it('图超 9 → 400', async () => {
    const imgs = Array.from({ length: 10 }, (_, i) => II + `k${i}`);
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '图片1', imageRefs: imgs });
    expect(r.status).toBe(400);
  });
  it('比例不支持 → 400', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '图片1', imageRefs: [II+'k1'], ratio: '2:3' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/jobs (video_r2v) 成功 + 快照', () => {
  it('全模态(文本+2图+1视频+1音频)+有声 → 202,三数组+audio 入快照', async () => {
    const r = await client.post('/api/jobs', {
      type: 'video_r2v', model: 'doubao-seedance-2.0',
      prompt: '[图片1]的人用[图片2]的杯子,背景[视频1],配[音频1]',
      imageRefs: [II+'k1', II+'k2'], videoRefs: [VV+'v1'], audioRefs: [AA+'a1'],
      resolution: '720P', ratio: '16:9', duration: 11, audio: true,
    });
    expect(r.status).toBe(202);
    const inp = JSON.parse(getJob(r.body.id)!.input_json);
    expect(inp.imageRefs).toEqual([II+'k1', II+'k2']);
    expect(inp.videoRefs).toEqual([VV+'v1']);
    expect(inp.audioRefs).toEqual([AA+'a1']);
    expect(inp.audio).toBe(true);
    expect(inp.audioSnapshot).toBe(true);
    expect(inp.ratio).toBe('16:9');
    expect(inp.task).toBe('reference');
  });

  it('纯文本(无任何 ref)+ 提示词 → 202(画面来源=文本)', async () => {
    const r = await client.post('/api/jobs', { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '一只猫在跳舞', resolution: '720P', duration: 5 });
    expect(r.status).toBe(202);
  });

  it('estimate ≡ build(reserve==settle)', async () => {
    const body = { type: 'video_r2v', model: 'doubao-seedance-2.0', prompt: '图片1', imageRefs: [II+'k1'], resolution: '720P', duration: 5, audio: true };
    const est = await client.post('/api/jobs/estimate', body);
    expect(est.status).toBe(200);
    const job = await client.post('/api/jobs', body);
    expect(job.status).toBe(202);
    expect(est.body.cost).toBe(job.body.cost);
  });
});

describe("costFor('video_r2v') 读快照(reserve==settle,含音频)", () => {
  it('有声 720P 用 priceTierAudio;快照口径', () => {
    const d = getR2VModel('doubao-seedance-2.0');
    const cost = costFor('video_r2v', {
      model: 'doubao-seedance-2.0', durationSnapshot: 11, resSnapshot: '720P', audioSnapshot: true, priceTierSnapshot: d.priceTierAudio,
    });
    expect(cost).toBe(estimateVideoCost(11, d.priceTierAudio!, '720P', true));
  });
  it('无声 720P 用 priceTier(对照)', () => {
    const d = getR2VModel('doubao-seedance-2.0');
    const cost = costFor('video_r2v', {
      model: 'doubao-seedance-2.0', durationSnapshot: 5, resSnapshot: '720P', audioSnapshot: false, priceTierSnapshot: d.priceTier,
    });
    expect(cost).toBe(estimateVideoCost(5, d.priceTier, '720P', false));
  });
});
