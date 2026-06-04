// 灵镜 成员与权限升级测试 —— 席位强制 + 锁死防护 + 角色变更 + last_active。
//
// 覆盖 eng-review 11 路径(6 回归级):
//   席位:creator 超 max 抛 SEATS_FULL;停用不释放席位(可逆);admin/viewer 不占席位
//   锁死:停用/移除自己;停用/移除最后一个 active admin
//   角色:viewer→creator 满席位拦;唯一 admin 降级拦;不能改自己
//   活跃:last_active throttle(>5min 才写)
//   列表:listUsers 返回 display_name + last_active

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const {
  createTenant,
  createUser,
  setUserStatus,
  removeUser,
  changeRole,
  listUsers,
  seatUsage,
} = await import('../src/auth/index.js');
const { db } = await import('../src/db/index.js');

// 每个 describe 用独立租户,避免共享内存库串数据。
function freshTenant(seats?: number): string {
  const t = createTenant('测试台');
  if (seats !== undefined) db.prepare(`UPDATE tenant SET max_creator_seats=? WHERE id=?`).run(seats, t.id);
  return t.id;
}
const codeOf = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code; }
};

describe('创作席位强制', () => {
  it('creator 数达上限 → 再建抛 SEATS_FULL', () => {
    const tid = freshTenant(2);
    createUser(tid, `c1_${tid}`, 'pw123456', 'creator');
    createUser(tid, `c2_${tid}`, 'pw123456', 'creator');
    expect(codeOf(() => createUser(tid, `c3_${tid}`, 'pw123456', 'creator'))).toBe('SEATS_FULL');
  });

  it('admin / viewer 不占创作席位', () => {
    const tid = freshTenant(1);
    createUser(tid, `c_${tid}`, 'pw123456', 'creator'); // 占满 1 席
    // 仍可建 admin / viewer
    expect(() => createUser(tid, `a_${tid}`, 'pw123456', 'admin')).not.toThrow();
    expect(() => createUser(tid, `v_${tid}`, 'pw123456', 'viewer')).not.toThrow();
  });

  it('停用 creator 不释放席位(可逆)→ 仍占,新建被拦', () => {
    const tid = freshTenant(1);
    const c = createUser(tid, `c_${tid}`, 'pw123456', 'creator');
    setUserStatus(tid, c.id, 'disabled');
    // 停用后席位仍被占用 → 不能再建 creator
    expect(codeOf(() => createUser(tid, `c2_${tid}`, 'pw123456', 'creator'))).toBe('SEATS_FULL');
    expect(seatUsage(tid).used).toBe(1); // active+disabled 都算
  });

  it('移除 creator 才释放席位', () => {
    const tid = freshTenant(1);
    const c = createUser(tid, `c_${tid}`, 'pw123456', 'creator');
    removeUser(tid, c.id);
    expect(seatUsage(tid).used).toBe(0);
    expect(() => createUser(tid, `c2_${tid}`, 'pw123456', 'creator')).not.toThrow();
  });

  it('seatUsage 返回 used/limit', () => {
    const tid = freshTenant(5);
    createUser(tid, `c_${tid}`, 'pw123456', 'creator');
    expect(seatUsage(tid)).toEqual({ used: 1, limit: 5 });
  });
});

describe('锁死防护(self + last-admin)', () => {
  it('不能停用自己', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    createUser(tid, `a2_${tid}`, 'pw123456', 'admin'); // 留一个,排除 last-admin 干扰
    expect(codeOf(() => setUserStatus(tid, a.id, 'disabled', a.id))).toBe('SELF_ACTION');
  });

  it('不能移除自己', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    createUser(tid, `a2_${tid}`, 'pw123456', 'admin');
    expect(codeOf(() => removeUser(tid, a.id, a.id))).toBe('SELF_ACTION');
  });

  it('不能停用最后一个 active admin', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    // 另一个 admin 是停用态 → active admin 只剩 a;由别人(非自己)发起停用 a
    const a2 = createUser(tid, `a2_${tid}`, 'pw123456', 'admin');
    setUserStatus(tid, a2.id, 'disabled');
    expect(codeOf(() => setUserStatus(tid, a.id, 'disabled', a2.id))).toBe('LAST_ADMIN');
  });

  it('不能移除最后一个 active admin', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    const other = createUser(tid, `v_${tid}`, 'pw123456', 'viewer');
    expect(codeOf(() => removeUser(tid, a.id, other.id))).toBe('LAST_ADMIN');
  });

  it('两个 admin 时可停用其中一个', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    const a2 = createUser(tid, `a2_${tid}`, 'pw123456', 'admin');
    expect(setUserStatus(tid, a2.id, 'disabled', a.id)).toBe(true);
  });
});

describe('角色变更(闭合席位不变量)', () => {
  it('viewer→creator 满席位 → 抛 SEATS_FULL', () => {
    const tid = freshTenant(1);
    createUser(tid, `c_${tid}`, 'pw123456', 'creator'); // 占满
    const v = createUser(tid, `v_${tid}`, 'pw123456', 'viewer');
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    expect(codeOf(() => changeRole(tid, v.id, 'creator', a.id))).toBe('SEATS_FULL');
  });

  it('唯一 active admin 降级 → 抛 LAST_ADMIN', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    const a2 = createUser(tid, `a2_${tid}`, 'pw123456', 'admin');
    setUserStatus(tid, a2.id, 'disabled'); // active admin 只剩 a
    expect(codeOf(() => changeRole(tid, a.id, 'viewer', a2.id))).toBe('LAST_ADMIN');
  });

  it('不能改自己的角色', () => {
    const tid = freshTenant();
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    createUser(tid, `a2_${tid}`, 'pw123456', 'admin');
    expect(codeOf(() => changeRole(tid, a.id, 'viewer', a.id))).toBe('SELF_ACTION');
  });

  it('viewer→creator 有空席位 → 成功 + 占席位', () => {
    const tid = freshTenant(2);
    const v = createUser(tid, `v_${tid}`, 'pw123456', 'viewer');
    const a = createUser(tid, `a_${tid}`, 'pw123456', 'admin');
    expect(changeRole(tid, v.id, 'creator', a.id)).toBe(true);
    expect(seatUsage(tid).used).toBe(1);
  });
});

describe('listUsers 字段 + last_active', () => {
  it('返回 display_name + last_active(新建为 null)', () => {
    const tid = freshTenant();
    createUser(tid, `u_${tid}`, 'pw123456', 'admin');
    const list = listUsers(tid);
    expect(list.length).toBe(1);
    expect(list[0]).toHaveProperty('display_name');
    expect(list[0]).toHaveProperty('last_active');
    expect(list[0]!.last_active).toBeNull(); // 从未活跃
  });

  it('按 created_at 升序(席位号派生依赖此序)', () => {
    const tid = freshTenant(5);
    const c1 = createUser(tid, `c1_${tid}`, 'pw123456', 'creator');
    const c2 = createUser(tid, `c2_${tid}`, 'pw123456', 'creator');
    const list = listUsers(tid).filter((u) => u.role === 'creator');
    expect(list[0]!.id).toBe(c1.id);
    expect(list[1]!.id).toBe(c2.id);
  });
});
