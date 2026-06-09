// 灵镜 concatAudio ffmpeg 缺失命脉测 —— 独立文件(mock ai-label.ffmpegAvailable 不污染其它文件)。
//
// 覆盖 /plan-eng-review E2:多段拼接遇 ffmpeg 缺失(私有化未装)时优雅报错而非崩,
// worker 据此 markFailed+release。单段早返路径在 tts.test.ts(不依赖 ffmpeg)。

import { describe, it, expect, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

// mock ai-label 的 ffmpegAvailable → false(模拟无 ffmpeg);concatAudio 从此 import 它。
vi.mock('../src/pipeline/ai-label.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, ffmpegAvailable: async () => false };
});

const { concatAudio } = await import('../src/pipeline/concat-audio.js');

describe('concatAudio 多段 + ffmpeg 缺失', () => {
  it('多段无 ffmpeg → 抛明确 ffmpeg 错(不崩)', async () => {
    await expect(concatAudio([Buffer.from('a'), Buffer.from('b')])).rejects.toThrow(/ffmpeg/);
  });

  it('单段仍早返(即使无 ffmpeg)', async () => {
    const buf = Buffer.from('single');
    expect(await concatAudio([buf])).toBe(buf);
  });
});
