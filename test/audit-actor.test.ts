// 灵镜 — 审计日志「谁操作了什么」(actorName JOIN)。
//
// 覆盖:
//   - listAudit() LEFT JOIN user → user 操作行带 actorName(display_name 优先,回退 username)
//   - actor_type='platform_admin' → JOIN platform_admin 取 username
//   - user_id 为空 / 用户不存在 → actorName 空(前端回退「未知用户」)
//   - GET /audit 把 actorName 投影出来

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { writeAudit, listAudit, listPlatformAudit } = await import('../src/audit/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { enqueueJob } = await import('../src/queue/index.js');

let tenantId = '';
let uid = '';

beforeAll(async () => {
  tenantId = createTenant('审计归属台').id;
  uid = (await createUser(tenantId, 'opuser', 'pw123456', 'admin')).id;
});

describe('listAudit() 带操作者名 actorName', () => {
  it('user 操作行 → actorName = display_name||username', () => {
    writeAudit(tenantId, uid, 'login', null, '1.2.3.4', 'user');
    const row = listAudit(tenantId).find((a) => a.action === 'login');
    expect(row).toBeTruthy();
    // display_name 默认空 → 回退 username
    expect(row!.actorName).toBe('opuser');

    // 设了 display_name → 优先显昵称
    db.prepare(`UPDATE user SET display_name='运营小张' WHERE id=?`).run(uid);
    writeAudit(tenantId, uid, 'create_avatar', 'av-1', '1.2.3.4', 'user');
    const row2 = listAudit(tenantId).find((a) => a.action === 'create_avatar');
    expect(row2!.actorName).toBe('运营小张');
  });

  it('平台超管操作不进租户审计,但在平台审计可见(信任边界 + actorName JOIN)', () => {
    const padminId = 'padmin-1';
    db.prepare(
      `INSERT INTO platform_admin (id, username, password_hash, created_at) VALUES (?,?,?,?)`,
    ).run(padminId, 'superadmin', 'x', Date.now());
    // 平台超管对本租户的操作(actor_type=platform_admin,target=本租户)
    writeAudit(tenantId, padminId, 'grant_credit', '5000', '1.2.3.4', 'platform_admin');
    // 租户审计:看不到平台操作(只显 actor_type='user')
    expect(listAudit(tenantId).find((a) => a.action === 'grant_credit')).toBeUndefined();
    // 平台审计:看得到,且 actorName JOIN platform_admin 正确
    const row = listPlatformAudit().find((a) => a.action === 'grant_credit');
    expect(row!.actor_type).toBe('platform_admin');
    expect(row!.actorName).toBe('superadmin');
  });

  it('user_id 为空(系统/匿名)→ actorName 空,不崩', () => {
    writeAudit(tenantId, null, 'login', null, null, 'user');
    const rows = listAudit(tenantId).filter((a) => a.action === 'login');
    const anon = rows.find((a) => a.actorName == null);
    expect(anon).toBeTruthy();
    expect(anon!.actorName ?? null).toBeNull();
  });

  it('user_id 指向已删/不存在的用户 → actorName 空(前端回退「未知用户」)', () => {
    writeAudit(tenantId, 'ghost-user-id', 'delete_voice', 'v-9', '1.2.3.4', 'user');
    const row = listAudit(tenantId).find((a) => a.action === 'delete_voice');
    expect(row!.actorName ?? null).toBeNull();
  });

  it('不串名:user 与 platform_admin 同 id 也按 actor_type 取对表', () => {
    // 构造一个 user 和一个 platform_admin 用同一个 id 值,验证 JOIN 条件带 actor_type 不串。
    const shared = 'shared-id-collision';
    db.prepare(`INSERT INTO user (id, tenant_id, username, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`)
      .run(shared, tenantId, 'collideuser', 'x', 'creator', Date.now());
    db.prepare(`INSERT INTO platform_admin (id, username, password_hash, created_at) VALUES (?,?,?,?)`)
      .run(shared, 'collidepadmin', 'x', Date.now());
    writeAudit(tenantId, shared, 'change_password', null, null, 'user');
    writeAudit(tenantId, shared, 'tenant_update', 'org-x', null, 'platform_admin');
    const asUser = listAudit(tenantId).find((a) => a.action === 'change_password'); // 租户审计:user 行
    const asPadmin = listPlatformAudit().find((a) => a.action === 'tenant_update'); // 平台审计:padmin 行
    expect(asUser!.actorName).toBe('collideuser'); // user 行只取 user 表
    expect(asPadmin!.actorName).toBe('collidepadmin'); // padmin 行只取 platform_admin 表
  });
});

describe('listAudit() 带模块 module(JOIN job)', () => {
  it('create_job 行 → module = job.type(LEFT JOIN job on target=job.id)', () => {
    const jobId = enqueueJob('video_i2v', { prompt: 'p' }, tenantId, uid);
    writeAudit(tenantId, uid, 'create_job', jobId, '1.2.3.4', 'user');
    const row = listAudit(tenantId).find((a) => a.action === 'create_job' && a.target === jobId);
    expect(row!.module).toBe('video_i2v'); // 精确工具子类型,前端映射「图片转影片」
  });

  it('不同工具 job → module 各自精确', () => {
    const img = enqueueJob('ai_image', { prompt: 'p' }, tenantId, uid);
    const tts = enqueueJob('tts', { text: 'x', voiceRef: 'Cherry' }, tenantId, uid);
    writeAudit(tenantId, uid, 'create_job', img, '1.2.3.4', 'user');
    writeAudit(tenantId, uid, 'create_job', tts, '1.2.3.4', 'user');
    expect(listAudit(tenantId).find((a) => a.target === img)!.module).toBe('ai_image');
    expect(listAudit(tenantId).find((a) => a.target === tts)!.module).toBe('tts');
  });

  it('非 create_job 行(login)→ module 空(前端显「—」)', () => {
    writeAudit(tenantId, uid, 'login', null, '1.2.3.4', 'user');
    const row = listAudit(tenantId).find((a) => a.action === 'login');
    expect(row!.module ?? null).toBeNull();
  });

  it('create_job 但 job 已删 / 不存在 → module 空,不崩', () => {
    writeAudit(tenantId, uid, 'create_job', 'ghost-job-id', '1.2.3.4', 'user');
    const row = listAudit(tenantId).find((a) => a.target === 'ghost-job-id');
    expect(row!.module ?? null).toBeNull();
  });

  it('upload_image_input 行 module 空(前端固定显「图像编辑」,非 JOIN 派生)', () => {
    writeAudit(tenantId, uid, 'upload_image_input', 'image-inputs/x.png', '1.2.3.4', 'user');
    const row = listAudit(tenantId).find((a) => a.action === 'upload_image_input');
    expect(row!.module ?? null).toBeNull(); // 后端不派生;前端按 action 固定显图像编辑
  });
});
