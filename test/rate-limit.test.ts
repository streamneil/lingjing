// 灵镜 Open API — 通用滑动窗口限速器(PR1 T4,设计文档 §4.3 + D5)。
//
// 单进程内存态(Map + 惰性 prune);读写分级由调用方各建一个实例。
// 覆盖:窗口内放行到 max、第 max+1 拒、窗口滑动后恢复、多 key 独立计数、sweep 回收空 key。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { SlidingWindowLimiter } = await import('../src/auth/rate-limit.js');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-23T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SlidingWindowLimiter', () => {
  it('窗口内放行到 max,第 max+1 拒', () => {
    const rl = new SlidingWindowLimiter(60_000, 3);
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(false); // 第 4 次超限
  });

  it('窗口滑动后恢复', () => {
    const rl = new SlidingWindowLimiter(60_000, 2);
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(false);
    vi.advanceTimersByTime(60_001); // 窗口整体滑过
    expect(rl.allow('k')).toBe(true); // 旧记录过期,恢复
  });

  it('部分滑动:仅过期的名额释放', () => {
    const rl = new SlidingWindowLimiter(60_000, 2);
    expect(rl.allow('k')).toBe(true); // t=0
    vi.advanceTimersByTime(30_000);
    expect(rl.allow('k')).toBe(true); // t=30s(窗口内已 2 个)
    expect(rl.allow('k')).toBe(false); // t=30s 满
    vi.advanceTimersByTime(30_001); // t=60.001s:第一个(t=0)过期,第二个(t=30s)还在
    expect(rl.allow('k')).toBe(true); // 释放一个名额
    expect(rl.allow('k')).toBe(false); // 又满(t=30s 那个 + 刚才这个)
  });

  it('多 key 独立计数', () => {
    const rl = new SlidingWindowLimiter(60_000, 1);
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('b')).toBe(true); // b 不受 a 影响
  });

  it('sweep 回收全过期的 key(内存不无限涨)', () => {
    const rl = new SlidingWindowLimiter(60_000, 5);
    rl.allow('a');
    rl.allow('b');
    expect(rl.size()).toBe(2);
    vi.advanceTimersByTime(60_001);
    rl.sweep();
    expect(rl.size()).toBe(0); // 空桶被清
  });
});
