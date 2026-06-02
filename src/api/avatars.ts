// 灵镜 API — 形象库路由(预置 + 自定义上传)。
//
// 上传:multipart/form-data,multer 内存缓冲 → 落 MinIO。
// 授权存证强制:consent !== 'true' 直接 400(/plan-eng-review D10)。
// 仅 admin/creator 可创建(viewer 只读)。

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  listPresets,
  listCustom,
  createCustomAvatar,
  deleteAvatar,
  getAvatar,
} from '../avatars/index.js';
import { putObject, getSignedUrl } from '../storage/index.js';
import { audit } from '../audit/index.js';

export const avatarsRouter = Router();

// 内存存储 + 30MB 上限(PRD ≤30MB);照片 + 授权凭证两个字段
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// 列表:预置 + 本租户自定义(自定义缩略图签名后返回)
avatarsRouter.get('/avatars', requireAuth, async (req: Request, res: Response) => {
  const presets = listPresets();
  const custom = listCustom(req.user!.tenantId);
  const customOut = await Promise.all(
    custom.map(async (a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      status: a.status,
      thumb: a.thumb_url ? await getSignedUrl(a.thumb_url).catch(() => null) : null,
      createdAt: a.created_at,
    })),
  );
  res.json({ presets, custom: customOut });
});

// 创建自定义形象(上传照片 + 授权凭证)
avatarsRouter.post(
  '/avatars',
  requireRole('admin', 'creator'),
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'proof', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const photo = files?.photo?.[0];
    const proof = files?.proof?.[0];
    const name = (req.body?.name as string) || '自定义形象';
    const consent = req.body?.consent === 'true' || req.body?.consent === true;

    if (!photo) return res.status(400).json({ error: '缺少照片文件 photo' });
    // 授权存证强制(政企法律门票)
    if (!consent) {
      return res.status(400).json({ error: '必须勾选"已获被克隆人本人授权"' });
    }

    const tenantId = req.user!.tenantId;
    try {
      // 落 MinIO:照片 + 授权凭证(若有)
      const ext = (photo.originalname.split('.').pop() || 'jpg').toLowerCase();
      const photoKey = `avatars/${tenantId}/${randomUUID()}.${ext}`;
      await putObject(photoKey, photo.buffer, photo.mimetype);

      let proofKey: string | undefined;
      if (proof) {
        const pext = (proof.originalname.split('.').pop() || 'bin').toLowerCase();
        proofKey = `authorizations/${tenantId}/${randomUUID()}.${pext}`;
        await putObject(proofKey, proof.buffer, proof.mimetype);
      }

      const av = createCustomAvatar({
        tenantId,
        userId: req.user!.id,
        name,
        kind: 'photo',
        sourceKey: photoKey,
        consent,
        proofKey,
      });
      audit(req, 'create_avatar', av.id);
      res.status(201).json({ id: av.id, name: av.name, status: av.status });
    } catch (e) {
      const code = (e as any)?.code;
      const status = code === 'AUTHORIZATION_REQUIRED' ? 400 : 500;
      res.status(status).json({ error: e instanceof Error ? e.message : '创建失败' });
    }
  },
);

avatarsRouter.delete('/avatars/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const av = getAvatar(req.params.id!, req.user!.tenantId);
  if (!av) return res.status(404).json({ error: '形象不存在' });
  deleteAvatar(req.params.id!, req.user!.tenantId);
  audit(req, 'delete_avatar', req.params.id!);
  res.json({ ok: true });
});
