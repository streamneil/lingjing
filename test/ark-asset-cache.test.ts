import { describe, it, expect } from 'vitest';
import { db } from '../src/db/index.js';

describe('ark_asset 缓存表', () => {
  it('两张表存在且 ark_asset 唯一键去重生效', () => {
    // 表存在(查 sqlite_master)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ark_asset','ark_asset_group')",
    ).all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['ark_asset', 'ark_asset_group']);

    // 唯一键 (tenant_id, storage_key, project_name):同键第二次 upsert 更新而非重复插入
    const ins = db.prepare(
      `INSERT INTO ark_asset (tenant_id, storage_key, project_name, asset_id, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, storage_key, project_name)
       DO UPDATE SET asset_id=excluded.asset_id, status=excluded.status, updated_at=excluded.updated_at`,
    );
    ins.run('t1', 'k1', '', 'asset-a', 'Processing', 1, 1);
    ins.run('t1', 'k1', '', 'asset-b', 'Active', 2, 2);
    const rows = db.prepare('SELECT asset_id, status FROM ark_asset WHERE tenant_id=? AND storage_key=? AND project_name=?').all('t1', 'k1', '') as { asset_id: string; status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ asset_id: 'asset-b', status: 'Active' });
  });
});
