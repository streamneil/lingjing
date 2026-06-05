// 灵镜 worker 启动恢复测试(Docker 部署就绪 D11)。
//
// 容器重启时卡在 running 的 job 会变僵尸:claimNextJob 只领 queued,永不重领它,
// 用户预扣的积分也不退。startWorker() 进队列循环前先 recoverStuckJobs():
// 把残留 running 标 failed + release 预扣积分。这里验证该恢复逻辑。

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { reserve, balance, grant } = await import('../src/credits/index.js');
// 直接测恢复逻辑(不走 startWorker 的 running-flag 门,避免跨测试的异步生命周期竞态)。
const { recoverStuckJobs } = await import('../src/queue/worker.js');

const T = 'recover-tenant';

// 直接插一个 running job(模拟上次进程崩溃时卡住的任务)。
function insertRunningJob(tenantId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO job (id,tenant_id,type,status,progress,input_json,attempts,created_at,updated_at,started_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, tenantId, 'video', 'running', 50, '{}', 1, now, now, now);
  return id;
}

beforeEach(() => {
  db.prepare('DELETE FROM job').run();
  db.prepare('DELETE FROM credit_ledger').run();
});

describe('worker 启动恢复僵尸 job(D11)', () => {
  it('卡住的 running → startWorker 后标 failed + 预扣积分已释放', async () => {
    grant(T, 1000); // 先给积分
    const jobId = insertRunningJob(T);
    reserve(T, jobId, 200); // 模拟提交时的预扣(余额 1000 → 800)
    expect(balance(T)).toBe(800);

    recoverStuckJobs();

    const job = db.prepare('SELECT status FROM job WHERE id=?').get(jobId) as { status: string };
    expect(job.status).toBe('failed'); // 不再卡 running
    expect(balance(T)).toBe(1000); // 预扣已释放,余额回升
  });

  it('多个 running 全部恢复', async () => {
    grant(T, 1000);
    const ids = [insertRunningJob(T), insertRunningJob(T), insertRunningJob(T)];
    ids.forEach((id) => reserve(T, id, 100));
    expect(balance(T)).toBe(700); // 3 × 100 预扣

    recoverStuckJobs();

    const stuck = db.prepare(`SELECT COUNT(*) AS n FROM job WHERE status='running'`).get() as { n: number };
    expect(stuck.n).toBe(0); // 无残留 running
    expect(balance(T)).toBe(1000); // 全部预扣释放
  });

  it('无 running 时不动其它状态的 job', async () => {
    grant(T, 1000);
    const id = randomUUID();
    const now = Date.now();
    // 一个 done job(不该被恢复碰)
    db.prepare(
      `INSERT INTO job (id,tenant_id,type,status,progress,input_json,attempts,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, T, 'video', 'done', 100, '{}', 1, now, now);

    recoverStuckJobs();

    const job = db.prepare('SELECT status FROM job WHERE id=?').get(id) as { status: string };
    expect(job.status).toBe('done'); // done 不受影响
  });
});
