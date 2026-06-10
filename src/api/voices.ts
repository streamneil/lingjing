// 灵镜 API — 音色库路由(预置 + 克隆上传)。授权强制,仅 admin/creator 可创建。

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  listPresets,
  listClones,
  createCloneVoice,
  createDesignVoice,
  deleteVoice,
  getVoice,
  countCustomVoices,
  countRecentDesignVoices,
} from '../voices/index.js';
import { putObject, getSignedUrl } from '../storage/index.js';
import { createClonedVoice, createDesignedVoice } from '../gateway/cosyvoice.js';
import { audit } from '../audit/index.js';

export const voicesRouter = Router();

// 音频样本 5-30s ≤100MB(PRD);授权凭证另算
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// 声音设计防滥用闸(eng-review 张力2:创建会烧付费 Qwen 调用)
const DESIGN_PROMPT_MAX = 2048; // Qwen voice_prompt 上限
const MAX_CUSTOM_VOICES = 50; // 每租户克隆+设计音色总数上限
const DESIGN_RATE_WINDOW_MS = 60_000; // 频率窗口:1 分钟
const DESIGN_RATE_MAX = 5; // 窗口内最多创建 5 个设计音色

voicesRouter.get('/voices', requireAuth, async (req: Request, res: Response) => {
  // 预置:每请求签名试听样本 key(URL 会过期,不缓存;样本由 seed 脚本一次性合成上传)。
  const presets = await Promise.all(
    listPresets().map(async (p) => ({
      ...p,
      sample: await getSignedUrl(p.sampleKey).catch(() => null),
    })),
  );
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

      // 真实声音复刻:样本公网 URL(OSS 签名)→ 百炼 create_voice → voice_id。
      // 复刻须公网可达,本地 MinIO 不行(同 wan2.2 素材问题),失败则降级建一个 failed 音色。
      let providerVoiceId: string | undefined;
      try {
        const sampleUrl = await getSignedUrl(sampleKey, 3600);
        // prefix:仅数字+小写字母、<10 字符。用租户+随机派生一个合法短前缀。
        const prefix = ('v' + randomUUID().replace(/[^a-z0-9]/g, '')).slice(0, 9);
        providerVoiceId = await createClonedVoice(sampleUrl, prefix);
      } catch (cloneErr) {
        // 复刻失败(如本地 MinIO 不可达 / 样本不合规):不阻断,建 failed 音色,前端可见原因。
        console.warn('声音复刻失败:', cloneErr instanceof Error ? cloneErr.message : cloneErr);
      }

      const v = createCloneVoice({
        tenantId, userId: req.user!.id, name, sourceKey: sampleKey, consent, proofKey, providerVoiceId,
      });
      audit(req, 'clone_voice', v.id);
      res.status(201).json({ id: v.id, name: v.name, status: v.status });
    } catch (e) {
      const status = (e as any)?.code === 'AUTHORIZATION_REQUIRED' ? 400 : 500;
      res.status(status).json({ error: e instanceof Error ? e.message : '克隆失败' });
    }
  },
);

// 声音设计:纯文本描述生成合成音色(无音频样本、无 consent)。
// 创建免费(不 reserve/settle,与克隆对称),但加配额/限流闸防刷付费 Qwen 预览(eng-review 张力2)。
voicesRouter.post('/voices/design', requireRole('admin', 'creator'), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const name = (req.body?.name as string)?.trim() || '设计音色';
  const voicePrompt = (req.body?.voicePrompt as string)?.trim() || '';
  const previewText =
    (req.body?.previewText as string)?.trim() || '大家好,这是我的专属音色,很高兴为你朗读。';

  // 1. 输入校验
  if (!voicePrompt) return res.status(400).json({ error: '缺少声音描述 voicePrompt' });
  if (voicePrompt.length > DESIGN_PROMPT_MAX)
    return res.status(400).json({ error: `声音描述不超过 ${DESIGN_PROMPT_MAX} 字` });

  // 2. 防滥用闸:总数上限 + 创建频率(创建会调付费 Qwen,免费但限量)
  if (countCustomVoices(tenantId) >= MAX_CUSTOM_VOICES)
    return res.status(429).json({ error: `自建音色已达上限(${MAX_CUSTOM_VOICES}),请先删除部分音色` });
  if (countRecentDesignVoices(tenantId, DESIGN_RATE_WINDOW_MS) >= DESIGN_RATE_MAX)
    return res.status(429).json({ error: '声音设计过于频繁,请稍后再试' });

  try {
    // 3. 调 Qwen 声音设计 → voice id + 预览音频
    const { voiceId, previewAudio } = await createDesignedVoice(voicePrompt, previewText, 'design');

    // 4. 入库(kind=design,无授权存证)
    const v = createDesignVoice({ tenantId, name, providerVoiceId: voiceId });

    // 5. 预览音频落 MinIO(供前端试听确认)
    let previewUrl: string | null = null;
    if (previewAudio) {
      const key = `voices/${tenantId}/preview-${v.id}.wav`;
      await putObject(key, previewAudio, 'audio/wav');
      previewUrl = await getSignedUrl(key).catch(() => null);
    }

    audit(req, 'design_voice', v.id);
    return res.status(201).json({ id: v.id, name: v.name, status: v.status, previewUrl });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : '声音设计失败' });
  }
});

voicesRouter.delete('/voices/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const v = getVoice(req.params.id!, req.user!.tenantId);
  if (!v) return res.status(404).json({ error: '音色不存在' });
  deleteVoice(req.params.id!, req.user!.tenantId);
  audit(req, 'delete_voice', req.params.id!);
  res.json({ ok: true });
});
