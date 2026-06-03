// 灵镜 API — 积分 + 审计路由。
//
// 余额/消费记录:登录用户可看自己机构的。
// 发放积分:仅 admin(不做自助充值,对应砍掉 H4)。
// 审计日志:仅 admin(政企合规)。

import { Router, type Request, type Response } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { balance, ledger, grant } from '../credits/index.js';
import { listAudit, audit } from '../audit/index.js';

export const creditsRouter = Router();

// 余额(顶栏展示)
creditsRouter.get('/credits/balance', requireAuth, (req: Request, res: Response) => {
  return res.json({ balance: balance(req.user!.tenantId) });
});

// 消费记录(可查询,验收 H3)
creditsRouter.get('/credits/ledger', requireAuth, (req: Request, res: Response) => {
  return res.json(ledger(req.user!.tenantId));
});

// 消费记录 CSV 导出(验收 H3:可导出)
creditsRouter.get('/credits/ledger.csv', requireAuth, (req: Request, res: Response) => {
  const rows = ledger(req.user!.tenantId, 10000);
  const KIND_CN: Record<string, string> = { grant: '发放', reserve: '预扣', settle: '结算', release: '释放' };
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const header = '时间,类型,金额,关联任务,说明';
  const lines = rows.map((r) =>
    [
      esc(new Date(r.created_at).toISOString()),
      esc(KIND_CN[r.kind] ?? r.kind),
      r.amount,
      esc(r.job_id ?? ''),
      esc(r.note ?? ''),
    ].join(','),
  );
  // BOM 让 Excel 正确识别 UTF-8 中文
  const csv = '﻿' + [header, ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="lingjing-ledger.csv"');
  return res.send(csv);
});

// 用量预警:余额是否低于阈值(H5,避免突然不可用)
creditsRouter.get('/credits/warning', requireAuth, (req: Request, res: Response) => {
  const bal = balance(req.user!.tenantId);
  const LOW = 100; // 低余额阈值(占位,可配置)
  return res.json({ balance: bal, low: bal < LOW, threshold: LOW });
});

// 后台发放(仅 admin)
creditsRouter.post('/credits/grant', requireRole('admin'), (req: Request, res: Response) => {
  const { amount, note } = req.body ?? {};
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount 必须为正数' });
  }
  grant(req.user!.tenantId, amount, note);
  audit(req, 'grant_credit', `+${amount}`);
  return res.json({ ok: true, balance: balance(req.user!.tenantId) });
});

// 审计日志(仅 admin)
creditsRouter.get('/audit', requireRole('admin'), (req: Request, res: Response) => {
  return res.json(listAudit(req.user!.tenantId));
});
