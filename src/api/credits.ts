// 灵镜 API — 积分 + 审计路由。
//
// 余额/消费记录:登录用户可看自己机构的。
// 发放积分:仅 admin(不做自助充值,对应砍掉 H4)。
// 审计日志:仅 admin(政企合规)。

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { balance, ledger, countLedger } from '../credits/index.js';
import { listAudit, countAudit } from '../audit/index.js';

export const creditsRouter = Router();

// 分页参数解析:page≥1,pageSize 1..100(默认 20)。返回 {page, pageSize, offset}。
function parsePage(req: Request, defaultSize = 20): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// 余额(顶栏展示)
creditsRouter.get('/credits/balance', requireAuth, (req: Request, res: Response) => {
  return res.json({ balance: balance(req.user!.tenantId) });
});

// 消费记录(分页:page/pageSize → {rows, total, page, pageSize})。
creditsRouter.get('/credits/ledger', requireAuth, (req: Request, res: Response) => {
  const { page, pageSize, offset } = parsePage(req);
  const isAdmin = req.user!.role === 'admin';
  const rows = ledger(req.user!.tenantId, pageSize, req.user!.id, isAdmin, offset);
  const total = countLedger(req.user!.tenantId, req.user!.id, isAdmin);
  return res.json({ rows, total, page, pageSize });
});

// 消费记录 CSV 导出(验收 H3:可导出)
creditsRouter.get('/credits/ledger.csv', requireAuth, (req: Request, res: Response) => {
  const rows = ledger(req.user!.tenantId, 10000, req.user!.id, req.user!.role === 'admin');
  const KIND_CN: Record<string, string> = { grant: '发放', reserve: '预扣', settle: '结算', release: '释放' };
  // 工具类型 → 中文场景名(与前端 billing.html TOOL_CN 同口径)
  const TOOL_CN: Record<string, string> = {
    video: '数字人视频', video_t2v: '文字转影片', video_i2v: '图片转影片', video_edit: '影片编辑',
    ai_image: 'AI 图片', tts: '文字转语音', ai_music: 'AI 音乐',
  };
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const header = '时间,类型,消费人,工具,金额,作品,说明';
  // 「作品」列:优先文案摘要 → 回退工具中文名 → grant/无关联行空(与页面同口径)。
  const workOf = (r: (typeof rows)[number]): string =>
    r.taskTitle ?? (r.toolType ? (TOOL_CN[r.toolType] ?? r.toolType) : '');
  const lines = rows.map((r) =>
    [
      esc(new Date(r.created_at).toISOString()),
      esc(KIND_CN[r.kind] ?? r.kind),
      esc(r.userName ?? '—'),
      esc(r.toolType ? (TOOL_CN[r.toolType] ?? r.toolType) : '—'),
      r.amount,
      esc(workOf(r)),
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

// 充值已收归平台超管(POST /admin/api/tenants/:id/grant)。
// 租户自助充值是 SaaS 收入漏洞(租户 admin 给自己无限充值),已删除(/plan-ceo-review D3)。
// 余额/消费记录查询保留(租户可看自己),充值入口只在 /admin。

// 审计日志只读(分页:page/pageSize → {rows, total, page, pageSize})。
creditsRouter.get('/audit', requireAuth, (req: Request, res: Response) => {
  const { page, pageSize, offset } = parsePage(req);
  const isAdmin = req.user!.role === 'admin';
  const rows = listAudit(req.user!.tenantId, pageSize, req.user!.id, isAdmin, offset);
  const total = countAudit(req.user!.tenantId, req.user!.id, isAdmin);
  return res.json({ rows, total, page, pageSize });
});
