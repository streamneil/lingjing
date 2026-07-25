// 灵镜 — 任务列表服务端过滤 + 分页(修「全局取 50 → 前端过滤」的截断 bug)。
// 覆盖:① 按类型过滤 ② ai_image 按 source 分流(生成/编辑)③ 无 source 老数据按 mode 回退
//   ④ limit/offset 分页 + count total + DESC 顺序 + 无重叠 ⑤ 租户/账号隔离仍生效。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { enqueueJob, listJobsForTenant, countJobsForTenant } = await import('../src/queue/index.js');

const T = 'tenant-pg';
const U = 'user-pg'; // 本文件的作品统一归属此人 —— 账号隔离下 created_by=NULL 的行对所有人不可见

beforeEach(() => {
  db.prepare('DELETE FROM job').run();
});

describe('listJobsForTenant — 服务端过滤 + 分页', () => {
  it('按类型过滤(单/多)', () => {
    enqueueJob('ai_image', { prompt: 'a', source: 'ai-image', mode: 'text2img' }, T, U);
    enqueueJob('video_t2v', { prompt: 'b' }, T, U);
    enqueueJob('tts', { text: 'c' }, T, U);
    expect(listJobsForTenant(T, U, { types: ['ai_image'] })).toHaveLength(1);
    expect(listJobsForTenant(T, U, { types: ['video_t2v', 'tts'] })).toHaveLength(2);
    expect(countJobsForTenant(T, U, { types: ['ai_image'] })).toBe(1);
  });

  it('ai_image 按 source 分流:生成页 vs 编辑页', () => {
    enqueueJob('ai_image', { source: 'ai-image', mode: 'text2img' }, T, U);
    enqueueJob('ai_image', { source: 'ai-image', mode: 'img2img' }, T, U); // 图片转图片 tab 也归 ai-image
    enqueueJob('ai_image', { source: 'ai-image-edit', mode: 'img2img' }, T, U);
    const gen = listJobsForTenant(T, U, { types: ['ai_image'], source: 'ai-image', sourceModeImg2img: false });
    const edit = listJobsForTenant(T, U, { types: ['ai_image'], source: 'ai-image-edit', sourceModeImg2img: true });
    expect(gen).toHaveLength(2); // ai-image 的两条(含图片转图片)
    expect(edit).toHaveLength(1);
    expect(countJobsForTenant(T, U, { types: ['ai_image'], source: 'ai-image-edit', sourceModeImg2img: true })).toBe(1);
  });

  it('无 source 老数据按 mode 回退,不漏历史', () => {
    enqueueJob('ai_image', { mode: 'text2img' }, T, U); // 老:无 source
    enqueueJob('ai_image', { mode: 'img2img' }, T, U); // 老:无 source
    const gen = listJobsForTenant(T, U, { types: ['ai_image'], source: 'ai-image', sourceModeImg2img: false });
    const edit = listJobsForTenant(T, U, { types: ['ai_image'], source: 'ai-image-edit', sourceModeImg2img: true });
    expect(gen).toHaveLength(1); // text2img 老数据归生成页
    expect(edit).toHaveLength(1); // img2img 老数据归编辑页
  });

  it('分页:limit/offset + total + DESC + 无重叠', () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(enqueueJob('ai_image', { source: 'ai-image', mode: 'text2img', prompt: 'p' + i }, T, U));
    expect(countJobsForTenant(T, U, { types: ['ai_image'] })).toBe(25);
    const p1 = listJobsForTenant(T, U, { types: ['ai_image'], limit: 10, offset: 0 });
    const p2 = listJobsForTenant(T, U, { types: ['ai_image'], limit: 10, offset: 10 });
    const p3 = listJobsForTenant(T, U, { types: ['ai_image'], limit: 10, offset: 20 });
    expect(p1).toHaveLength(10);
    expect(p2).toHaveLength(10);
    expect(p3).toHaveLength(5); // 尾页
    const all = new Set([...p1, ...p2, ...p3].map((j) => j.id));
    expect(all.size).toBe(25); // 三页无重叠、全覆盖
    expect(p1[0]!.id).toBe(ids[24]); // DESC:最新(最后 enqueue)在首
  });

  it('账号隔离在过滤下仍生效(每人只见自己的,无人能见全部)', () => {
    enqueueJob('ai_image', { source: 'ai-image', mode: 'text2img' }, T, 'alice');
    enqueueJob('ai_image', { source: 'ai-image', mode: 'text2img' }, T, 'bob');
    expect(listJobsForTenant(T, 'alice', { types: ['ai_image'] })).toHaveLength(1);
    expect(countJobsForTenant(T, 'alice', { types: ['ai_image'] })).toBe(1);
    expect(listJobsForTenant(T, 'bob', { types: ['ai_image'] })).toHaveLength(1);
    // 没有「全看」视角了:任何 userId 都只拿到自己的那份,陌生 id → 0 条
    expect(listJobsForTenant(T, 'x', { types: ['ai_image'] })).toHaveLength(0);
  });
});
