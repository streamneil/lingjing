// 灵镜 数字人 s2v 音频格式判定测试。
//
// 根因(2026-06):qwen3-tts 经 multimodal-generation 默认回 WAV(RIFF...WAVE),
// 旧实现把它当 .mp3 + audio/mpeg 上传 → wan2.2-s2v 报
// "File type is not supported. Allowed types are: .wav, .mp3."。
// detectAudioFormat 按 magic number 判真实格式,扩展名/Content-Type 与字节一致后即可被 s2v 接受。

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';
const { detectAudioFormat } = await import('../src/queue/worker.js');

// 构造各格式头部样本
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVE'), Buffer.alloc(16)]);
const mp3Id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]);
const mp3Frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(16)]); // 帧同步 0xFFFB
const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);

describe('detectAudioFormat(magic number)', () => {
  it('RIFF...WAVE → wav(qwen3-tts 真实输出)', () => {
    expect(detectAudioFormat(wav)).toBe('wav');
  });
  it('ID3 标签 → mp3', () => {
    expect(detectAudioFormat(mp3Id3)).toBe('mp3');
  });
  it('MPEG 帧同步 0xFFEx/0xFFFx → mp3', () => {
    expect(detectAudioFormat(mp3Frame)).toBe('mp3');
  });
  it('识别不出 → 回退 mp3(不抛错)', () => {
    expect(detectAudioFormat(garbage)).toBe('mp3');
    expect(detectAudioFormat(Buffer.alloc(0))).toBe('mp3');
  });
});
