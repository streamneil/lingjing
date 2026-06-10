// 灵镜 视频编辑 worker 集成测试 —— runMediaVideoJob(withVideo)端到端 + i2v 薄包装回归。
//
// 覆盖 /plan-eng-review 测试矩阵:
//   - video_edit dispatcher:输入视频 publish 后 submit 收到公网 URL;media 由网关组装
//   - reserve==settle:settle 读 billable 快照与提交 reserve 同一 costFor
//   - 失败 release:无 videoRef → failed
//   - i2v 回归:共享 runner 抽取后 runVideoI2VJob 行为不变(空 prompt 跳审仍生效)

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

vi.mock('../src/pipeline/moderation.js', () => ({
  moderateScript: vi.fn(async () => ({ allowed: true })),
  moderatePrompt: vi.fn(async (p: string) => (p.trim() ? { allowed: true } : { allowed: false, reason: '提示词为空' })),
  moderateImageInput: vi.fn(async () => ({ allowed: true })),
  moderateOutput: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../src/pipeline/ai-label.js', () => ({
  applyAiLabel: vi.fn(async (buf: Buffer) => ({ buffer: buf, applied: true })),
  probeAudioDuration: vi.fn(async () => 5),
  probeVideoMeta: vi.fn(async () => ({ duration: 5, width: 1280, height: 720 })),
  concatVideos: vi.fn(async (bufs: Buffer[]) => bufs[0]),
}));
vi.mock('../src/gateway/media-publisher.js', () => ({
  getMediaPublisher: () => ({ publish: vi.fn(async (k: string) => `https://cdn/${k}`) }),
  tenantDelivery: () => 'hosted',
}));

const _realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (typeof url === 'string' && url.startsWith('http://fake/')) {
    return new Response(Buffer.from('fake-video-bytes'), { status: 200 });
  }
  return _realFetch(url, init);
}) as typeof fetch;

let lastSubmit: any = null;
vi.mock('../src/gateway/baichuan.js', () => ({
  getGateway: () => ({
    async submitVideoT2V(input: any) { lastSubmit = input; return 'provider-edit-task'; },
    async fetchJobStatus() {
      return { status: 'succeeded', videoUrl: 'http://fake/edited.mp4', aiLabel: 'none' as const };
    },
  }),
}));
vi.mock('../src/storage/index.js', () => ({
  storage: {
    putObject: vi.fn(async (key: string) => key),
    putObjectFromUrl: vi.fn(async (key: string) => key),
    getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
    getObject: vi.fn(async () => { throw new Error('NoSuchKey'); }),
  },
  getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  getObject: vi.fn(async () => { throw new Error('NoSuchKey'); }),
  putObject: vi.fn(async (key: string) => key),
}));

const { enqueueJob, getJob } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');
const { grant, balance, costFor } = await import('../src/credits/index.js');
const { config } = await import('../src/config.js');

const TID = config.defaultTenantId;
beforeEach(() => { lastSubmit = null; });

function editInput(over: Record<string, unknown> = {}) {
  return {
    model: 'wan2.7-videoedit', task: 'edit',
    videoRef: 'video-inputs/t/in.mp4', imageRefs: ['uploads/ref.png'],
    prompt: '把衣服换成参考图', resolution: '720P',
    resSnapshot: '720P', priceTierSnapshot: 6, audioSnapshot: false,
    inputDurationSnapshot: 8, billableSecondsSnapshot: 16,
    ...over,
  };
}

describe('runVideoEditJob(共享 runner withVideo)集成', () => {
  it('编辑:视频+参考图 publish 后 submit 收公网 URL → done + settle==reserve', async () => {
    grant(TID, 10000);
    const before = balance(TID);
    const input = editInput();
    const cost = costFor('video_edit', input);
    const id = enqueueJob('video_edit', input, TID);
    expect(await tick()).toBe(true);
    const job = getJob(id)!;
    expect(job.status).toBe('done');
    expect(lastSubmit.videoRef).toBe('https://cdn/video-inputs/t/in.mp4'); // publish 覆写
    expect(lastSubmit.imageRefs).toEqual(['https://cdn/uploads/ref.png']);
    expect(lastSubmit.task).toBe('edit');
    expect(balance(TID)).toBe(before - cost); // reserve==settle
    expect(cost).toBeGreaterThan(0);
  });

  it('wan 空 prompt(纯指令可选)→ 跳过送审照常完成', async () => {
    grant(TID, 10000);
    const id = enqueueJob('video_edit', editInput({ prompt: undefined, imageRefs: [] }), TID);
    await tick();
    expect(getJob(id)!.status).toBe('done');
    expect(lastSubmit.imageRefs).toEqual([]);
  });

  it('坏数据:无 videoRef → failed(视频编辑缺少输入视频)+ release', async () => {
    grant(TID, 10000);
    const before = balance(TID);
    const id = enqueueJob('video_edit', editInput({ videoRef: undefined }), TID);
    await tick();
    const job = getJob(id)!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('输入视频');
    expect(balance(TID)).toBe(before); // 无 reserve(直接 enqueue)→ 余额不变
  });

  it('i2v 回归:共享 runner 抽取后首帧空 prompt 仍走通', async () => {
    grant(TID, 10000);
    const input = {
      model: 'wan2.7-i2v', task: 'first_frame', imageRefs: ['uploads/a.png'],
      resolution: '720P', duration: 5,
      durationSnapshot: 5, resSnapshot: '720P', audioSnapshot: false, priceTierSnapshot: 5,
    };
    const id = enqueueJob('video_i2v', input, TID);
    await tick();
    expect(getJob(id)!.status).toBe('done');
    expect(lastSubmit.imageRefs).toEqual(['https://cdn/uploads/a.png']);
    expect(lastSubmit.videoRef).toBeUndefined();
  });
});
