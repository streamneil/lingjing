// 灵镜 音频拼接 — 把分段合成的 MP3 拼成一条。
//
// 决策来源:/plan-ceo-review C3 + 外部声音 P1-D —— **不复用 concatVideos**:它硬编码 .mp4 +
// libx264/aac(ai-label.ts),拼 MP3 会损坏。音频拼接用音频专用 ffmpeg args(.mp3 / -c copy /
// 回退 libmp3lame)。
//
// 单段早返(外部声音 P3-A):大多 TTS 单段,直接返回不调 ffmpeg → 私有化无 ffmpeg 也能用。

import { writeFile, readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegAvailable, runFfmpeg } from './ai-label.js';

/**
 * 拼接多段 MP3 为一条。单段直接返回(不调 ffmpeg)。
 * 多段用 ffmpeg concat demuxer(-c copy 无损,失败回退 libmp3lame 重编码)。
 * ffmpeg 不可用时:多段抛明确错(调用方标 failed),单段不受影响(已早返)。
 */
export async function concatAudio(segmentBuffers: Buffer[]): Promise<Buffer> {
  if (segmentBuffers.length === 0) throw new Error('concatAudio: 无片段');
  if (segmentBuffers.length === 1) return segmentBuffers[0]!; // 单段早返:无 ffmpeg 依赖
  if (!(await ffmpegAvailable())) throw new Error('ffmpeg 不可用,无法拼接多段音频');

  const dir = await mkdtemp(join(tmpdir(), 'lj-audio-concat-'));
  const parts: string[] = [];
  const listPath = join(dir, 'list.txt');
  try {
    for (let i = 0; i < segmentBuffers.length; i++) {
      const p = join(dir, `seg-${i}.mp3`);
      await writeFile(p, segmentBuffers[i]!);
      parts.push(p);
    }
    await writeFile(listPath, parts.map((p) => `file '${p}'`).join('\n'));
    const outPath = join(dir, 'out.mp3');
    // 先试无损 -c copy(同源同编码);失败回退音频重编码(libmp3lame,不是视频 libx264)。
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    } catch {
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-q:a', '2', outPath,
      ]);
    }
    return await readFile(outPath);
  } finally {
    await Promise.all(parts.map((p) => unlink(p).catch(() => {})));
    await unlink(listPath).catch(() => {});
  }
}
