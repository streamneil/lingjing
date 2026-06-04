// 灵镜 内容审核测试 —— 本地敏感词表过渡方案(项目收尾 T4)。

import { describe, it, expect } from 'vitest';
import { moderateScript, moderateOutput } from '../src/pipeline/moderation.js';
import { findSensitiveWord } from '../src/pipeline/sensitive-words.js';

describe('moderateScript 长度保护', () => {
  it('空文案 → 拒绝', async () => {
    expect((await moderateScript('   ')).allowed).toBe(false);
  });
  it('超 2000 字 → 拒绝', async () => {
    expect((await moderateScript('字'.repeat(2001))).allowed).toBe(false);
  });
  it('正常文案 → 通过', async () => {
    const v = await moderateScript('大家好,欢迎收看本期新闻播报。');
    expect(v.allowed).toBe(true);
  });
});

describe('moderateScript 敏感词', () => {
  it('含敏感词 → 拒绝,不回显具体词', async () => {
    const v = await moderateScript('今天讨论赌博相关话题');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('敏感');
    expect(v.reason).not.toContain('赌博'); // 不回显具体词,防摸边界
  });
  it('空格拆字绕过 → 仍命中', async () => {
    const v = await moderateScript('赌 博');
    expect(v.allowed).toBe(false);
  });
  it('正常内容不误伤', async () => {
    expect((await moderateScript('我市重点民生工程取得新进展')).allowed).toBe(true);
  });
});

describe('findSensitiveWord', () => {
  it('命中返回该词', () => {
    expect(findSensitiveWord('涉及毒品的内容')).toBe('毒品');
  });
  it('未命中返回 null', () => {
    expect(findSensitiveWord('这是一段正常的新闻稿')).toBeNull();
  });
});

describe('moderateOutput', () => {
  it('成品审核占位放行(真实画面/音频检测待接 API)', async () => {
    expect((await moderateOutput('https://x/y.mp4')).allowed).toBe(true);
  });
});
