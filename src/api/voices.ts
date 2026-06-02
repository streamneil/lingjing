// 灵镜 API — 音色库路由(预置 + 克隆上传)。授权强制,仅 admin/creator 可创建。

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { listPresets, listClones, createCloneVoice, deleteVoice, getVoice } from '../voices/index.js';
import { putObject, getSignedUrl } from '../storage/index.js';
import { audit } from '../audit/index.js';

export const voicesRouter = Router();

// 音频样本 5-30s ≤100MB(PRD);授权凭证另算
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

voicesRouter.get('/voices', requireAuth, async (req: Request, res: Response) => {
  const presets = listPresets();
  const clones = await Promise.all(
    listClones(req.user!.tenantId).map(async (v) => ({
      id: v.id,
      name: v.name,
      kind: v.kind,
      status: v.status,
      sample: v.source_key ? await getSignedUrl(v.source_key).catch(() => null) : null,
      createdAt: v.created_at,
    })),
  );
  res.json({ presets, clones });
});

voicesRouter.post(
  '/voices',
  requireRole('admin', 'creator'),
  upload.fields([
    { name: 'sample', maxCount: 1 },
    { name: 'proof', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const sample = files?.sample?.[0];
    const proof = files?.proof?.[0];
    const name = (req.body?.name as string) || '克隆音色';
    const consent = req.body?.consent === 'true' || req.body?.consent === true;

    if (!sample) return res.status(400).json({ error: '缺少音频样本 sample' });
    if (!consent) return res.status(400).json({ error: '必须勾选"已获被克隆人本人授权"' });

    const tenantId = req.user!.tenantId;
    try {
      const ext = (sample.originalname.split('.').pop() || 'mp3').toLowerCase();
      const sampleKey = `voices/${tenantId}/${randomUUID()}.${ext}`;
      await putObject(sampleKey, sample.buffer, sample.mimetype);

      let proofKey: string | undefined;
      if (proof) {
        const pext = (proof.originalname.split('.').pop() || 'bin').toLowerCase();
        proofKey = `authorizations/${tenantId}/${randomUUID()}.${pext}`;
        await putObject(proofKey, proof.buffer, proof.mimetype);
      }

      const v = createCloneVoice({ tenantId, userId: req.user!.id, name, sourceKey: sampleKey, consent, proofKey });
      audit(req, 'clone_voice', v.id);
      res.status(201).json({ id: v.id, name: v.name, status: v.status });
    } catch (e) {
      const status = (e as any)?.code === 'AUTHORIZATION_REQUIRED' ? 400 : 500;
      res.status(status).json({ error: e instanceof Error ? e.message : '克隆失败' });
    }
  },
);

voicesRouter.delete('/voices/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const v = getVoice(req.params.id!, req.user!.tenantId);
  if (!v) return res.status(404).json({ error: '音色不存在' });
  deleteVoice(req.params.id!, req.user!.tenantId);
  audit(req, 'delete_voice', req.params.id!);
  res.json({ ok: true });
});
