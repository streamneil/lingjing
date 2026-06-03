// 灵镜 AI 标识 + 音频时长校验测试(用真实 ffmpeg/ffprobe 生成小素材验证)。
// ffmpeg 不可用的环境会跳过(applied=false / duration=null),不让测试失败。

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';

const { applyAiLabel, probeAudioDuration } = await import('../src/pipeline/ai-label.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// 用 ffmpeg 现造一个 1s 测试视频 / 2s 测试音频(避免依赖外部素材)
function makeTestVideo(): Buffer {
  const out = '/tmp/lj-test-vid.mp4';
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-pix_fmt', 'yuv420p', out]);
  return require('node:fs').readFileSync(out);
}
function makeTestAudio(seconds: number): Buffer {
  const out = `/tmp/lj-test-aud-${seconds}.mp3`;
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, out]);
  return require('node:fs').readFileSync(out);
}

describe.skipIf(!hasFfmpeg)('AI 标识后处理', () => {
  it('给视频打标识,返回 applied=true 且输出非空', async () => {
    const vid = makeTestVideo();
    const { buffer, applied } = await applyAiLabel(vid, { text: 'AI 合成' });
    expect(applied).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasFfmpeg)('音频时长校验', () => {
  it('2s 音频测出约 2 秒', async () => {
    const aud = makeTestAudio(2);
    const dur = await probeAudioDuration(aud);
    expect(dur).not.toBeNull();
    expect(dur!).toBeGreaterThan(1.5);
    expect(dur!).toBeLessThan(3);
  });
});

// 降级行为:ffmpeg 缺失时(无法处理)直接原样返回 applied=false,不抛错。
// ffmpeg 存在时,坏输入会抛错(交由 worker 标 job failed,合理)。
describe.skipIf(hasFfmpeg)('降级行为(ffmpeg 缺失时)', () => {
  it('applyAiLabel 原样返回 buffer + applied=false', async () => {
    const { buffer, applied } = await applyAiLabel(Buffer.from('not-a-real-video'));
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(applied).toBe(false);
  });
});
