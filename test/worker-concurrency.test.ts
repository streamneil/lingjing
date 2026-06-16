// 灵镜 worker 并发改造测试(2026-06-16)。
//
// 覆盖:claimNextJob 单语句原子 + per-tenant cap、updateProgress 写节流、并发池槽管理。
// 确定性测法(eng-review Finding 3):better-sqlite3 同步 + Node 单线程,连续调 claimNextJob
//   即可验原子 cap(无需真并发,无 flake);原子性由单语句 SQL 保证,非靠时序。

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DB_FILE = ':memory:';
process.env.WORKER_POOL_SIZE = '4'; // tenantMaxConcurrent = ceil(4/2) = 2

const { db } = await import('../src/db/index.js');
const { claimNextJob, updateProgress, enqueueJob } = await import('../src/queue/index.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  db.prepare('DELETE FROM job').run();
});

function enqueue(tenant: string): string {
  return enqueueJob('video', {}, tenant);
}
function runningCount(tenant: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM job WHERE tenant_id=? AND status='running'`).get(tenant) as { n: number }).n;
}

describe('claimNextJob 原子 + per-tenant 公平闸门', () => {
  it('cap=ceil(poolSize/2)=2:同租户连续 claim 第三次被挡(不超 cap)', () => {
    expect(config.worker.tenantMaxConcurrent).toBe(2);
    enqueue('t1'); enqueue('t1'); enqueue('t1');
    const a = claimNextJob();
    const b = claimNextJob();
    const c = claimNextJob(); // t1 已 2 running = cap → 第三个挡住
    expect(a?.tenant_id).toBe('t1');
    expect(b?.tenant_id).toBe('t1');
    expect(c).toBeNull(); // cap 命中,无可领
    expect(runningCount('t1')).toBe(2); // 严格不超 cap(原子性核心断言)
  });

  it('一租户满 cap 时,连续 claim 转去领别租户(不饿死小客户)', () => {
    enqueue('big'); enqueue('big'); enqueue('big'); // 大客户一口气提 3 个
    enqueue('small'); // 小客户 1 个
    const c1 = claimNextJob(); // big #1
    const c2 = claimNextJob(); // big #2(到 cap)
    const c3 = claimNextJob(); // big 满 cap → 跳过 big,领 small
    expect(c1?.tenant_id).toBe('big');
    expect(c2?.tenant_id).toBe('big');
    expect(c3?.tenant_id).toBe('small'); // 公平:小客户没被饿死
    expect(runningCount('big')).toBe(2);
    expect(runningCount('small')).toBe(1);
  });

  it('FIFO:同租户按 created_at 顺序领取', () => {
    const first = enqueue('t1');
    const second = enqueue('t1');
    const a = claimNextJob();
    const b = claimNextJob();
    expect(a?.id).toBe(first);
    expect(b?.id).toBe(second);
  });

  it('队列空 → null', () => {
    expect(claimNextJob()).toBeNull();
  });

  it('claim 返回完整 JobRow(含 status=running、attempts+1)', () => {
    enqueue('t1');
    const j = claimNextJob();
    expect(j?.status).toBe('running');
    expect(j?.attempts).toBe(1);
    expect(j?.started_at).toBeGreaterThan(0);
  });
});

describe('updateProgress 写节流(跨 5% 桶才写,100 必写)', () => {
  it('同桶内不写,跨桶写,终态 100 必写', () => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO job (id,tenant_id,type,status,progress,input_json,attempts,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, 't1', 'video', 'running', 0, '{}', 0, now, now);
    const read = () => (db.prepare('SELECT progress FROM job WHERE id=?').get(id) as { progress: number }).progress;

    updateProgress(id, 3); // 桶0 → 写
    expect(read()).toBe(3);
    updateProgress(id, 4); // 桶0 同桶 → 跳过(库仍 3)
    expect(read()).toBe(3);
    updateProgress(id, 7); // 桶1 → 写
    expect(read()).toBe(7);
    updateProgress(id, 99); // 桶19 → 写
    expect(read()).toBe(99);
    updateProgress(id, 100); // 终态 → 必写
    expect(read()).toBe(100);
  });
});
