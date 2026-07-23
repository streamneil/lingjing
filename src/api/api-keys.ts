// 灵镜 Open API — key 管理 REST 路由(设计文档 §4.7)。
//
// 供设置页用(cookie session)。注意:这些端点不在 API key 作用域白名单(requireApiScope),
// 故 API key 自身够不到 —— key 不能管理 key(泄漏后也改不了、看不了别的 key)。
//   - POST   /api/api-keys        创建(明文只此一次返回);任意角色可为自己建
//   - GET    /api/api-keys        列表(成员看自己的;admin 看全租户 + owner_name)
//   - DELETE /api/api-keys/:id    吊销(成员吊自己的;admin 吊任意;够不到 → 404)

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../auth/api-keys.js';
import { audit } from '../audit/index.js';

export const apiKeysRouter = Router();

const NAME_MAX = 64;

// 创建 —— 明文 key 仅在此响应出现一次,之后任何接口都拿不到。
apiKeysRouter.post('/api-keys', requireAuth, (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: '请填写密钥名称', code: 'INVALID_INPUT' });
  if (name.length > NAME_MAX) return res.status(400).json({ error: `名称不超过 ${NAME_MAX} 字`, code: 'INVALID_INPUT' });
  const { id, key, prefix } = createApiKey(req.user!.tenantId, req.user!.id, name);
  audit(req, 'create_api_key', id);
  // 明文 key 一次性:提示前端妥善保存,刷新后不可再见。
  return res.status(201).json({ id, key, prefix, name });
});

// 列表 —— 永不返回明文/哈希;admin 看全租户。
apiKeysRouter.get('/api-keys', requireAuth, (req: Request, res: Response) => {
  const isAdmin = req.user!.role === 'admin';
  const keys = listApiKeys(req.user!.tenantId, req.user!.id, isAdmin);
  return res.json({ keys });
});

// 吊销 —— 软删留审计;成员只能吊自己的,admin 可吊本租户任意。够不到 → 404。
apiKeysRouter.delete('/api-keys/:id', requireAuth, (req: Request, res: Response) => {
  const isAdmin = req.user!.role === 'admin';
  const ok = revokeApiKey(req.params.id!, req.user!.tenantId, req.user!.id, isAdmin);
  if (!ok) return res.status(404).json({ error: '密钥不存在或已吊销', code: 'NOT_FOUND' });
  audit(req, 'revoke_api_key', req.params.id!);
  return res.json({ ok: true });
});
