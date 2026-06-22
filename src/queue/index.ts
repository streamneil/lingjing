// 灵镜 队列 — 用 job 表直接做队列(不用 Redis)。
//
// 决策来源:/plan-eng-review D11 + 外部声音 #8 —— 低频长任务,DB 队列足够,
// 私有化少一个有状态中间件 = 少一份故障面。SQLite 单写,用事务 + status 条件
// 更新做"领取",等价于 Postgres 的 SELECT FOR UPDATE SKIP LOCKED。

import { randomUUID } from 'node:crypto';
import { db, scopeByActor, type JobRow, type JobStatus } from '../db/index.js';
import { config } from '../config.js';
import type { VideoGenInput } from '../gateway/types.js';

const now = () => Date.now();

/** job type → 产物类型(右画廊渲染依据)。在创建时就定,而非靠 markDone 兜底 —— 否则
 *  失败的 job 永远停在列默认值 'video',图片/音频任务失败会被前端当视频渲染 → 一直 Loading。 */
export function outputKindForType(type: string): 'image' | 'audio' | 'video' {
  if (type === 'ai_image') return 'image';
  if (type === 'tts' || type === 'ai_music') return 'audio';
  return 'video'; // video / video_edit / text2video / img2video / ref_video …
}

/** 入队一个生成任务(通用,按 type),返回 jobId。
 *  多工具平台:type 决定 worker 走哪个 runner;input 是该工具的入参(JSON 序列化存)。 */
export function enqueueJob(
  type: string,
  input: unknown,
  tenantId: string = config.defaultTenantId,
  createdBy: string | null = null, // 创建者用户 id(计费归属;缺省 null = 老路径/系统)
): string {
  const id = randomUUID();
  const t = now();
  // output_kind 创建即按 type 定(修:失败任务此前停在列默认 'video' → 图片/音频失败被当视频 → 前端卡 Loading)。
  db.prepare(
    `INSERT INTO job (id, tenant_id, type, status, input_json, output_kind, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
  ).run(id, tenantId, type, JSON.stringify(input), outputKindForType(type), createdBy, t, t);
  return id;
}

/** 入队一个视频(AI 虚拟人)生成任务,返回 jobId。enqueueJob 的 video 便捷包装(向后兼容)。 */
export function enqueueVideo(input: VideoGenInput, tenantId: string = config.defaultTenantId): string {
  return enqueueJob('video', input, tenantId);
}

/**
 * 原子领取下一个 queued 任务并置为 running。返回领取到的 JobRow,无可领取时返回 null。
 *
 * 单语句原子领取(2026-06-16 并发改造,eng-review CRITICAL #1):
 *   并发池 N 个槽会同 tick 调本函数。旧实现是事务内 SELECT-then-UPDATE,DEFERRED 事务下
 *   per-tenant cap 的 COUNT 读与 UPDATE 写不共享写锁 → 两槽都过 cap → cap 形同虚设。
 *   改为一条 UPDATE...WHERE id=(子查询带 cap)...RETURNING:整条在单个写锁内完成,
 *   cap 与领取真正原子。better-sqlite3 同步 + Node 单线程,连续调用天然不交错。
 *
 * per-tenant 公平闸门:跳过「该租户已 running 数 ≥ tenantMaxConcurrent」的 job,
 *   防大客户一口气提满整池饿死小客户(单租户上限 = ceil(poolSize/2),可 env 覆盖)。
 *
 * rowid 作 created_at 次级排序键:同毫秒入队的多条用 rowid(单调递增)保证严格 FIFO。
 */
const TENANT_MAX = config.worker.tenantMaxConcurrent;
export function claimNextJob(): JobRow | null {
  const t = now();
  const row = db
    .prepare(
      `UPDATE job SET status='running', started_at=@t, updated_at=@t, attempts=attempts+1
         WHERE id = (
           SELECT j.id FROM job AS j
            WHERE j.status='queued'
              AND (SELECT COUNT(*) FROM job AS r
                    WHERE r.tenant_id = j.tenant_id AND r.status='running') < @cap
            ORDER BY j.created_at, j.rowid
            LIMIT 1
         )
       RETURNING *`,
    )
    .get({ t, cap: TENANT_MAX }) as JobRow | undefined;
  return row ?? null;
}

// worker 内部用:不带 tenant(worker 处理所有租户的任务)
export function getJob(id: string): JobRow | undefined {
  return db.prepare(`SELECT * FROM job WHERE id=?`).get(id) as JobRow | undefined;
}

// 删除作品(租户 + 账号隔离)。生成中的任务不让删(防删掉正在跑的)。
// admin 可删本机构任意作品(善后/审核);creator 仅删自己的。非本人非 admin → changes=0 → API 层 404。
export function deleteJobForTenant(id: string, tenantId: string, actingUserId: string, isAdmin: boolean): boolean {
  const scope = scopeByActor(actingUserId, isAdmin);
  const res = db
    .prepare(`DELETE FROM job WHERE id=? AND tenant_id=?${scope.clause} AND status!='running'`)
    .run(id, tenantId, ...scope.params);
  return res.changes === 1;
}

// API 层用:租户 + 账号隔离。creator 仅取自己的;admin 取本机构任意。非本人非 admin → undefined → 路由 404。
export function getJobForTenant(id: string, tenantId: string, actingUserId: string, isAdmin: boolean): JobRow | undefined {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db.prepare(`SELECT * FROM job WHERE id=? AND tenant_id=?${scope.clause}`).get(id, tenantId, ...scope.params) as
    | JobRow
    | undefined;
}

// 列某租户的任务(作品库 / 列表用)。creator 仅自己的;admin 全机构(含 NULL 老数据)。
export function listJobsForTenant(tenantId: string, actingUserId: string, isAdmin: boolean, limit = 50): JobRow[] {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db
    .prepare(`SELECT * FROM job WHERE tenant_id=?${scope.clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(tenantId, ...scope.params, limit) as JobRow[];
}

export function setProviderTaskId(id: string, providerTaskId: string): void {
  db.prepare(`UPDATE job SET baichuan_task_id=?, updated_at=? WHERE id=?`).run(
    providerTaskId,
    now(),
    id,
  );
}

// 进度写节流(2026-06-16 并发改造,eng-review Finding):better-sqlite3 写同步阻塞事件循环;
//   并发池 N 个 job 每 3s 各写一次进度会拖垮共进程的 Express。只在跨「5% 桶」时写,且 100 必写。
//   per-job 记上次写入的桶号;终态写后清理,防 Map 泄漏。
const _lastProgressBucket = new Map<string, number>();
export function updateProgress(id: string, progress: number): void {
  const bucket = Math.floor(progress / 5);
  const last = _lastProgressBucket.get(id);
  if (progress < 100 && last === bucket) return; // 同桶且非终态 → 跳过(省一次同步写)
  _lastProgressBucket.set(id, bucket);
  if (progress >= 100) _lastProgressBucket.delete(id); // 终态:清理(markDone 也会置 100)
  db.prepare(`UPDATE job SET progress=?, updated_at=? WHERE id=?`).run(progress, now(), id);
}

/** 标记完成。outputUrl 现存 JSON key 数组(单视频=1元素);outputKind 决定右画廊渲染方式。
 *  默认 outputKind='video' 兼容现有视频 runner 调用点。 */
export function markDone(
  id: string,
  outputUrl: string,
  aiLabel: string,
  outputKind: 'video' | 'image' | 'audio' = 'video',
): void {
  db.prepare(
    `UPDATE job SET status='done', progress=100, output_url=?, output_kind=?, ai_label=?, updated_at=? WHERE id=?`,
  ).run(outputUrl, outputKind, aiLabel, now(), id);
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
// 用户重试:failed → queued。传 tenantId 时强制租户隔离 + 账号隔离(API 必传 actingUserId/isAdmin);
// 省略 tenantId 时不限(测试/内部)。admin 可重试本机构任意;creator 仅自己的。
export function retryJob(id: string, tenantId?: string, actingUserId?: string, isAdmin?: boolean): boolean {
  if (tenantId) {
    const scope = actingUserId !== undefined ? scopeByActor(actingUserId, !!isAdmin) : { clause: '', params: [] as string[] };
    const res = db
      .prepare(
        `UPDATE job SET status='queued', error=NULL, progress=0, updated_at=? WHERE id=? AND tenant_id=?${scope.clause} AND status='failed'`,
      )
      .run(now(), id, tenantId, ...scope.params);
    return res.changes === 1;
  }
  const res = db
    .prepare(
      `UPDATE job SET status='queued', error=NULL, progress=0, updated_at=? WHERE id=? AND status='failed'`,
    )
    .run(now(), id);
  return res.changes === 1;
}

export type { JobRow, JobStatus };
