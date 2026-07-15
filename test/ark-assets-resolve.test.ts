import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 网络客户端(Task 2);解析器逻辑纯本地可测。
vi.mock('../src/gateway/ark-assets-client.js', () => ({
  createAssetGroup: vi.fn(async () => 'group-x'),
  createAsset: vi.fn(async () => 'asset-1'),
  getAsset: vi.fn(async () => ({ id: 'asset-1', status: 'Active' })),
}));

import * as client from '../src/gateway/ark-assets-client.js';
import { db } from '../src/db/index.js';
import { config } from '../src/config.js';
import { resolveImageToAsset } from '../src/gateway/ark-assets.js';

// config 是 `as const`(类型只读),运行时仍是普通可变对象 → 测试经可变视图改配置。
const ark = config.arkAssets as unknown as {
  enabled: boolean; projectName: string; registerTimeoutMs: number; pollIntervalMs: number; retryOnCodes: string[];
};

beforeEach(() => {
  db.prepare('DELETE FROM ark_asset').run();
  db.prepare('DELETE FROM ark_asset_group').run();
  vi.clearAllMocks();
  ark.projectName = '';
  ark.registerTimeoutMs = 5000;
  ark.pollIntervalMs = 1;
});

describe('resolveImageToAsset', () => {
  it('入库→Active:返回 asset:// 并缓存', async () => {
    const uri = await resolveImageToAsset('t1', 'key-1', 'https://oss/x.jpg');
    expect(uri).toBe('asset://asset-1');
    expect(client.createAsset).toHaveBeenCalledTimes(1);
    const row = db.prepare('SELECT status FROM ark_asset WHERE tenant_id=? AND storage_key=?').get('t1', 'key-1') as { status: string };
    expect(row.status).toBe('Active');
  });

  it('命中 Active 缓存:不再调用网络', async () => {
    db.prepare(`INSERT INTO ark_asset (tenant_id,storage_key,project_name,asset_id,status,created_at,updated_at) VALUES ('t1','key-1','','asset-9','Active',1,1)`).run();
    const uri = await resolveImageToAsset('t1', 'key-1', 'https://oss/x.jpg');
    expect(uri).toBe('asset://asset-9');
    expect(client.createAsset).not.toHaveBeenCalled();
    expect(client.getAsset).not.toHaveBeenCalled();
  });

  it('审核 Failed:返回 null 并记 Failed(回退原图)', async () => {
    (client.getAsset as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'asset-1', status: 'Failed' });
    const uri = await resolveImageToAsset('t1', 'key-2', 'https://oss/y.jpg');
    expect(uri).toBeNull();
    const row = db.prepare('SELECT status FROM ark_asset WHERE tenant_id=? AND storage_key=?').get('t1', 'key-2') as { status: string };
    expect(row.status).toBe('Failed');
  });

  it('网络异常:返回 null(回退原图,不抛)', async () => {
    (client.createAsset as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const uri = await resolveImageToAsset('t1', 'key-3', 'https://oss/z.jpg');
    expect(uri).toBeNull();
  });

  it('超时(一直 Processing):返回 null', async () => {
    (client.getAsset as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'asset-1', status: 'Processing' });
    ark.registerTimeoutMs = 5; // 立即超时
    const uri = await resolveImageToAsset('t1', 'key-4', 'https://oss/w.jpg');
    expect(uri).toBeNull();
  });
});
