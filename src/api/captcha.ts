// 灵镜 API — 滑块行为验证(防暴破)。
//
// 决策来源:/plan-ceo-review D8/D9 —— 仅滑块,无 IP 锁定。服务端出题 + 位置比对
// 发一次性 token,登录必携。真挡的是不渲染滑块、直接 POST /login 的无头脚本。
//
// 公开接口(登录前用),租户登录与超管登录共用同一套 captcha。

import { Router, type Request, type Response } from 'express';
import { createCaptchaChallenge, verifyCaptchaSlide } from '../auth/platform.js';

export const captchaRouter = Router();

// 出题:返回 challenge_id + 缺口位置 + 轨宽,供前端渲染滑块拼图。
captchaRouter.get('/captcha/challenge', (_req: Request, res: Response) => {
  return res.json(createCaptchaChallenge());
});

// 校验滑块落点:位置在容差内 → 发一次性 captcha_token;失败/过期 → 400。
captchaRouter.post('/captcha/verify', (req: Request, res: Response) => {
  const { challengeId, x } = req.body ?? {};
  if (!challengeId || typeof x !== 'number') {
    return res.status(400).json({ error: '缺少 challengeId / x' });
  }
  const token = verifyCaptchaSlide(challengeId, x);
  if (!token) return res.status(400).json({ ok: false, error: '验证未通过,请重试' });
  return res.json({ ok: true, captchaToken: token });
});
