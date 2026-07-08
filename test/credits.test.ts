// 灵镜 Slice 3 积分语义测试 —— reserve/settle/release + 余额 + 失败不扣 + 租户隔离。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { grant, reserve, settle, release, balance, estimateCost, usageSummary } = await import(
  '../src/credits/index.js'
);

const T = 'tenant-credit-test';

beforeEach(() => {
  db.prepare('DELETE FROM credit_ledger').run();
});

describe('计价', () => {
  it('按秒数 × 每秒售价,有下限', () => {
    // 数字人(wan2.2-s2v):秒数=⌈字数/(5×语速)⌉;每秒售价=⌈真实元/秒 × 35⌉(480P 18 / 720P 32)。
    expect(estimateCost(0)).toBe(1); // 空脚本 → MIN_COST
    expect(estimateCost(100, '720P')).toBe(640); // ⌈100/5⌉=20s × 32 = 640
    expect(estimateCost(100, '480P')).toBe(360); // 20s × 18 = 360(480P 必须比 720P 便宜)
    expect(estimateCost(100, '480P')).toBeLessThan(estimateCost(100, '720P'));
    // 语速快 → 同字数更短 → 更便宜
    expect(estimateCost(100, '720P', 2)).toBe(320); // ⌈100/10⌉=10s × 32 = 320
  });

  it('预估 = reserve = settle(同一算法,验收第4条)', () => {
    const cost = estimateCost(100, '720P'); // 640
    grant(T, 1000);
    reserve(T, 'job-x', cost);
    settle(T, 'job-x', cost);
    // grant1000 - reserve(cost) + settle(0) = 1000 - cost
    expect(balance(T)).toBe(1000 - cost);
  });
});

describe('积分流转', () => {
  it('grant 增加余额', () => {
    grant(T, 500);
    expect(balance(T)).toBe(500);
  });

  it('reserve 立即减少余额', () => {
    grant(T, 100);
    reserve(T, 'j1', 30);
    expect(balance(T)).toBe(70);
  });

  it('成功 settle:实扣=预扣,差额0,余额维持已扣', () => {
    grant(T, 100);
    reserve(T, 'j1', 30);
    settle(T, 'j1', 30);
    expect(balance(T)).toBe(70); // 真扣了 30
  });

  it('失败 release:预扣全额还回,失败不扣(关键语义)', () => {
    grant(T, 100);
    reserve(T, 'j1', 30);
    expect(balance(T)).toBe(70);
    release(T, 'j1');
    expect(balance(T)).toBe(100); // 还回了,失败不扣
  });

  it('release 幂等:重复调用不重复退款(回归 — 失败重试曾导致积分凭空增加)', () => {
    grant(T, 100);
    reserve(T, 'j1', 30);
    release(T, 'j1');
    release(T, 'j1'); // 第二次(模拟失败处理被触发两次 / 重试后再失败)
    release(T, 'j1'); // 第三次
    expect(balance(T)).toBe(100); // 仍是 100,不能变成 130/160
  });

  it('settle 后再 release 不重复退款(成功任务不应被释放)', () => {
    grant(T, 100);
    reserve(T, 'j1', 30);
    settle(T, 'j1', 30); // 成功结算,净扣 30
    expect(balance(T)).toBe(70);
    release(T, 'j1'); // 误触发释放
    expect(balance(T)).toBe(70); // 仍扣着 30,不能退回变 100
  });

  it('余额不足时 reserve 抛错,不产生负余额', () => {
    grant(T, 10);
    expect(() => reserve(T, 'j1', 50)).toThrow('余额不足');
    expect(balance(T)).toBe(10); // 没动
  });

  it('并发两次 reserve,第二次因余额不足被拒(防超支)', () => {
    grant(T, 50);
    reserve(T, 'j1', 40);
    expect(() => reserve(T, 'j2', 40)).toThrow(); // 剩 10,不够 40
    expect(balance(T)).toBe(10);
  });
});

describe('租户余额隔离', () => {
  it('A 发放不影响 B 余额', () => {
    grant('tenant-A', 100);
    expect(balance('tenant-A')).toBe(100);
    expect(balance('tenant-B')).toBe(0);
  });
});

describe('usageSummary — 整租户用量统计', () => {
  it('净消耗口径:成功=实扣、token 退差、失败退还=0;累计生成=结算数', () => {
    grant(T, 1000);
    // 成功任务(固定价):reserve 100 → settle actualCost 100(diff 0)→ 实扣 100
    reserve(T, 'job1', 100); settle(T, 'job1', 100);
    // token 任务:reserve 137(上限)→ settle actualCost 54(退差 83)→ 实扣 54
    reserve(T, 'job2', 137); settle(T, 'job2', 54);
    // 失败任务:reserve 200 → release(退还 200)→ 实扣 0
    reserve(T, 'job3', 200); release(T, 'job3');

    const s = usageSummary(T);
    expect(s.balance).toBe(846); // 1000 - 100 - 54
    expect(s.granted).toBe(1000);
    expect(s.released).toBe(200); // 失败退还
    expect(s.consumed).toBe(154); // 100 + 54(失败不计);= granted - balance
    expect(s.genCount).toBe(2); // 两次结算(job3 失败无结算)
    expect(s.todaySpend).toBe(154); // 全在今天
    expect(s.todayGenCount).toBe(2);
    expect(s.monthSpend).toBe(154);
    expect(s.spend30).toBe(154);
    expect(s.trend30).toHaveLength(30);
    expect(s.trend30[29]).toBe(154); // 今天桶
  });

  it('无任何流水 → 全 0(不误报)', () => {
    const s = usageSummary('tenant-empty');
    expect(s.balance).toBe(0);
    expect(s.consumed).toBe(0);
    expect(s.genCount).toBe(0);
    expect(s.spend30).toBe(0);
  });

  it('租户隔离:A 的消耗不进 B 的统计', () => {
    grant('tA', 500); reserve('tA', 'j', 50); settle('tA', 'j', 50);
    const b = usageSummary('tB');
    expect(b.consumed).toBe(0);
    expect(b.balance).toBe(0);
  });
});
