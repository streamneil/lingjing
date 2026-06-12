# 计划:发票管理重构(累计开票 + 抬头自动维护 + admin 专属 + 独立页 + 菜单重组)

## Context(为什么做)

用户反馈(截图 + 文字):
1. 订单列表「去开票」看不出该单是否已开过票。
2. 要支持**累计开票**:勾选多个未开票的已到账订单,合并开一张票;admin 后台开票前要确认订单 + 审查入账。
3. 开票是严肃的事 → 独立界面;租户首次填开票抬头后自动维护到租户资料,**仅 admin 可编辑**;**仅 admin 可开票**。
4. 左侧菜单:充值订单/发票管理缺 logo;用量计费/充值订单/发票管理是否单独归类。

现状:invoice 表是**一订单一票**(order_id 直接在 invoice 行);creator 可申请开票;开票表单在 invoices.html 内弹出。

## 已决定(7 个 AskUserQuestion 定稿)

| # | 决策 | 选择 |
|---|------|------|
| 数据模型 | 一票多单 | invoice 去 order_id + 新建 invoice_order 关联表(规范);金额=所含订单之和 |
| 订单状态 | 开票状态显示 | 订单显开票状态徽章(未开票/开票中/已开票),已开/开票中不再显去开票 |
| Admin 校验 | 开票前 | 后端确保所含订单都 credited + 金额之和=发票金额,任一不符拒开 |
| 抬头资料 | 存哪/谁改 | 新建 tenant_invoice_profile 表(单例/租户);首次填自动存;仅 admin 编辑 |
| 开票权限 | 谁能开 | 仅 admin 发起开票申请(creator 不能);creator 只能查看/下载本机构发票 |
| 独立界面 | 形态 | 独立开票页 invoice-new.html(选订单 + 抬头资料 + 确认) |
| 菜单分类 | 财务归类 | 新起「财务中心」分组(用量计费/充值订单/发票管理)+ 充值订单/发票加 logo |

## 数据模型(钉死)

```
-- 改:invoice 去掉「一票一单」,改一票多单
invoice:
  id, tenant_id, created_by(发起的 admin), title, tax_no, kind('普票'),
  amount_yuan(= 所含订单金额之和,申请时快照),
  status(requested|issued), invoice_no, pdf_key, admin_note, created_at, issued_at
  -- order_id 列保留(NULLABLE)仅供老数据迁移读,新行不写;新代码一律走 invoice_order
invoice_order(新关联表):
  invoice_id, order_id  -- 一票多单;UNIQUE(order_id) 保证一单只进一张在途/已开发票
  PRIMARY KEY (invoice_id, order_id)
tenant_invoice_profile(新,抬头资料,单例/租户):
  tenant_id(PK), title(抬头), tax_no(税号), bank_name, bank_account, address, phone, updated_at, updated_by
  -- 首次开票填写自动 upsert;仅 admin 可编辑(creator 只读)
```

迁移(db/index.ts,幂等):
- addColumnIfMissing 保证 invoice.order_id 仍在(老行有值);新建 invoice_order + tenant_invoice_profile 表。
- **回填**:对每行 invoice.order_id IS NOT NULL → INSERT OR IGNORE invoice_order(invoice.id, invoice.order_id)。
  老的单订单发票自动变成「一票一单」的关联行,新旧统一读 invoice_order。

## 状态机(发票,不变核心)

```
订单开票视角(派生,非订单表列):
  credited 订单 → 查 invoice_order:无 → 未开票(可勾选合开)
                               有且 invoice.status=requested → 开票中(不可再选)
                               有且 invoice.status=issued → 已开票
发票:
  (admin 选 N 个未开票 credited 订单 + 抬头)→ requested(金额=Σ订单)
  requested ── 超管确认(校验所含订单都 credited + Σ金额=发票金额)+ 回填号/PDF ──▶ issued
  requested ── 超管驳回 ──▶ 删发票 + 删 invoice_order 关联(订单回到「未开票」可重选)
```

## Eng Review + 外部声音定稿(11 findings 全吸收)

**迁移用表重建(外部 #4/#3)** —— invoice.order_id 是 NOT NULL,SQLite 改不了约束 → **表重建**:
```
建 invoice_new(无 order_id 列)→ 拷老数据 + 同时回填 invoice_order(老 invoice.order_id → 关联行)
→ drop 老 invoice → rename invoice_new → invoice。
```
新表**根本没 order_id 列** → 彻底消除 split-brain(所有读路径被迫走 invoice_order,无死列可读)。

**权限模型理顺(外部 #1/#2)**:
- **租户 admin 发起**:requestInvoice **去掉 created_by===userId 检查**,只校 tenant_id + 每单 credited + 未占用
  (admin 可批本租户任意人的单)。API 路由 requireRole('admin')(creator 不能发起,外部 #11)。
- **平台超管开具**:issueInvoice(invoiceId, no, pdf) **自己重加载 invoice_order + 订单**,调
  validateInvoiceOrders(invoiceId) 重校(所含订单仍全 credited + Σ金额=发票金额);不依赖外传订单(外部 #1)。

**读路径全改走 invoice_order(外部 #3)**:listInvoicesForActor/getInvoiceForActor/serializeInvoice/admin
工作台 都 JOIN invoice_order 聚合 orderIds[](不再读标量 order_id —— 新表没这列)。

**单一 validateInvoiceOrders 助手(代码质量 DRY)**:keyed by invoiceId,内部查 invoice_order + 订单:
① 每单存在 + 属本租户 + credited ② Σ订单金额 = 发票金额 ③ **orders.length>0**(拒空选,外部 #7)。
requestInvoice(申请时,传 orderIds 先组装) + issueInvoice(开具时,查已存关联)都调它。

**并发防重(外部 #6)**:requestInvoice 在事务内**先 pre-validate 每单未占用**(查 invoice_order),
再插 invoice + N 条 invoice_order;UNIQUE(order_id) 做并发后来者 backstop → 捕获 SQLITE_CONSTRAINT
映射 OrderError('INVOICE_EXISTS') 409(不漏成 500)。

**驳回释放(架构 #1)**:rejectInvoice 事务内删 invoice 行 + 删该发票所有 invoice_order → 订单 invoiceStatus 回 NULL 可重选。

**订单开票状态派生(架构 #2 / 外部 #10)**:listOrdersForActor LEFT JOIN invoice_order io ON io.order_id=o.id
LEFT JOIN invoice iv ON iv.id=io.invoice_id,派生 invoiceStatus(NULL=未开/requested=开票中/issued=已开)。
**JOIN 走 invoice_order,不是死列 order_id**。

**菜单 crumb(外部 #9)**:billing/orders/invoices/pay 页 data-crumb 从「经营管理 > X」改「财务中心 > X」。

**creator 发票页只读(外部 #11)**:invoices.html 对 creator 去掉开票表单/「去开票」CTA,只剩列表 + 下载;
独立开票页 invoice-new.html 仅 admin 可达。

**迁移行 created_by 容忍(外部 #8)**:老发票 created_by 可能是 creator(wheditor1);新模型不依赖
created_by 的角色做逻辑(仅展示),迁移行不破坏。

## 钱路 / 校验(eng-review 重点)

- **开票申请原子**:db.transaction 内:① 校验每个 order credited + 属本租户 + 未被其他在途/已开发票占用(invoice_order UNIQUE(order_id))② Σ订单金额 = 发票金额 ③ 插 invoice + N 条 invoice_order。任一不符整体回滚。
- **超管开票校验(用户「确认订单+审查入账」)**:issueInvoice 再次校验所含订单仍全 credited + Σ金额=发票金额(防申请后订单状态变化);不符拒开。
- **权限收紧**:requestInvoice 路由 requireRole('admin');profile 编辑 requireRole('admin')。creator 仅 GET 列表/下载。
- **账号隔离**:发票/订单查询沿用 scopeByActor —— 但发票现在是租户级(admin 发起),creator 看本机构所有发票(只读)。

## 左侧菜单重组

shell.js:把「用量计费/充值订单/发票管理」从「经营管理」拆出,新起「财务中心」分组。
顺序:财务中心(用量计费/充值订单/发票管理)→ 经营管理(成员/设置)。
图标:充值订单(钱包/卡片 SVG)、发票管理(单据 SVG)—— 描边风格,与现有 nav 图标一致。

## NOT in scope
- 发票红冲/作废(本轮只开具)。
- 专票字段(本轮普票;profile 预留 bank/address/phone 但开票走普票)。
- 跨租户合并开票(只同租户内合开)。

## What already exists(复用)
- invoice 表 + requestInvoice/issueInvoice/rejectInvoice(orders/index.ts)—— 改为一票多单。
- getOrderForActor / scopeByActor —— 复用。
- admin 发票开具工作台(admin.html)—— 改为列发票(含所含订单)+ 校验开票。
- shell.js link() nav 范式 + 现有 SVG 图标风格。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Codex CLI 损坏(ENOENT)→ Claude subagent;11 findings(#1-#4 P1 真缺口)全吸收 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 14 issues(2 架构 + 1 DRY + 测试 + 11 外部声音);0 critical gap,0 未决 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 独立开票页 + 菜单分组(实现后可跑 design-review) |

- **CODEX:** Codex CLI 二进制损坏(ENOENT),非阻塞回落 Claude subagent 独立二审。
- **CROSS-MODEL:** 无 tension —— 外部声音找的是 review 漏掉的增量缺口(split-brain 读路径、平台超管 vs 租户admin 权限混淆、order_id NOT NULL 迁移、现有 creator 测试要改),非矛盾。全部经 AskUserQuestion 定夺。
- **VERDICT:** ENG CLEARED。关键加固:**表重建**(无 order_id 列,彻底灭 split-brain);权限理顺(租户 admin 发起去 created_by 检查 / 平台超管开具自查重校);单一 validateInvoiceOrders(申请+开具双校 credited+Σ金额,拒空选);UNIQUE 防重开映射 409;驳回释放订单;读路径全走 invoice_order;creator 发票页只读 + 菜单 crumb 改财务中心。可开工。

NO UNRESOLVED DECISIONS
