// 灵镜 API — 素材库路由(上传/列表/删除)。

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { createAsset, listAssets, deleteAsset, getAsset, inferType } from '../assets/index.js';
import { putObject, getSignedUrl } from '../storage/index.js';
import { audit } from '../audit/index.js';

export const assetsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

assetsRouter.get('/assets', requireAuth, async (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const list = listAssets(req.user!.tenantId, type);
  const out = await Promise.all(
    list.map(async (a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      size: a.size,
      url: await getSignedUrl(a.source_key).catch(() => null),
      createdAt: a.created_at,
    })),
  );
  res.json(out);
});

assetsRouter.post(
  '/assets',
  requireRole('admin', 'creator'),
  upload.single('file'),
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '缺少文件 file' });
    const type = inferType(file.mimetype);
    if (!type) return res.status(400).json({ error: '不支持的文件类型(仅图片/视频/音频)' });

    const tenantId = req.user!.tenantId;
    const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase();
    const key = `assets/${tenantId}/${randomUUID()}.${ext}`;
    try {
      await putObject(key, file.buffer, file.mimetype);
      const a = createAsset({
        tenantId,
        userId: req.user!.id,
        name: file.originalname || '素材',
        type,
        sourceKey: key,
        size: file.size,
      });
      audit(req, 'upload_asset', a.id);
      res.status(201).json({ id: a.id, name: a.name, type: a.type });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : '上传失败' });
    }
  },
);

assetsRouter.delete('/assets/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const a = getAsset(req.params.id!, req.user!.tenantId);
  if (!a) return res.status(404).json({ error: '素材不存在' });
  deleteAsset(req.params.id!, req.user!.tenantId);
  audit(req, 'delete_asset', req.params.id!);
  res.json({ ok: true });
});
