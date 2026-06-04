// 灵镜 合规 — AI 生成标识(ffmpeg 后处理)。
//
// 决策来源:实测确认 wan2.2-s2v 成品不自带 AI 标识(/plan-eng-review §I1)。
// 融媒体/政企硬门票:给视频右下角打"AI 合成"半透明文字 + 写元数据。
// 受 tenant_setting 的 ai_label_enabled 开关控制(关了就跳过)。

import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** ffmpeg 是否可用(容器/CI 里可能没装;没装则跳过标识并告警)。 */
let ffmpegChecked: boolean | null = null;
function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegChecked !== null) return Promise.resolve(ffmpegChecked);
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => { ffmpegChecked = false; resolve(false); });
    p.on('close', (code) => { ffmpegChecked = code === 0; resolve(ffmpegChecked); });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * 用 ffprobe 读音频时长(秒)。ffprobe 不可用时返回 null(调用方据此跳过校验)。
 * wan2.2-s2v 要求驱动音频 <20s,故 TTS 后需校验。
 */
export async function probeAudioDuration(audioBuf: Buffer): Promise<number | null> {
  if (!(await ffmpegAvailable())) return null; // ffmpeg 套件缺失则跳过
  const dir = await mkdtemp(join(tmpdir(), 'lj-probe-'));
  const inPath = join(dir, 'a.mp3');
  try {
    await writeFile(inPath, audioBuf);
    return await new Promise<number | null>((resolve) => {
      const p = spawn('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', inPath,
      ]);
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const n = parseFloat(out.trim());
        resolve(Number.isFinite(n) ? n : null);
      });
    });
  } finally {
    await unlink(inPath).catch(() => {});
  }
}

/**
 * 用 ffprobe 读图片真实宽高,推出比例朝向。ffprobe 不可用或读失败返回 null
 * (调用方据此回退用户手选值)。
 *
 * 为什么需要:wan2.2-s2v 按输入图片真实比例出视频(官方:输出与输入图宽高比一致),
 * 而上传时 orientation 是用户手选的,可能与图不符。检真实比例覆盖手选,使比例标记不擒谎。
 *
 *   w > h  → landscape(横屏 16:9 类)
 *   w < h  → portrait (竖屏 9:16 类)
 *   |w-h| 在 5% 内 → square(方形)
 */
export async function detectOrientation(
  imageBuf: Buffer,
): Promise<'portrait' | 'landscape' | 'square' | null> {
  if (!(await ffmpegAvailable())) return null;
  const dir = await mkdtemp(join(tmpdir(), 'lj-orient-'));
  const inPath = join(dir, 'img');
  try {
    await writeFile(inPath, imageBuf);
    return await new Promise<'portrait' | 'landscape' | 'square' | null>((resolve) => {
      const p = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0', inPath,
      ]);
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const parts = out.trim().split('x').map(Number);
        const w = parts[0], h = parts[1];
        if (w === undefined || h === undefined || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return resolve(null);
        }
        const ratio = w / h;
        if (ratio > 1.05) resolve('landscape');
        else if (ratio < 0.95) resolve('portrait');
        else resolve('square');
      });
    });
  } finally {
    await unlink(inPath).catch(() => {});
  }
}

/**
 * C3:从视频抽取首帧为 JPG(作自定义形象图)。ffmpeg 不可用或抽帧失败返回 null。
 */
export async function extractFirstFrame(videoBuf: Buffer): Promise<Buffer | null> {
  if (!(await ffmpegAvailable())) return null;
  const dir = await mkdtemp(join(tmpdir(), 'lj-frame-'));
  const inPath = join(dir, 'in.mp4');
  const outPath = join(dir, 'frame.jpg');
  try {
    await writeFile(inPath, videoBuf);
    // -frames:v 1 取首帧;-q:v 2 高质量 JPG
    await runFfmpeg(['-y', '-i', inPath, '-frames:v', '1', '-q:v', '2', outPath]);
    return await readFile(outPath);
  } catch {
    return null; // 抽帧失败(坏视频等)→ null,API 层给 422
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

/**
 * 拼接多段视频为一条(长文案分段生成后用)。各段同源图片 → 同分辨率/编码,
 * 用 ffmpeg concat demuxer 无损拼接(-c copy)。ffmpeg 不可用时抛错(调用方决定降级)。
 * 单段时调用方应直接返回该段,无需拼接。
 */
export async function concatVideos(segmentBuffers: Buffer[]): Promise<Buffer> {
  if (segmentBuffers.length === 0) throw new Error('concatVideos: 无片段');
  if (segmentBuffers.length === 1) return segmentBuffers[0]!;
  if (!(await ffmpegAvailable())) throw new Error('ffmpeg 不可用,无法拼接多段视频');
  const dir = await mkdtemp(join(tmpdir(), 'lj-concat-'));
  const parts: string[] = [];
  const listPath = join(dir, 'list.txt');
  try {
    for (let i = 0; i < segmentBuffers.length; i++) {
      const p = join(dir, `seg-${i}.mp4`);
      await writeFile(p, segmentBuffers[i]!);
      parts.push(p);
    }
    // concat demuxer:list.txt 每行 file '<path>';-safe 0 允许绝对路径。
    await writeFile(listPath, parts.map((p) => `file '${p}'`).join('\n'));
    const outPath = join(dir, 'out.mp4');
    // 先试无损 -c copy(同源同编码,最快);各段时间基不一致致 copy 失败时,
    // 回退重编码(-c:v libx264 -c:a aac)保证拼接成功。
    try {
      await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
    } catch {
      await runFfmpeg([
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', outPath,
      ]);
    }
    return await readFile(outPath);
  } finally {
    await Promise.all(parts.map((p) => unlink(p).catch(() => {})));
    await unlink(listPath).catch(() => {});
  }
}

export interface LabelOptions {
  text?: string; // 标识文案,默认"AI 合成"
}

/**
 * 给视频加 AI 生成标识。返回处理后的视频 Buffer。
 * ffmpeg 不可用时:返回原视频 + 标记 applied=false(不阻断生成,但告警)。
 */
export async function applyAiLabel(
  videoBuf: Buffer,
  opts: LabelOptions = {},
): Promise<{ buffer: Buffer; applied: boolean }> {
  if (!(await ffmpegAvailable())) {
    return { buffer: videoBuf, applied: false };
  }
  const text = opts.text || 'AI 合成';
  const dir = await mkdtemp(join(tmpdir(), 'lj-label-'));
  const inPath = join(dir, 'in.mp4');
  const outPath = join(dir, 'out.mp4');
  try {
    await writeFile(inPath, videoBuf);
    // drawtext:右下角半透明白字 + 黑描边;metadata:写 comment 标记 AI 生成
    const filter =
      `drawtext=text='${text}':fontcolor=white@0.85:fontsize=h/22:` +
      `box=1:boxcolor=black@0.35:boxborderw=8:x=w-tw-24:y=h-th-24`;
    await runFfmpeg([
      '-y',
      '-i', inPath,
      '-vf', filter,
      '-metadata', `comment=AI-generated by Lingjing (${text})`,
      '-metadata', 'ai_generated=true',
      '-codec:a', 'copy',
      outPath,
    ]);
    const out = await readFile(outPath);
    return { buffer: out, applied: true };
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}
