// 灵镜 失败隔离 E2E —— /plan-eng-review D7 的护城河卵论点验证(必测)。
//
// 断言:并发提交两个任务,mock 百炼让其中一个崩,另一个仍正常完成,且平台仍可响应。
// 证明"单任务失败不影响其它任务和平台可用性"(PRD 验收第5条)。
//
// 用 vitest mock 网关与存储 → 无需真实百炼 key、无需 MinIO,纯逻辑验证失败隔离。

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// 用内存 SQLite,避免污染真实库 / 测试间互相干扰
process.env.DB_FILE = ':memory:';
process.env.BAICHUAN_AVATAR_MODEL = 'test-model';

// ── mock TTS:script 含 "BOOM" 的任务在 TTS 阶段抛错(模拟百炼链路某步崩),其它出假音频 ──
vi.mock('../src/gateway/cosyvoice.js', () => ({
  synthesizeSpeech: vi.fn(async (p: { text: string }) => {
    if (p.text.includes('BOOM')) throw new Error('mock 百炼崩溃');
    return Buffer.from('fake-audio');
  }),
}));

// ── mock AI 标识后处理:测试不跑真实 ffmpeg / 不抓真实视频 URL ──
vi.mock('../src/pipeline/ai-label.js', () => ({
  applyAiLabel: vi.fn(async (buf: Buffer) => ({ buffer: buf, applied: true })),
  probeAudioDuration: vi.fn(async () => 5), // 假装 5s,通过时长校验
  concatVideos: vi.fn(async (bufs: Buffer[]) => bufs[0]), // 单/多段:返回首段(测试不跑真 ffmpeg)
}));

// worker 取回成品时会 fetch(videoUrl);测试里桩掉为假视频字节
const _realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (typeof url === 'string' && url.startsWith('http://fake/')) {
    return new Response(Buffer.from('fake-video-bytes'), { status: 200 });
  }
  return _realFetch(url, init);
}) as typeof fetch;

// ── mock 网关:正常任务一次轮询即成功 ──
vi.mock('../src/gateway/baichuan.js', () => ({
  getGateway: () => ({
    async submitVideo() {
      return `provider-task-${Math.random().toString(36).slice(2)}`;
    },
    async fetchJobStatus() {
      return { status: 'succeeded', videoUrl: 'http://fake/video.mp4', aiLabel: 'none' as const };
    },
  }),
}));

// ── mock 存储:不连真实 MinIO ──
vi.mock('../src/storage/index.js', () => ({
  storage: {
    putObject: vi.fn(async (key: string) => key),
    putObjectFromUrl: vi.fn(async (key: string) => key),
    getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  },
  getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
}));

// 注意:mock 之后再动态导入被测模块,确保 mock 生效
const { enqueueVideo, getJob } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');

function input(script: string) {
  return { avatarRef: 'preset-1', voiceRef: 'longjing', script };
}

describe('失败隔离', () => {
  it('一个任务崩溃,另一个仍完成,且队列继续工作', async () => {
    // 并发提交:第一个会崩(BOOM),第二个正常
    const badId = enqueueVideo(input('BOOM 这条会崩'));
    const goodId = enqueueVideo(input('这是一条正常的播报文案'));

    // worker 逐个处理(tick 处理一个)。坏任务先入队,先被处理。
    const processed1 = await tick(); // 处理 badId(失败)
    const processed2 = await tick(); // 处理 goodId(成功)

    expect(processed1).toBe(true);
    expect(processed2).toBe(true);

    const bad = getJob(badId)!;
    const good = getJob(goodId)!;

    // 关键断言:坏任务失败,好任务不受牵连地完成
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('mock 百炼崩溃');
    expect(good.status).toBe('done');
    expect(good.output_url).toBeTruthy();

    // 平台仍可响应:坏任务之后还能继续入队 + 处理新任务
    const afterId = enqueueVideo(input('崩溃之后的新任务'));
    const processed3 = await tick();
    expect(processed3).toBe(true);
    expect(getJob(afterId)!.status).toBe('done');
  });

  it('失败任务可重试,重试后恢复为 queued', async () => {
    const { retryJob } = await import('../src/queue/index.js');
    const badId = enqueueVideo(input('BOOM 再崩一次'));
    await tick();
    expect(getJob(badId)!.status).toBe('failed');

    const ok = retryJob(badId);
    expect(ok).toBe(true);
    expect(getJob(badId)!.status).toBe('queued');
    expect(getJob(badId)!.error).toBeNull();
  });
});
