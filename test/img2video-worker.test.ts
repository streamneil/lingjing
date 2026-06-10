// 灵镜 图转影片 worker 集成测试 —— runVideoI2VJob + finalizeVideoJob 端到端。
//
// 覆盖 /plan-eng-review 测试覆盖图:
//   - i2v dispatcher:video_i2v job 走 runVideoI2VJob(送审 prompt + 各图 + publish + submit + 轮询 + 尾段)
//   - finalizeVideoJob:抓成品 → moderateOutput → applyAiLabel(开/关两支)→ putObject → markDone → settle
//   - reserve==settle:settle 扣的与提交时 reserve 的 costFor('video_i2v', 快照) 一致(差额 0)
//   - 输入图 publish 后 submit 收到的是公网 URL、media 按 task 组装
//
// mock 网关/存储/送审/ffmpeg → 无需真实百炼 key / MinIO / ffmpeg。

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

// moderatePrompt 拒空串(贴生产真相:空提示词判「提示词为空」)→ 验 worker 对首帧空 prompt 跳过送审。
vi.mock('../src/pipeline/moderation.js', () => ({
  moderateScript: vi.fn(async () => ({ allowed: true })),
  moderatePrompt: vi.fn(async (p: string) => (p.trim() ? { allowed: true } : { allowed: false, reason: '提示词为空' })),
  moderateImageInput: vi.fn(async () => ({ allowed: true })),
  moderateOutput: vi.fn(async () => ({ allowed: true })),
}));

let aiLabelEnabled = true;
vi.mock('../src/pipeline/ai-label.js', () => ({
  applyAiLabel: vi.fn(async (buf: Buffer) => ({ buffer: buf, applied: true })),
  probeAudioDuration: vi.fn(async () => 5),
  concatVideos: vi.fn(async (bufs: Buffer[]) => bufs[0]),
}));

// 输入图 publish:存储 key → 公网 URL(供 submit 读)
vi.mock('../src/gateway/media-publisher.js', () => ({
  getMediaPublisher: () => ({ publish: vi.fn(async (k: string) => `https://cdn/${k}`) }),
  tenantDelivery: () => 'hosted',
}));

// 抓成品:桩为假视频字节
const _realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (typeof url === 'string' && url.startsWith('http://fake/')) {
    return new Response(Buffer.from('fake-video-bytes'), { status: 200 });
  }
  return _realFetch(url, init);
}) as typeof fetch;

// 网关:捕获 submit 入参(校验 publish 后的 URL + media 组装),一次轮询即成功
let lastSubmit: any = null;
vi.mock('../src/gateway/baichuan.js', () => ({
  getGateway: () => ({
    async submitVideoT2V(input: any) {
      lastSubmit = input;
      return 'provider-i2v-task';
    },
    async fetchJobStatus() {
      return { status: 'succeeded', videoUrl: 'http://fake/i2v.mp4', aiLabel: 'none' as const };
    },
  }),
}));

const putObject = vi.fn(async (key: string, _buf: Buffer, _ct: string) => key);
vi.mock('../src/storage/index.js', () => ({
  storage: {
    putObject,
    putObjectFromUrl: vi.fn(async (key: string) => key),
    getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  },
  getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
}));

// AI 标识开关读 tenant_setting;桩 db 设置在测试内按需切换
const { enqueueJob, getJob } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');
const { grant, balance, costFor } = await import('../src/credits/index.js');
const { config } = await import('../src/config.js');

const TID = config.defaultTenantId;

beforeEach(() => {
  lastSubmit = null;
  putObject.mockClear();
});

// 构造一个已快照的 i2v input(模拟 buildVideoI2VJob 产物)
function i2vInput(over: Record<string, unknown> = {}) {
  return {
    model: 'wan2.7-i2v',
    task: 'first_frame',
    imageRefs: ['uploads/a.png'],
    resolution: '720P',
    duration: 5,
    durationSnapshot: 5,
    resSnapshot: '720P',
    audioSnapshot: false,
    priceTierSnapshot: 5,
    ...over,
  };
}

describe('runVideoI2VJob + finalizeVideoJob 集成', () => {
  it('首帧 i2v(空 prompt):跳过送审 → 走完链路 done + settle == reserve', async () => {
    grant(TID, 10000);
    const before = balance(TID);
    const input = i2vInput();
    const cost = costFor('video_i2v', input); // 提交时 reserve 用的同一函数
    const id = enqueueJob('video_i2v', input, TID);

    const processed = await tick();
    expect(processed).toBe(true);

    const job = getJob(id)!;
    expect(job.status).toBe('done');
    expect(job.output_url).toBeTruthy();
    // submit 收到 publish 后的公网 URL + first_frame media 1 元素
    expect(lastSubmit.imageRefs).toEqual(['https://cdn/uploads/a.png']);
    expect(lastSubmit.task).toBe('first_frame');
    // reserve==settle:整条链路只扣了 cost(grant - cost)
    expect(balance(TID)).toBe(before - cost);
    // 成品落了存储(applyAiLabel 开 → postprocess)
    expect(putObject).toHaveBeenCalledOnce();
    expect(job.ai_label).toBe('postprocess');
  });

  it('首尾帧 i2v:submit 收到 2 张公网图', async () => {
    grant(TID, 10000);
    const input = i2vInput({ model: 'wan2.7-i2v', task: 'first_last', imageRefs: ['uploads/f.png', 'uploads/l.png'] });
    const id = enqueueJob('video_i2v', input, TID);
    await tick();
    expect(getJob(id)!.status).toBe('done');
    expect(lastSubmit.imageRefs).toEqual(['https://cdn/uploads/f.png', 'https://cdn/uploads/l.png']);
  });

  it('参考生 i2v:submit 收到 N 张公网图 + prompt', async () => {
    grant(TID, 10000);
    const input = i2vInput({
      model: 'happyhorse-1.0-r2v', task: 'reference', prompt: '[图1]中的女性',
      imageRefs: ['uploads/1.png', 'uploads/2.png'], ratio: '16:9', priceTierSnapshot: 4,
    });
    const id = enqueueJob('video_i2v', input, TID);
    await tick();
    expect(getJob(id)!.status).toBe('done');
    expect(lastSubmit.imageRefs).toEqual(['https://cdn/uploads/1.png', 'https://cdn/uploads/2.png']);
    expect(lastSubmit.prompt).toBe('[图1]中的女性');
  });

  it('参考生敏感 prompt → 送审拒绝(非空 prompt 仍送审)', async () => {
    const { moderatePrompt } = await import('../src/pipeline/moderation.js');
    (moderatePrompt as any).mockImplementationOnce(async () => ({ allowed: false, reason: '提示词包含敏感内容' }));
    grant(TID, 10000);
    const input = i2vInput({ model: 'happyhorse-1.0-r2v', task: 'reference', prompt: '违规内容', imageRefs: ['uploads/1.png'], ratio: '16:9', priceTierSnapshot: 4 });
    const id = enqueueJob('video_i2v', input, TID);
    await tick();
    const job = getJob(id)!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('送审拒绝');
  });

  it('无输入图 → 失败(图转影片缺少输入图)', async () => {
    grant(TID, 10000);
    const id = enqueueJob('video_i2v', i2vInput({ imageRefs: [] }), TID);
    await tick();
    const job = getJob(id)!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('输入图');
  });
});
