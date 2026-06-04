// 灵镜 音色克隆服务测试。
// 克隆音色强制授权(与形象对称)。(素材库模块已删,见 remove-asset-library.md)

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const voices = await import('../src/voices/index.js');

const T = 'va-tenant';
const U = 'u1';

beforeEach(() => {
  db.prepare('DELETE FROM voice').run();
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
