// 灵镜 Slice 3 积分语义测试 —— reserve/settle/release + 余额 + 失败不扣 + 租户隔离。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { grant, reserve, settle, release, balance, estimateCost } = await import(
  '../src/credits/index.js'
);

const T = 'tenant-credit-test';

beforeEach(() => {
  db.prepare('DELETE FROM credit_ledger').run();
});

describe('计价', () => {
  it('字数 × 单价,有下限', () => {
    expect(estimateCost(0)).toBe(1); // MIN_COST
    expect(estimateCost(100, '1080P')).toBe(5); // ceil(100*0.05*1)
    expect(estimateCost(100, '720P')).toBe(3); // ceil(100*0.05*0.6)=3
    expect(estimateCost(100, '4K')).toBe(10); // 100*0.05*2
  });

  it('预估 = reserve = settle(同一算法,验收第4条)', () => {
    const cost = estimateCost(200, '1080P');
    grant(T, 100);
    reserve(T, 'job-x', cost);
    settle(T, 'job-x', cost);
    // grant100 - reserve(cost) + settle(0) = 100 - cost
    expect(balance(T)).toBe(100 - cost);
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
