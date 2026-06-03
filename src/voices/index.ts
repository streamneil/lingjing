// 灵镜 音色服务 — 预置人声 + 克隆音色,克隆强制授权存证(与形象对称)。
//
// 决策来源:/plan-eng-review D10 + 外部声音#6 —— 克隆他人声音同样需"本人授权"凭证。

import { randomUUID } from 'node:crypto';
import { db, type VoiceRow } from '../db/index.js';
import { TERMS_VERSION } from '../legal/index.js';

const now = () => Date.now();

// 预置人声(PRD 要求 40 个;Slice1 起步给代表性几个,真实接百炼后扩充)
// id 必须是 cosyvoice-v1 模型的**合法音色名**(传给 TTS 引擎的 voice 参数)。
// 不能用模型名(如 cosyvoice-v1)当 voice —— 那会让引擎返回 418(音色不匹配)。
// v1 音色名见 https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list(v2 才带 _v2 后缀)。
const PRESETS: { id: string; name: string; lang: string; gender: string; desc: string }[] = [
  { id: 'longjing', name: '新闻播报 · 雅琴', lang: '中文', gender: '女', desc: '播音员 · 新闻、纪录片' },
  { id: 'longshu', name: '沉稳男声 · 子墨', lang: '中文', gender: '男', desc: '沉稳 · 纪录片、教育' },
  { id: 'longxiaochun', name: '亲切女声 · 思雨', lang: '中文', gender: '女', desc: '亲切 · Vlog、播客' },
  { id: 'longcheng', name: '磁性男声 · 浩然', lang: '中文', gender: '男', desc: '磁性 · 广告、品牌' },
];

export function listPresets() {
  return PRESETS.map((p) => ({ ...p, kind: 'preset' as const, status: 'ready' as const }));
}
export function isPreset(ref: string): boolean {
  return PRESETS.some((p) => p.id === ref);
}

export interface CreateVoiceParams {
  tenantId: string;
  userId: string;
  name: string;
  sourceKey: string; // 样本音频已落 MinIO
  consent: boolean;
  proofKey?: string;
}

/** 克隆音色:强制授权,否则拒绝。先写 authorization 存证再建 voice。 */
export function createCloneVoice(p: CreateVoiceParams): VoiceRow {
  if (!p.consent) {
    const err = new Error('必须确认"已获被克隆人本人授权"才能克隆音色');
    (err as any).code = 'AUTHORIZATION_REQUIRED';
    throw err;
  }
  const authId = randomUUID();
  db.prepare(
    `INSERT INTO authorization (id,tenant_id,subject_type,consent,proof_key,terms_version,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(authId, p.tenantId, 'voice', 1, p.proofKey ?? null, TERMS_VERSION, p.userId, now());

  const v: VoiceRow = {
    id: randomUUID(),
    tenant_id: p.tenantId,
    name: p.name,
    kind: 'clone',
    status: 'ready', // 真实接百炼 cloneVoice 后改 processing→ready
    source_key: p.sourceKey,
    authorization_id: authId,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,authorization_id,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(v.id, v.tenant_id, v.name, v.kind, v.status, v.source_key, v.authorization_id, v.created_at);
  return v;
}

export function listClones(tenantId: string): VoiceRow[] {
  return db
    .prepare(`SELECT * FROM voice WHERE tenant_id=? ORDER BY created_at DESC`)
    .all(tenantId) as VoiceRow[];
}
export function getVoice(id: string, tenantId: string): VoiceRow | undefined {
  return db.prepare(`SELECT * FROM voice WHERE id=? AND tenant_id=?`).get(id, tenantId) as
    | VoiceRow
    | undefined;
}
export function deleteVoice(id: string, tenantId: string): boolean {
  return db.prepare(`DELETE FROM voice WHERE id=? AND tenant_id=?`).run(id, tenantId).changes === 1;
}
export function isUsableVoice(ref: string, tenantId: string): boolean {
  if (isPreset(ref)) return true;
  const v = getVoice(ref, tenantId);
  return !!v && v.status === 'ready';
}
