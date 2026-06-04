// 灵镜 音色克隆 + 素材库服务测试。
// 克隆音色同样强制授权(与形象对称);素材库基础 CRUD + 租户隔离。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const voices = await import('../src/voices/index.js');
const assets = await import('../src/assets/index.js');

const T = 'va-tenant';
const U = 'u1';

beforeEach(() => {
  db.prepare('DELETE FROM voice').run();
  db.prepare('DELETE FROM asset').run();
  db.prepare('DELETE FROM authorization').run();
});

describe('音色:预置 + 克隆授权', () => {
  it('有预置人声', () => {
    expect(voices.listPresets().length).toBeGreaterThan(0);
    expect(voices.isPreset('longjing')).toBe(true);
  });
  it('未授权克隆 → 拒绝', () => {
    expect(() =>
      voices.createCloneVoice({ tenantId: T, userId: U, name: '台长配音', sourceKey: 'k', consent: false }),
    ).toThrow('授权');
  });
  it('授权克隆 → 成功 + 写存证(复刻产出 voice_id → ready)', () => {
    const v = voices.createCloneVoice({ tenantId: T, userId: U, name: '台长配音', sourceKey: 'k', consent: true, proofKey: 'p', providerVoiceId: 'cosyvoice-v1-x-abc' });
    expect(v.kind).toBe('clone');
    expect(v.status).toBe('ready'); // 有 provider_voice_id → ready
    expect(v.provider_voice_id).toBe('cosyvoice-v1-x-abc');
    const auth = db.prepare('SELECT * FROM authorization WHERE id=?').get(v.authorization_id) as any;
    expect(auth.subject_type).toBe('voice');
    expect(auth.consent).toBe(1);
  });
  it('复刻未产出 voice_id → status=failed(不可用,避免误生成)', () => {
    const v = voices.createCloneVoice({ tenantId: T, userId: U, name: 'x', sourceKey: 'k', consent: true });
    expect(v.status).toBe('failed');
    expect(voices.isUsableVoice(v.id, T)).toBe(false);
  });
  it('isUsableVoice:预置 + 本租户 ready(复刻成功)可用,跨租户不可用', () => {
    const v = voices.createCloneVoice({ tenantId: T, userId: U, name: 'x', sourceKey: 'k', consent: true, providerVoiceId: 'cosyvoice-v1-y-def' });
    expect(voices.isUsableVoice('longjing', T)).toBe(true);
    expect(voices.isUsableVoice(v.id, T)).toBe(true);
    expect(voices.isUsableVoice(v.id, 'other')).toBe(false);
  });
});

describe('素材库 CRUD', () => {
  it('inferType 按 MIME 推断', () => {
    expect(assets.inferType('image/png')).toBe('image');
    expect(assets.inferType('video/mp4')).toBe('video');
    expect(assets.inferType('audio/mpeg')).toBe('audio');
    expect(assets.inferType('application/pdf')).toBeNull();
  });
  it('创建 + 列表 + 类型筛选 + 删除 + 租户隔离', () => {
    assets.createAsset({ tenantId: T, userId: U, name: 'a.png', type: 'image', sourceKey: 'k1' });
    assets.createAsset({ tenantId: T, userId: U, name: 'b.mp4', type: 'video', sourceKey: 'k2' });
    assets.createAsset({ tenantId: 'other', userId: U, name: 'c.png', type: 'image', sourceKey: 'k3' });
    expect(assets.listAssets(T).length).toBe(2);
    expect(assets.listAssets(T, 'image').length).toBe(1);
    const mine = assets.listAssets(T)[0]!;
    expect(assets.deleteAsset(mine.id, T)).toBe(true);
    expect(assets.listAssets(T).length).toBe(1);
  });
});
