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
  renameAvatar,
  setDefaultAvatar,
} from '../avatars/index.js';
import { putObject, getSignedUrl } from '../storage/index.js';
import { extractFirstFrame, detectOrientation } from '../pipeline/ai-label.js';
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
  const custom = listCustom(req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  const customOut = await Promise.all(
    custom.map(async (a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      status: a.status,
      orientation: a.orientation,
      isDefault: a.is_default === 1,
      thumb: a.thumb_url ? await getSignedUrl(a.thumb_url).catch(() => null) : null,
      createdAt: a.created_at,
    })),
  );
  res.json({ presets, custom: customOut });
});

// 创建自定义形象(C2 照片 / C3 视频提取首帧 + 授权凭证)
avatarsRouter.post(
  '/avatars',
  requireRole('admin', 'creator'),
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'video', maxCount: 1 }, // C3:上传视频提取首帧为形象
    { name: 'proof', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const photo = files?.photo?.[0];
    const video = files?.video?.[0];
    const proof = files?.proof?.[0];
    const name = (req.body?.name as string) || '自定义形象';
    const orientation = (req.body?.orientation as 'portrait' | 'landscape' | 'square') || 'portrait';
    const consent = req.body?.consent === 'true' || req.body?.consent === true;

    if (!photo && !video) return res.status(400).json({ error: '缺少照片(photo)或视频(video)文件' });
    // 授权存证强制(政企法律门票)
    if (!consent) {
      return res.status(400).json({ error: '必须勾选"已获被克隆人本人授权"' });
    }

    const tenantId = req.user!.tenantId;
    try {
      let sourceKey: string;
      let kind: 'photo' | 'video';
      let imageBuf: Buffer; // 形象图字节,用于检真实比例
      if (video) {
        // C3:从视频提取首帧 → 落 MinIO 作形象图(ffmpeg)
        const frame = await extractFirstFrame(video.buffer);
        if (!frame) return res.status(422).json({ error: '视频抽帧失败(需 ffmpeg);请改用照片上传' });
        sourceKey = `avatars/${tenantId}/${randomUUID()}.jpg`;
        await putObject(sourceKey, frame, 'image/jpeg');
        kind = 'video';
        imageBuf = frame;
      } else {
        const ext = (photo!.originalname.split('.').pop() || 'jpg').toLowerCase();
        sourceKey = `avatars/${tenantId}/${randomUUID()}.${ext}`;
        await putObject(sourceKey, photo!.buffer, photo!.mimetype);
        kind = 'photo';
        imageBuf = photo!.buffer;
      }

      // wan2.2-s2v 按图片真实比例出视频。用 ffprobe 检真实朝向覆盖用户手选(防比例标记擒谎);
      // ffprobe 不可用(私有化未装)则回退用户手选值,不阻断上传。
      const detected = await detectOrientation(imageBuf);
      const finalOrientation = detected ?? orientation;

      let proofKey: string | undefined;
      if (proof) {
        const pext = (proof.originalname.split('.').pop() || 'bin').toLowerCase();
        proofKey = `authorizations/${tenantId}/${randomUUID()}.${pext}`;
        await putObject(proofKey, proof.buffer, proof.mimetype);
      }

      const av = createCustomAvatar({
        tenantId, userId: req.user!.id, name, kind, sourceKey, consent, proofKey, orientation: finalOrientation,
      });
      audit(req, 'create_avatar', av.id);
      res.status(201).json({ id: av.id, name: av.name, status: av.status, kind });
    } catch (e) {
      const code = (e as any)?.code;
      const status = code === 'AUTHORIZATION_REQUIRED' ? 400 : 500;
      res.status(status).json({ error: e instanceof Error ? e.message : '创建失败' });
    }
  },
);

// C6:重命名
avatarsRouter.put('/avatars/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const name = (req.body?.name as string || '').trim();
  if (!name) return res.status(400).json({ error: '缺少 name' });
  const ok = renameAvatar(req.params.id!, req.user!.tenantId, name, req.user!.id, req.user!.role === 'admin');
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: '形象不存在' });
});

// C6:设为默认
avatarsRouter.post('/avatars/:id/default', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const ok = setDefaultAvatar(req.params.id!, req.user!.tenantId);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: '形象不存在' });
});

avatarsRouter.delete('/avatars/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const isAdmin = req.user!.role === 'admin';
  const av = getAvatar(req.params.id!, req.user!.tenantId, req.user!.id, isAdmin);
  if (!av) return res.status(404).json({ error: '形象不存在' });
  deleteAvatar(req.params.id!, req.user!.tenantId, req.user!.id, isAdmin);
  audit(req, 'delete_avatar', req.params.id!);
  res.json({ ok: true });
});
