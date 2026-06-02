// 灵镜 队列 — 用 job 表直接做队列(不用 Redis)。
//
// 决策来源:/plan-eng-review D11 + 外部声音 #8 —— 低频长任务,DB 队列足够,
// 私有化少一个有状态中间件 = 少一份故障面。SQLite 单写,用事务 + status 条件
// 更新做"领取",等价于 Postgres 的 SELECT FOR UPDATE SKIP LOCKED。

import { randomUUID } from 'node:crypto';
import { db, type JobRow, type JobStatus } from '../db/index.js';
import { config } from '../config.js';
import type { VideoGenInput } from '../gateway/types.js';

const now = () => Date.now();

/** 入队一个视频生成任务,返回 jobId。 */
export function enqueueVideo(input: VideoGenInput, tenantId: string = config.defaultTenantId): string {
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO job (id, tenant_id, type, status, input_json, created_at, updated_at)
     VALUES (?, ?, 'video', 'queued', ?, ?, ?)`,
  ).run(id, tenantId, JSON.stringify(input), t, t);
  return id;
}

/**
 * 原子领取下一个 queued 任务并置为 running。
 * 用事务保证:即使多 worker 并发,同一 job 只被一个 worker 领走(条件 UPDATE 命中行数=1)。
 * 返回领取到的 JobRow,无可领取任务时返回 null。
 */
export const claimNextJob = db.transaction((): JobRow | null => {
  // 用 rowid 作 created_at 的次级排序键:Date.now() 毫秒精度下同毫秒入队的多条
  // 会并列,单凭 created_at 排序非确定。rowid 随插入单调递增,保证严格 FIFO。
  const candidate = db
    .prepare(`SELECT * FROM job WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`)
    .get() as JobRow | undefined;
  if (!candidate) return null;

  const t = now();
  const res = db
    .prepare(
      `UPDATE job SET status='running', started_at=?, updated_at=?, attempts=attempts+1
       WHERE id=? AND status='queued'`,
    )
    .run(t, t, candidate.id);

  // 条件未命中(被别的 worker 抢先)→ 视为无可领取,下一轮再试。
  if (res.changes !== 1) return null;
  return { ...candidate, status: 'running', started_at: t, attempts: candidate.attempts + 1 };
});

// worker 内部用:不带 tenant(worker 处理所有租户的任务)
export function getJob(id: string): JobRow | undefined {
  return db.prepare(`SELECT * FROM job WHERE id=?`).get(id) as JobRow | undefined;
}

// API 层用:强制带 tenant_id,防跨租户读取他人任务(行级隔离防漏)。
export function getJobForTenant(id: string, tenantId: string): JobRow | undefined {
  return db.prepare(`SELECT * FROM job WHERE id=? AND tenant_id=?`).get(id, tenantId) as
    | JobRow
    | undefined;
}

// 列某租户的任务(作品库 / 列表用)
export function listJobsForTenant(tenantId: string, limit = 50): JobRow[] {
  return db
    .prepare(`SELECT * FROM job WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(tenantId, limit) as JobRow[];
}

export function setProviderTaskId(id: string, providerTaskId: string): void {
  db.prepare(`UPDATE job SET baichuan_task_id=?, updated_at=? WHERE id=?`).run(
    providerTaskId,
    now(),
    id,
  );
}

export function updateProgress(id: string, progress: number): void {
  db.prepare(`UPDATE job SET progress=?, updated_at=? WHERE id=?`).run(progress, now(), id);
}

export function markDone(id: string, outputUrl: string, aiLabel: string): void {
  db.prepare(
    `UPDATE job SET status='done', progress=100, output_url=?, ai_label=?, updated_at=? WHERE id=?`,
  ).run(outputUrl, aiLabel, now(), id);
}

/** 标记失败。关键:只动这一个 job,不触碰其它 → 失败隔离的基础。 */
export function markFailed(id: string, error: string): void {
  db.prepare(`UPDATE job SET status='failed', error=?, updated_at=? WHERE id=?`).run(
    error,
    now(),
    id,
  );
}

/**
 * 用户重试:failed → queued 重新入队。
 * 传 tenantId 时强制租户隔离(API 层必传);省略时不限租户(测试/内部用)。
 */
export function retryJob(id: string, tenantId?: string): boolean {
  const res = tenantId
    ? db
        .prepare(
          `UPDATE job SET status='queued', error=NULL, progress=0, updated_at=? WHERE id=? AND tenant_id=? AND status='failed'`,
        )
        .run(now(), id, tenantId)
    : db
        .prepare(
          `UPDATE job SET status='queued', error=NULL, progress=0, updated_at=? WHERE id=? AND status='failed'`,
        )
        .run(now(), id);
  return res.changes === 1;
}

export type { JobRow, JobStatus };
