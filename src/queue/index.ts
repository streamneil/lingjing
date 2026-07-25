// 灵镜 队列 — 用 job 表直接做队列(不用 Redis)。
//
// 决策来源:/plan-eng-review D11 + 外部声音 #8 —— 低频长任务,DB 队列足够,
// 私有化少一个有状态中间件 = 少一份故障面。SQLite 单写,用事务 + status 条件
// 更新做"领取",等价于 Postgres 的 SELECT FOR UPDATE SKIP LOCKED。

import { randomUUID } from 'node:crypto';
import { db, scopeByOwner, type JobChannel, type JobRow, type JobStatus } from '../db/index.js';
import { config } from '../config.js';
import type { VideoGenInput } from '../gateway/types.js';
import { translateProviderError } from '../gateway/provider-errors.js';

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
export interface EnqueueIdempotency {
  key: string; // 客户端 Idempotency-Key
  hash: string; // 请求 body 的 canonical sha256
  reservedCost: number; // 本次预扣积分(幂等命中原样返回)
}

export function enqueueJob(
  type: string,
  input: unknown,
  tenantId: string = config.defaultTenantId,
  createdBy: string | null = null, // 创建者用户 id(计费归属;缺省 null = 老路径/系统)
  idem?: EnqueueIdempotency, // Open API 幂等键(可选);带则写入唯一列,并发同键第二插入会撞 idx_job_idem 抛错
  channel: JobChannel | null = null, // 提交来源(web|rest|mcp);缺省 null = 老路径/系统,前端按网页处理
): string {
  const id = randomUUID();
  const t = now();
  // output_kind 创建即按 type 定(修:失败任务此前停在列默认 'video' → 图片/音频失败被当视频 → 前端卡 Loading)。
  db.prepare(
    `INSERT INTO job (id, tenant_id, type, status, input_json, output_kind, created_by, created_at, updated_at,
                      idempotency_key, idempotency_hash, reserved_cost, channel)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, tenantId, type, JSON.stringify(input), outputKindForType(type), createdBy, t, t,
    idem?.key ?? null, idem?.hash ?? null, idem?.reservedCost ?? null, channel,
  );
  return id;
}

/** 删除一个 job 行(仅用于 submitJob 在 reserve 失败时回滚刚建的行,避免烧掉幂等键 / 留孤儿队列项)。 */
export function deleteJobRow(id: string): void {
  db.prepare(`DELETE FROM job WHERE id=?`).run(id);
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
// 隐私域:**只能删自己的,admin 也不例外**(2026-07)。非本人 → changes=0 → API 层 404。
export function deleteJobForTenant(id: string, tenantId: string, actingUserId: string): boolean {
  const scope = scopeByOwner(actingUserId);
  const res = db
    .prepare(`DELETE FROM job WHERE id=? AND tenant_id=?${scope.clause} AND status!='running'`)
    .run(id, tenantId, ...scope.params);
  return res.changes === 1;
}

// API 层用:租户 + 账号隔离。隐私域 —— 只取自己的,admin 也不例外。非本人 → undefined → 路由 404。
export function getJobForTenant(id: string, tenantId: string, actingUserId: string): JobRow | undefined {
  const scope = scopeByOwner(actingUserId);
  return db.prepare(`SELECT * FROM job WHERE id=? AND tenant_id=?${scope.clause}`).get(id, tenantId, ...scope.params) as
    | JobRow
    | undefined;
}

// 任务列表过滤(服务端分页):按类型 / 来源页 / 状态筛,避免「全局取 50 → 前端过滤」导致
// 某模块被其他工具刷屏后记录为空、且看不到更旧记录。source/mode 存 input_json,用 json_extract 过滤。
export interface JobListFilter {
  types?: string[]; // type IN (...)(真实列)
  source?: string; // input_json '$.source' 精确;含无 source 的老数据按 mode 回退(不漏历史)
  sourceModeImg2img?: boolean; // 老数据回退:无 source 行按 mode 归属(编辑=true / 生成=false)
  status?: JobStatus; // 状态列
  limit?: number;
  offset?: number;
}

// 组装 filter 的 WHERE 片段 + 参数(list 与 count 共用,保证口径一致)。
function jobFilterWhere(filter: JobListFilter): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.types?.length) {
    parts.push(`type IN (${filter.types.map(() => '?').join(',')})`);
    params.push(...filter.types);
  }
  if (filter.source) {
    // 无 source 的历史行按 mode 回退归属:编辑页取 mode='img2img',生成页取其余(含 NULL mode)。
    const modeCond = filter.sourceModeImg2img ? `json_extract(input_json,'$.mode') IS 'img2img'` : `json_extract(input_json,'$.mode') IS NOT 'img2img'`;
    parts.push(`(json_extract(input_json,'$.source')=? OR (json_extract(input_json,'$.source') IS NULL AND ${modeCond}))`);
    params.push(filter.source);
  }
  if (filter.status) {
    parts.push(`status=?`);
    params.push(filter.status);
  }
  return { clause: parts.length ? ' AND ' + parts.join(' AND ') : '', params };
}

// 列某租户的任务(作品库 / 各模块生成记录)。隐私域:一律只列自己的,admin 也不例外。
// NULL 老数据已由启动迁移认领给租户首个 admin,故此处不开 orgPublic 口子。
export function listJobsForTenant(
  tenantId: string,
  actingUserId: string,
  filter: JobListFilter = {},
): JobRow[] {
  const scope = scopeByOwner(actingUserId);
  const f = jobFilterWhere(filter);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
  const offset = Math.max(0, filter.offset ?? 0);
  return db
    .prepare(
      `SELECT * FROM job WHERE tenant_id=?${scope.clause}${f.clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(tenantId, ...scope.params, ...f.params, limit, offset) as JobRow[];
}

// 某租户任务总数(与 listJobsForTenant 同 filter/隔离口径,供分页 total)。
export function countJobsForTenant(
  tenantId: string,
  actingUserId: string,
  filter: JobListFilter = {},
): number {
  const scope = scopeByOwner(actingUserId);
  const f = jobFilterWhere(filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM job WHERE tenant_id=?${scope.clause}${f.clause}`)
    .get(tenantId, ...scope.params, ...f.params) as { n: number };
  return row.n;
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

/** 标记失败。关键:只动这一个 job,不触碰其它 → 失败隔离的基础。
 *  单一翻译点:所有失败(厂商原始错误 / 本平台中文错误)都经此落库,
 *    error       列 = 用户可读中文(前端 + admin 概要展示,绝不含英文 JSON);
 *    error_detail 列 = 原始技术日志(admin 消耗流水「详情」排障,含 code / RequestId)。
 *  translateProviderError 幂等:已是干净中文的原样透出,detail 恒为原始输入。 */
export function markFailed(id: string, error: string): void {
  const { readable, detail } = translateProviderError(error);
  db.prepare(`UPDATE job SET status='failed', error=?, error_detail=?, updated_at=? WHERE id=?`).run(
    readable,
    detail,
    now(),
    id,
  );
}

/**
 * 用户重试:failed → queued 重新入队。
 * 传 tenantId 时强制租户隔离(API 层必传);省略时不限租户(测试/内部用)。
 */
// 用户重试:failed → queued。传 tenantId 时强制租户隔离 + 账号隔离(API 必传 actingUserId);
// 省略 tenantId 时不限(测试/内部)。隐私域:只能重试自己的,admin 也不例外。
export function retryJob(id: string, tenantId?: string, actingUserId?: string): boolean {
  if (tenantId) {
    const scope = actingUserId !== undefined ? scopeByOwner(actingUserId) : { clause: '', params: [] as string[] };
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
