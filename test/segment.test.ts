// 灵镜 长文案分段测试 —— wan2.2-s2v 20s 上限的分段切分(segment.ts)。

import { describe, it, expect } from 'vitest';
import { segmentScript } from '../src/pipeline/segment.js';

describe('segmentScript', () => {
  it('空/纯空白 → []', () => {
    expect(segmentScript('')).toEqual([]);
    expect(segmentScript('   \n ')).toEqual([]);
  });

  it('短文案(<上限)→ 单段,原样', () => {
    const s = '大家好,欢迎收看本期新闻。';
    expect(segmentScript(s)).toEqual([s]);
  });

  it('长文案按句切多段,每段 ≤ maxChars', () => {
    const sentence = '我市重点民生工程取得新进展。'; // 14 字
    const long = sentence.repeat(20); // 280 字,远超 90
    const segs = segmentScript(long);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(90);
    // 拼回去(去标点空白干扰)应覆盖全部句子内容
    expect(segs.join('').replace(/\s/g, '')).toBe(long.replace(/\s/g, ''));
  });

  it('在句子边界切,不拦腰截句', () => {
    const segs = segmentScript('第一句话内容。第二句话内容。第三句话内容。'.repeat(5));
    // 每段都应以句末标点结尾(除非是硬切的无标点长句)
    for (const s of segs) expect(/[。!?；;]$/.test(s)).toBe(true);
  });

  it('单句无标点超长 → 按字数硬切', () => {
    const noPunct = '字'.repeat(200); // 200 字无标点
    const segs = segmentScript(noPunct);
    expect(segs.length).toBe(3); // 90+90+20
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(90);
    expect(segs.join('')).toBe(noPunct);
  });

  it('自定义 maxChars 生效', () => {
    const segs = segmentScript('一句。'.repeat(10), 6); // 每段 ≤6 字
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(6);
  });

  it('混合中英文标点都识别', () => {
    const segs = segmentScript('Hello world! 你好世界。Question? 问题吗?'.repeat(4));
    expect(segs.length).toBeGreaterThan(1);
  });
});
