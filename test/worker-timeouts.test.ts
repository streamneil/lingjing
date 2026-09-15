import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.IMAGE_TIMEOUT_MS = '900000';
process.env.VIDEO_TIMEOUT_MS = '1800000';
process.env.POLL_INTERVAL_MS = '30000';

vi.mock('../src/pipeline/moderation.js', () => ({
  moderateScript: async () => ({ allowed: true }), moderatePrompt: async () => ({ allowed: true }),
  moderateImageInput: async () => ({ allowed: true }), moderateOutput: async () => ({ allowed: true }),
}));
vi.mock('../src/gateway/media-publisher.js', () => ({ getMediaPublisher: () => ({ publish: async (key: string) => `https://cdn/${key}` }), tenantDelivery: () => 'hosted' }));
vi.mock('../src/gateway/cosyvoice.js', () => ({ synthesizeSpeechHttp: async () => Buffer.from('audio') }));
vi.mock('../src/pipeline/ai-label.js', () => ({ probeAudioDuration: async () => 5, concatVideos: async (buffers: Buffer[]) => buffers[0], applyAiLabel: async (buffer: Buffer) => ({ buffer, applied: false }) }));
vi.mock('../src/storage/index.js', () => ({ storage: { putObject: async (key: string) => key, putObjectFromUrl: async (key: string) => key }, getSignedUrl: async (key: string) => `https://cdn/${key}` }));

const waitForAbort = (_input: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});
vi.mock('../src/gateway/baichuan.js', () => ({ getGateway: () => ({
  submitImage: async () => 'image-task', submitImageEdit: async () => 'edit-task',
  submitVideo: async () => 'avatar-task', submitVideoT2V: async () => 'video-task',
  fetchImageStatus: async () => ({ status: 'running' }), fetchJobStatus: async () => ({ status: 'running' }),
  generateImageSync: waitForAbort, editImage: waitForAbort,
}) }));

const { db } = await import('../src/db/index.js');
const { enqueueJob, getJob } = await import('../src/queue/index.js');
const { tick } = await import('../src/queue/worker.js');

beforeEach(() => { db.prepare('DELETE FROM job').run(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('worker 图片超时', () => {
  it.each([
    ['异步文生图', { model: 'qwen-image', mode: 'text2img' }],
    ['同步文生图', { model: 'gpt-image-2', mode: 'text2img' }],
    ['同步编辑', { model: 'qwen-image-edit', mode: 'img2img', imageRefs: ['uploads/a.png'] }],
    ['异步编辑', { model: 'wan2.7-image', mode: 'img2img', imageRefs: ['uploads/a.png'] }],
  ])('%s 不在旧 10 分钟截止,15 分钟后终止', async (_label, input) => {
    const id = enqueueJob('ai_image', { prompt: '测试图片', count: 1, ...input });
    const work = tick();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(getJob(id)!.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await work;
    expect(getJob(id)!.status).toBe('failed');
    expect(getJob(id)!.error_detail).toContain('生成超时');
  });
});

describe('worker 所有视频类型超时', () => {
  it.each(['video', 'video_t2v', 'video_i2v', 'video_edit', 'video_r2v'] as const)('%s 不在旧 10/15 分钟截止,30 分钟后终止', async (type) => {
    const input = type === 'video'
      ? { avatarRef: 'preset-1', voiceRef: 'Cherry', script: '测试播报文案' }
      : { model: 'doubao-seedance-2.5', prompt: '测试视频', imageRefs: ['uploads/a.png'], videoRef: 'uploads/a.mp4', videoRefs: ['uploads/a.mp4'], task: 'first_frame', duration: 5 };
    const id = enqueueJob(type, input);
    const work = tick();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(getJob(id)!.status).toBe('running');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await work;
    expect(getJob(id)!.status).toBe('failed');
    expect(getJob(id)!.error_detail).toContain('生成超时');
  });
});
