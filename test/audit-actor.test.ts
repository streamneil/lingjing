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
const { writeAudit, listAudit } = await import('../src/audit/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');

let tenantId = '';
let uid = '';

beforeAll(() => {
  tenantId = createTenant('审计归属台').id;
  uid = createUser(tenantId, 'opuser', 'pw123456', 'admin').id;
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

  it('platform_admin 操作行 → actorName = platform_admin.username', () => {
    const padminId = 'padmin-1';
    db.prepare(
      `INSERT INTO platform_admin (id, username, password_hash, created_at) VALUES (?,?,?,?)`,
    ).run(padminId, 'superadmin', 'x', Date.now());
    // 平台超管对本租户的操作(actor_type=platform_admin,user_id 指向 platform_admin.id)
    writeAudit(tenantId, padminId, 'grant_credit', '5000', '1.2.3.4', 'platform_admin');
    const row = listAudit(tenantId).find((a) => a.action === 'grant_credit');
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
    const asUser = listAudit(tenantId).find((a) => a.action === 'change_password');
    const asPadmin = listAudit(tenantId).find((a) => a.action === 'tenant_update');
    expect(asUser!.actorName).toBe('collideuser'); // user 行只取 user 表
    expect(asPadmin!.actorName).toBe('collidepadmin'); // padmin 行只取 platform_admin 表
  });
});
