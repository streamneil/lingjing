// 灵镜 Slice 3 形象 + 授权存证测试。
// 核心:创建自定义形象必须带授权(consent),否则拒绝(政企法律门票)。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const {
  listPresets,
  isPreset,
  createCustomAvatar,
  listCustom,
  deleteAvatar,
  isUsableAvatar,
} = await import('../src/avatars/index.js');

const T = 'avatar-tenant';
const U = 'user-1';

beforeEach(() => {
  db.prepare('DELETE FROM avatar').run();
  db.prepare('DELETE FROM authorization').run();
});

describe('预置形象', () => {
  it('有预置形象,且 isPreset 识别', () => {
    expect(listPresets().length).toBeGreaterThan(0);
    expect(isPreset('preset-1')).toBe(true);
    expect(isPreset('not-a-preset')).toBe(false);
  });
});

describe('自定义形象 + 授权存证', () => {
  it('未授权(consent=false)→ 拒绝创建', () => {
    expect(() =>
      createCustomAvatar({
        tenantId: T, userId: U, name: '台长', kind: 'photo',
        sourceKey: 'avatars/x.jpg', consent: false,
      }),
    ).toThrow('授权');
  });

  it('已授权 → 创建成功,且写入 authorization 存证', () => {
    const av = createCustomAvatar({
      tenantId: T, userId: U, name: '台长', kind: 'photo',
      sourceKey: 'avatars/x.jpg', consent: true, proofKey: 'authorizations/p.pdf',
    });
    expect(av.status).toBe('ready');
    expect(av.authorization_id).toBeTruthy();
    // 存证可追溯:authorization 表有对应记录,consent=1
    const auth = db.prepare('SELECT * FROM authorization WHERE id=?').get(av.authorization_id) as any;
    expect(auth.consent).toBe(1);
    expect(auth.proof_key).toBe('authorizations/p.pdf');
    expect(auth.created_by).toBe(U);
  });

  it('列表 + 删除 + 租户隔离', () => {
    createCustomAvatar({ tenantId: T, userId: U, name: 'A', kind: 'photo', sourceKey: 'k1', consent: true });
    createCustomAvatar({ tenantId: 'other', userId: U, name: 'B', kind: 'photo', sourceKey: 'k2', consent: true });
    expect(listCustom(T).length).toBe(1); // 只看自己租户
    const mine = listCustom(T)[0]!;
    expect(deleteAvatar(mine.id, T)).toBe(true);
    expect(listCustom(T).length).toBe(0);
  });

  it('isUsableAvatar:预置可用、本租户 ready 可用、跨租户不可用', () => {
    const av = createCustomAvatar({ tenantId: T, userId: U, name: 'A', kind: 'photo', sourceKey: 'k', consent: true });
    expect(isUsableAvatar('preset-1', T)).toBe(true);
    expect(isUsableAvatar(av.id, T)).toBe(true);
    expect(isUsableAvatar(av.id, 'other')).toBe(false); // 别的租户用不了
    expect(isUsableAvatar('ghost', T)).toBe(false);
  });
});
