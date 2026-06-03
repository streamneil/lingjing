// 灵镜 素材库服务 — 图片/视频/音频的基础管理(PRD G:基础,智能分析二期)。

import { randomUUID } from 'node:crypto';
import { db, type AssetRow } from '../db/index.js';

const now = () => Date.now();

export interface CreateAssetParams {
  tenantId: string;
  userId: string;
  name: string;
  type: 'image' | 'video' | 'audio';
  sourceKey: string;
  size?: number;
}

export function createAsset(p: CreateAssetParams): AssetRow {
  const a: AssetRow = {
    id: randomUUID(),
    tenant_id: p.tenantId,
    name: p.name,
    type: p.type,
    source_key: p.sourceKey,
    size: p.size ?? null,
    created_by: p.userId,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO asset (id,tenant_id,name,type,source_key,size,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(a.id, a.tenant_id, a.name, a.type, a.source_key, a.size, a.created_by, a.created_at);
  return a;
}

export function listAssets(tenantId: string, type?: string): AssetRow[] {
  if (type) {
    return db
      .prepare(`SELECT * FROM asset WHERE tenant_id=? AND type=? ORDER BY created_at DESC`)
      .all(tenantId, type) as AssetRow[];
  }
  return db
    .prepare(`SELECT * FROM asset WHERE tenant_id=? ORDER BY created_at DESC`)
    .all(tenantId) as AssetRow[];
}

export function getAsset(id: string, tenantId: string): AssetRow | undefined {
  return db.prepare(`SELECT * FROM asset WHERE id=? AND tenant_id=?`).get(id, tenantId) as
    | AssetRow
    | undefined;
}

export function deleteAsset(id: string, tenantId: string): boolean {
  return db.prepare(`DELETE FROM asset WHERE id=? AND tenant_id=?`).run(id, tenantId).changes === 1;
}

/** 从 MIME 推断素材类型。 */
export function inferType(mime: string): 'image' | 'video' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}
