// 灵镜 worker 启动恢复测试(Docker 部署就绪 D11 + 2026-06-16 并发改造重写)。
//
// 容器重启时卡在 running 的 job 会变僵尸:claimNextJob 只领 queued,永不重领它。
// startWorker() 进并发池前先 recoverStuckJobs()。
//
// ⚠ 行为变更回归(IRON RULE,eng-review Finding 2 + 外部声音 #3/#4):
//   旧实现盲标 failed + release —— 厂商在重启窗口已生成完的会被误杀 + 错退款,
//   并发池一次炸最多 poolSize 个。新实现「重新入队」:status 回 queued、保留预扣、
//   保留 baichuan_task_id 让 runner 续跑现有厂商任务(submitOrResume 跳过重提交)。

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { reserve, balance, grant } = await import('../src/credits/index.js');
const { recoverStuckJobs } = await import('../src/queue/worker.js');

const T = 'recover-tenant';

// 插一个 running job(模拟上次进程崩溃时卡住的任务)。taskId 非空 = 异步 job 已提交到厂商。
function insertRunningJob(tenantId: string, taskId: string | null = null): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO job (id,tenant_id,type,status,progress,input_json,baichuan_task_id,attempts,created_at,updated_at,started_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, tenantId, 'video', 'running', 50, '{}', taskId, 1, now, now, now);
  return id;
}

beforeEach(() => {
  db.prepare('DELETE FROM job').run();
  db.prepare('DELETE FROM credit_ledger').run();
});

describe('worker 启动恢复:重新入队(不再盲标 failed)', () => {
  it('卡住的 running → 重入队 queued + 预扣保留(不退款,留待续跑)', async () => {
    grant(T, 1000);
    const jobId = insertRunningJob(T, 'task-abc'); // 有 task_id:已提交厂商
    reserve(T, jobId, 200); // 提交时预扣(余额 1000 → 800)
    expect(balance(T)).toBe(800);

    recoverStuckJobs();

    const job = db.prepare('SELECT status, baichuan_task_id, started_at FROM job WHERE id=?').get(jobId) as {
      status: string;
      baichuan_task_id: string | null;
      started_at: number | null;
    };
    expect(job.status).toBe('queued'); // 重入队,不再卡 running、不标 failed
    expect(job.baichuan_task_id).toBe('task-abc'); // task_id 保留 → runner 续跑现有厂商任务
    expect(job.started_at).toBeNull(); // started_at 清空(重新计 deadline)
    expect(balance(T)).toBe(800); // 预扣保留(不退款 —— 厂商可能已生成完,重跑续上)
  });

  it('多个 running 全部重入队(并发池崩溃:一次多个在飞)', async () => {
    grant(T, 1000);
    const ids = [insertRunningJob(T, 't1'), insertRunningJob(T, null), insertRunningJob(T, 't3')];
    ids.forEach((id) => reserve(T, id, 100));
    expect(balance(T)).toBe(700);

    recoverStuckJobs();

    const stuck = db.prepare(`SELECT COUNT(*) AS n FROM job WHERE status='running'`).get() as { n: number };
    const requeued = db.prepare(`SELECT COUNT(*) AS n FROM job WHERE status='queued'`).get() as { n: number };
    expect(stuck.n).toBe(0); // 无残留 running
    expect(requeued.n).toBe(3); // 全部重入队
    expect(balance(T)).toBe(700); // 预扣全保留(不退款)
  });

  it('无 task_id 的 running(同步图片 job / 提交前崩)→ 也重入队从头跑', async () => {
    grant(T, 1000);
    const jobId = insertRunningJob(T, null); // 无 task_id
    reserve(T, jobId, 50);

    recoverStuckJobs();

    const job = db.prepare('SELECT status, baichuan_task_id FROM job WHERE id=?').get(jobId) as {
      status: string;
      baichuan_task_id: string | null;
    };
    expect(job.status).toBe('queued');
    expect(job.baichuan_task_id).toBeNull(); // 无 task_id → runner submitOrResume 会重新提交(从头跑)
    expect(balance(T)).toBe(950); // 预扣保留(reserve 未 settle,重跑安全)
  });

  it('不动 running 以外的状态(done/failed/queued 不受影响)', async () => {
    grant(T, 1000);
    const now = Date.now();
    const mk = (status: string) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO job (id,tenant_id,type,status,progress,input_json,attempts,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(id, T, 'video', status, status === 'done' ? 100 : 0, '{}', 1, now, now);
      return id;
    };
    const doneId = mk('done');
    const failedId = mk('failed');

    recoverStuckJobs();

    expect((db.prepare('SELECT status FROM job WHERE id=?').get(doneId) as { status: string }).status).toBe('done');
    expect((db.prepare('SELECT status FROM job WHERE id=?').get(failedId) as { status: string }).status).toBe('failed');
  });
});
