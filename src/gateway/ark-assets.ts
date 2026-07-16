// 灵镜 — 火山素材库资产解析器(入库 + 轮询 + 缓存 + 回退)。
//
// 把一张"已发布公网 URL 的参考图"报备为 asset://<id>,供 Seedance 视频生成绕过反 Deepfake 拦截。
// 失败/超时/审核不过 → 返回 null,调用方回退原图 URL(绝不炸 job)。
// 门控在调用方(worker),本文件不判 enabled —— 只做"给我一张图,还你 asset:// 或 null"。

import { db } from '../db/index.js';
import { config } from '../config.js';
import { createAssetGroup, createAsset, getAsset } from './ark-assets-client.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** get-or-create 素材组(每 project 一个);并发下 INSERT OR IGNORE 收敛到同一行。 */
export async function ensureGroup(projectName: string): Promise<string> {
  const existing = db.prepare('SELECT group_id FROM ark_asset_group WHERE project_name=?').get(projectName) as { group_id: string } | undefined;
  if (existing) return existing.group_id;
  const groupId = await createAssetGroup(config.arkAssets.groupName, projectName);
  db.prepare('INSERT OR IGNORE INTO ark_asset_group (project_name, group_id, created_at) VALUES (?,?,?)').run(projectName, groupId, Date.now());
  const row = db.prepare('SELECT group_id FROM ark_asset_group WHERE project_name=?').get(projectName) as { group_id: string };
  return row.group_id;
}

function upsertAsset(tenantId: string, storageKey: string, project: string, assetId: string, status: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO ark_asset (tenant_id, storage_key, project_name, asset_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, storage_key, project_name)
     DO UPDATE SET asset_id=excluded.asset_id, status=excluded.status, updated_at=excluded.updated_at`,
  ).run(tenantId, storageKey, project, assetId, status, now, now);
}

/** 把一张图(稳定 storageKey + 已发布公网 URL)解析为 asset:// URI。
 *  命中 Active 缓存直接返回;否则入库并轮询到 Active。
 *  Failed / 超时 / 任何异常 → 返回 null(调用方回退原图 URL)。 */
export async function resolveImageToAsset(tenantId: string, storageKey: string, publicUrl: string): Promise<string | null> {
  const project = config.arkAssets.projectName;
  try {
    const cached = db.prepare(
      'SELECT asset_id, status FROM ark_asset WHERE tenant_id=? AND storage_key=? AND project_name=?',
    ).get(tenantId, storageKey, project) as { asset_id: string; status: string } | undefined;
    if (cached?.status === 'Active') return `asset://${cached.asset_id}`;
    if (cached?.status === 'Failed') return null; // 审核已判死,别反复重传

    const groupId = await ensureGroup(project);
    let assetId = cached?.asset_id;
    if (!assetId) {
      assetId = await createAsset(groupId, publicUrl, project);
      upsertAsset(tenantId, storageKey, project, assetId, 'Processing');
    }

    const deadline = Date.now() + config.arkAssets.registerTimeoutMs;
    while (Date.now() < deadline) {
      const info = await getAsset(assetId, project);
      if (info.status === 'Active') {
        upsertAsset(tenantId, storageKey, project, assetId, 'Active');
        return `asset://${assetId}`;
      }
      if (info.status === 'Failed') {
        upsertAsset(tenantId, storageKey, project, assetId, 'Failed');
        return null;
      }
      await sleep(config.arkAssets.pollIntervalMs);
    }
    return null; // 超时:本次回退原图 URL;缓存留 Processing,下次继续查
  } catch (e) {
    console.warn(`[ark-asset] 解析失败,回退原图 URL:${(e as Error).message}`);
    return null;
  }
}
