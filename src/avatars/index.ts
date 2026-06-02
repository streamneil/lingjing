// 灵镜 形象服务 — 预置 + 自定义形象,自定义强制授权存证。
//
// 决策来源:/plan-eng-review D10 + 外部声音#6 —— 创建自定义形象(上传他人肖像)
// 必须留"本人授权"凭证。未授权直接拒绝(政企法律门票 + 百炼接口可能硬性要求)。

import { randomUUID } from 'node:crypto';
import { db, type AvatarRow, type AvatarKind } from '../db/index.js';

const now = () => Date.now();

// 预置形象(Slice1 命脉闭环用,无授权问题 —— 平台自有授权素材)
const PRESETS: { id: string; name: string; thumb: string }[] = [
  { id: 'preset-1', name: '新闻女主播 · 晓琳', thumb: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=300&q=85&fit=crop&crop=faces' },
  { id: 'preset-2', name: '财经男主播 · 浩然', thumb: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&q=85&fit=crop&crop=faces' },
  { id: 'preset-3', name: '出镜记者 · 思雨', thumb: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=300&q=85&fit=crop&crop=faces' },
];

/** 预置形象(不入库,直接返回;所有租户共享)。 */
export function listPresets() {
  return PRESETS.map((p) => ({ ...p, kind: 'preset' as const, status: 'ready' as const }));
}

export function isPreset(avatarRef: string): boolean {
  return PRESETS.some((p) => p.id === avatarRef);
}

export interface CreateAvatarParams {
  tenantId: string;
  userId: string;
  name: string;
  kind: AvatarKind; // photo | video
  sourceKey: string; // 已落 MinIO 的源素材 key
  consent: boolean; // 是否勾选"已获本人授权"
  proofKey?: string; // 授权凭证文件 key
}

/**
 * 创建自定义形象。强制授权:consent 必须为 true,否则抛错(合规门票)。
 * 先写 authorization 凭证,再建 avatar 关联它 —— 留可追溯的存证链。
 */
export function createCustomAvatar(p: CreateAvatarParams): AvatarRow {
  if (!p.consent) {
    const err = new Error('必须确认"已获被克隆人本人授权"才能创建自定义形象');
    (err as any).code = 'AUTHORIZATION_REQUIRED';
    throw err;
  }

  const authId = randomUUID();
  db.prepare(
    `INSERT INTO authorization (id,tenant_id,subject_type,consent,proof_key,created_by,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(authId, p.tenantId, 'avatar', 1, p.proofKey ?? null, p.userId, now());

  const av: AvatarRow = {
    id: randomUUID(),
    tenant_id: p.tenantId,
    name: p.name,
    kind: p.kind,
    // Slice1:照片即时可用(预置能力);真实接百炼 createAvatar 后改为 processing→ready
    status: 'ready',
    source_key: p.sourceKey,
    thumb_url: p.sourceKey, // 自定义用源图当缩略(签名 URL 在 API 层生成)
    authorization_id: authId,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO avatar (id,tenant_id,name,kind,status,source_key,thumb_url,authorization_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(av.id, av.tenant_id, av.name, av.kind, av.status, av.source_key, av.thumb_url, av.authorization_id, av.created_at);
  return av;
}

/** 列某租户的自定义形象。 */
export function listCustom(tenantId: string): AvatarRow[] {
  return db
    .prepare(`SELECT * FROM avatar WHERE tenant_id=? ORDER BY created_at DESC`)
    .all(tenantId) as AvatarRow[];
}

export function getAvatar(id: string, tenantId: string): AvatarRow | undefined {
  return db.prepare(`SELECT * FROM avatar WHERE id=? AND tenant_id=?`).get(id, tenantId) as
    | AvatarRow
    | undefined;
}

export function deleteAvatar(id: string, tenantId: string): boolean {
  const res = db.prepare(`DELETE FROM avatar WHERE id=? AND tenant_id=?`).run(id, tenantId);
  return res.changes === 1;
}

/** 校验 avatarRef 是否对该租户可用(预置 or 本租户自定义)—— 供生成时校验。 */
export function isUsableAvatar(avatarRef: string, tenantId: string): boolean {
  if (isPreset(avatarRef)) return true;
  const av = getAvatar(avatarRef, tenantId);
  return !!av && av.status === 'ready';
}
