// 灵镜 API — 法务/合规路由。
//
// GET /api/legal/version —— 前端在创建数字人/克隆音色前读当前条款版本一起提交,
// 但留痕以后端常量为准(见 src/legal/index.ts)。公开端点:登录前也能读版本(无敏感数据)。

import { Router, type Request, type Response } from 'express';
import { currentLegalVersion } from '../legal/index.js';

export const legalRouter = Router();

legalRouter.get('/legal/version', (_req: Request, res: Response) => {
  return res.json(currentLegalVersion());
});
