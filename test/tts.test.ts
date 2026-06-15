// 灵镜 文转语音(TTS)测试 —— 计价 / concatAudio(命脉:单段早返 + ffmpeg 缺失降级)/ 队列。
//
// 覆盖 /plan-eng-review 测试覆盖图:costFor 'tts'、concatAudio 单段早返不调 ffmpeg、
// 多段 ffmpeg 缺失优雅报错(不崩)、enqueueJob type='tts' + markDone output_kind=audio。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { costFor, estimateTtsCost, estimateCost } = await import('../src/credits/index.js');
const { enqueueJob, markDone, getJob } = await import('../src/queue/index.js');

describe('TTS 计价(costFor / estimateTtsCost)', () => {
  it('estimateTtsCost 按字数', () => {
    expect(estimateTtsCost(0)).toBe(1); // MIN_COST
    expect(estimateTtsCost(100)).toBe(1); // ceil(100*0.0028=0.28)=1(0.8元/万×3.5)
    expect(estimateTtsCost(1000)).toBe(3); // ceil(1000*0.0028=2.8)=3
  });
  it("costFor('tts') = estimateTtsCost(text.length)", () => {
    expect(costFor('tts', { text: 'a'.repeat(500) })).toBe(estimateTtsCost(500));
    expect(costFor('tts', {})).toBe(estimateTtsCost(0)); // 无 text→0→MIN_COST
  });
  it("costFor('video') 不变(回归)", () => {
    expect(costFor('video', { script: 'a'.repeat(100), resolution: '720P' })).toBe(estimateCost(100, '720P'));
  });
  it('未知 type 仍抛错(tts 不误命中 default)', () => {
    expect(() => costFor('nope', {})).toThrow();
  });
});

describe('concatAudio:单段早返 + ffmpeg 缺失降级(E2 命脉)', () => {
  it('单段 → 原样返回,不调 ffmpeg(私有化无 ffmpeg 也能用)', async () => {
    // 不 mock ffmpeg:单段路径在 ffmpegAvailable() 之前早返,证明不依赖 ffmpeg。
    const { concatAudio } = await import('../src/pipeline/concat-audio.js');
    const buf = Buffer.from('fake-mp3-bytes');
    expect(await concatAudio([buf])).toBe(buf);
  });

  it('空片段 → 抛错', async () => {
    const { concatAudio } = await import('../src/pipeline/concat-audio.js');
    await expect(concatAudio([])).rejects.toThrow();
  });
  // 多段 + ffmpeg 缺失的命脉测在 test/concat-audio-noffmpeg.test.ts(独立文件,mock ai-label 不污染本文件)。
});

describe('队列:enqueueJob type=tts + markDone output_kind=audio', () => {
  const T = 'tenant-tts-test';
  beforeEach(() => { db.prepare('DELETE FROM job').run(); });

  it('enqueueJob 写 type=tts;markDone 写 output_kind=audio + JSON key', () => {
    const id = enqueueJob('tts', { text: '你好', voiceRef: 'longjing' }, T);
    expect(getJob(id)!.type).toBe('tts');
    markDone(id, JSON.stringify(['audio/t/x.mp3']), 'none', 'audio');
    const row = getJob(id)!;
    expect(row.status).toBe('done');
    expect(row.output_kind).toBe('audio');
    expect(JSON.parse(row.output_url!)).toEqual(['audio/t/x.mp3']);
  });
});
