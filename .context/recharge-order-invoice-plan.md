# 计划:对公充值闭环(订单 + 线下打款 + 超管确认到账 + 发票管理)

## Context(为什么做)

`work/agent2` 建的 pricing 模块是**纯展示 + 意向线索**(`sales_leads` 表,点「购买」只落一条
lead,运营线下联系后手动 `grant()`)。没有订单、没有充值页、没有打款回执、没有发票。
用户要**真闭环**:用户充值 → 生成订单 → 线下对公打款 → 「我已打款」(可选传回单)→
超管核对到账 → 确认 → 积分自动入账 → 用户从订单去开票 → 超管回填发票 → 用户下载。

分类:**APP UI**(后台工作流,任务驱动,非营销页)。沿用现有深色设计系统(app.css tokens)。

## 已决定(8 个 AskUserQuestion 定稿)

| # | 决策 | 选择 |
|---|------|------|
| 充值界面 | 形态 | **独立全页 recharge.html**(新页面) |
| 到账口径 | 赠送折算 | 确认即 `grant(credits + bonusCredits)` 全额一次入账 |
| 打款回单 | 上传 | 这轮就做,「我已打款」弹窗**可选**上传银行回单截图(复用 storage) |
| 发票 | 范围 | 完整闭环:用户申请 + 台账 + 超管后台回填发票号/PDF + 用户下载 |
| 1 信息架构 | 打款后去向 | 跳 orders.html 台账页,**高亮本单** |
| 2 状态 | 驳回态 | 订单转**红态「已驳回」**+ 超管备注 + 用户重提按钮 |
| 2 状态 | 台账空态 | **暖场文案 +「去充值」主按钮** |
| 3 旅程 | 到账告知 | 仅订单台账**静默转绿态**(本轮不做主动通知,记 TODO) |
| 5 设计系统 | 状态组件 | **色调 pill badge 复用 token**(台账用徽章;stepper 仅充值页右栏顶) |
| 6 响应式 | 充值页移动端 | 套餐在上,对公卡**应付金额+「我已打款」变底部 sticky 条** |
| 7 钱路 | 自定义金额 | **取消自定义金额**,只能选超管后台配的套餐(无汇率,只有套餐快照) |

## 状态机(钉死,防漂移)

```
订单 order.status:
  pending_payment(待打款)  ──「我已完成打款」(+可选回单) ──▶ paid_claimed(待确认)
  paid_claimed(待确认)     ── 超管「确认到账」 ──▶ credited(已到账,grant 触发)
  paid_claimed             ── 超管「驳回」(金额不符/未到账)──▶ rejected(已驳回,带备注)
  rejected                 ── 用户「重新提交打款」 ──▶ paid_claimed
  pending_payment/rejected ── 用户「取消订单」 ──▶ cancelled

发票 invoice.status(仅 credited 订单可申请):
  none ──「去开票」填抬头/税号 ──▶ requested(待开票)
  requested ── 超管回填发票号 + 上传 PDF ──▶ issued(已开票,用户可下载)
  requested ── 超管驳回(信息有误)──▶ none(退回 + 备注)
```

**钱路安全(money-path)**:
- `grant` 只在 paid_claimed→credited 触发**一次**(用 status 守卫 + 行级条件 UPDATE;credited 后重复点无效)。
- grant 写 ledger note 带订单号(可追溯)。
- 金额/积分以**下单时套餐快照**为准(套餐改价不影响已下单,照 sales_leads 快照范式)。
- 账号隔离:复用上轮 `scopeByActor` —— 用户只看自己 created_by 的订单/发票,超管看全机构。

## Eng Review 定稿(架构 + 代码质量 + 测试 + 外部声音)

**钱路并发(Issue 1 / 外部 #3)** —— 确认到账复用 `claimNextJob`(queue/index.ts:41)原子范式:
```ts
// src/orders/index.ts — confirmAndCredit
db.transaction(() => {
  const r = db.prepare(
    `UPDATE recharge_order SET status='credited', confirmed_by=?, confirmed_at=?, updated_at=?
     WHERE id=? AND tenant_id=? AND status='paid_claimed'`).run(adminId, t, t, id, tenantId);
  if (r.changes !== 1) return false;           // 已被处理/取消 → 不发(双击/双超管并发后来者 changes=0)
  grant(tenantId, credits + bonus, `充值到账 #${orderNo}`, id);  // 同事务,带 order_id
  return true;
});
```
- **单一 transition 助手(Issue 4)**:`transitionOrder(id,tenantId,from,to,patch?)` / `transitionInvoice` 服务层原子迁移(WHERE status=from,返 changes===1),所有状态变走这一门,API 只调用。镜 `validatePlan` 单一来源。
- **套餐全快照(Issue 2)**:下单把 name/price_yuan/credits/bonus_credits **+ validity_months**(外部 #6)全拷进 order 行;grant 只读快照,与 pricing_plan 改/删无关。
- **建单守卫(外部 #5)**:`createOrder` 校验 plan 存在 + enabled=1 + **price_yuan 非 NULL**,否则拒(面议套餐请联系商务),镜 createLead PLAN_NOT_FOUND。
- **order_no 生成(外部 #1)**:`order_no TEXT UNIQUE`;建单事务内 `seq = 1 + COUNT(WHERE order_no LIKE 'LJ{今日}-%')`,格式 `LJ{yyyymmdd}-{seq4}`,UNIQUE 做后盾。
- **取消/确认竞态(外部 #3)**:状态 ≥ paid_claimed UI 隐藏取消按钮;取消也走 transitionOrder(WHERE status IN pending/rejected),与确认互斥,后来者 changes=0。
- **ledger 幂等审计(外部 #8)**:`credit_ledger` 加 `order_id TEXT` 列,grant 写入;部分唯一索引 `(order_id) WHERE kind='grant'` —— 即使守卫漏了,唯一索引也拦第二次。
- **下载 IDOR(Issue 3 / 外部 #4)**:回单截图 + 发票 PDF 下载端点先过 `scopeByActor` 取 order/invoice 行(取不到→404)再 `getSignedUrl`;复用 jobs-download 范式。
- **回单上传校验(外部 #4)**:服务端强制 ≤5MB + MIME 白名单(image/png,jpeg);签名 URL 短 TTL,仅本人/超管可取。
- **余额刷新(外部 #7)**:orders 页加载 + focus 时重拉 balance 更新顶部余额条(兑现「余额已涨」)。
- **对公收款信息**:存平台配置(超管后台表单,镜 image_model_override 动态配置),**不硬编码进代码/不进 git**;recharge 页读 API 渲染。真实银行账号属敏感数据,运行时配置。
- **发票仅普票(外部 #9)**:本轮 kind 限普票(抬头+税号);专票需开户行/账号/地址/电话,留下轮。
- **到账后追回(外部 #2)**:credited 保持终态,**本轮不做 revoke**;退款场景超管手工改库,写进下方 runbook + NOT in scope。
- **索引**:超管待核对列表 `WHERE status='paid_claimed'` 加 status 索引;台账复用 (tenant_id, created_by) 复合索引。

### 已知缺口 runbook(到账后对公打款被退回)
credited 终态无系统级 revoke。若银行退回:① 超管在 DB 把 `recharge_order.status` 改 `revoked`;
② 手工 `INSERT credit_ledger (kind='grant', amount=-X, order_id, note='打款退回追回')` 抵扣(余额可负);
③ 记审计。本轮不做 UI,下轮补 revokeOrder 闭环。

## 信息架构(IA)

```
用户侧流:
  recharge.html(选套餐 → 生成订单 → 我已打款)
    └─▶ orders.html(台账:高亮新单,状态徽章,去打款/去开票/取消/重提)
          └─▶ invoices.html(发票台账:订单/抬头/发票号/下载 PDF)
  顶部余额条「充值」链接 → 改指 recharge.html(原 billing.html)

超管侧(admin.html 内新增两工作台区):
  对公收款核对:列 paid_claimed 订单 → 看回单截图 → 确认到账 / 驳回(备注)
  发票开具:列 requested 发票 → 回填发票号 + 上传 PDF → 已开票 / 驳回
```

## 左侧菜单改动

「经营管理」组(shell.js:57-60)下,在「用量计费」后加两项:
- **充值订单**(orders.html)
- **发票管理**(invoices.html)

顺序:用量计费 → 充值订单 → 发票管理 → 成员与权限 → 系统设置。

## 交互状态表(Pass 2 定稿)

| 界面 | LOADING | EMPTY | ERROR | SUCCESS | 驳回/REJECTED |
|------|---------|-------|-------|---------|--------------|
| recharge 套餐区 | 「加载中…」骨架 | 「暂无可购套餐,请联系运营开通」 | 「套餐加载失败,刷新重试」 | 选中态蓝边 | — |
| recharge 生成订单 | 按钮 spinner | — | toast「下单失败」+ 不跳转 | 跳 orders 高亮本单 | — |
| 我已打款弹窗 | 上传中进度条 | — | 「截图过大/格式错」 | toast「已提交,等待核对」 | — |
| orders 台账 | 行骨架 | **暖场:「还没有充值记录 · 去充值→」主按钮** | 「加载失败,刷新」 | 行状态徽章 | 红徽章「已驳回」+ 备注 + 重提按钮 |
| invoices 台账 | 行骨架 | **「还没有发票 · 已到账订单可去开票」** | 「加载失败」 | 「已开票」+ 下载 PDF | 退回 none + 超管备注 |
| 超管收款核对 | 行骨架 | 「暂无待核对打款」 | — | 确认后行消失/转已到账 | 驳回填备注弹窗 |

## 用户旅程(Pass 3)

| 步骤 | 用户做 | 用户感受 | 计划支撑 |
|------|--------|----------|----------|
| 1 | 进 recharge 选套餐 | 「这价格/积分清楚」 | 套餐快照,赠送绿字,无汇率心算 |
| 2 | 看对公账号,去网银转账 | 「别转错户」 | 户名/账号等宽+复制,提示备注订单号 |
| 3 | 点「我已打款」(可选传回单) | 「我尽到责任了」 | 状态条转②待确认,toast 安抚 |
| 4 | **等超管核对(可能 1 天)** | **焦虑:「钱到了吗」** | ⚠ 已知缺口:本轮无主动通知,靠台账查(记 TODO) |
| 5 | 进 orders 看到绿态「已到账」 | 「到账了,放心」 | 余额已涨,订单绿徽章,可去开票 |

时间视域:5 秒(对公信息一眼清)/ 5 分(打款→提交闭环顺)/ 5 年(每次充值有台账+发票可查,合规)。

## 数据模型(新增表,eng-review 时细化)

```
recharge_order: id, tenant_id, created_by, plan_id(快照来源),
  plan_name, price_yuan, credits, bonus_credits, validity_months,  -- 下单时全快照(外部#6)
  status, order_no TEXT UNIQUE(LJyyyymmdd-seq,事务内日计数,外部#1),
  receipt_key(回单截图 key,可空), admin_note(驳回原因),
  confirmed_by(超管 id), confirmed_at, created_at, updated_at
invoice: id, order_id, tenant_id, created_by,
  title(抬头), tax_no(税号), kind('普票'本轮仅此), amount_yuan(申请时快照,外部#9),
  status, invoice_no(超管回填), pdf_key(超管上传), admin_note, created_at, issued_at
credit_ledger: + order_id TEXT(grant 写入,外部#8);部分唯一索引 (order_id) WHERE kind='grant'
platform_setting(对公收款): payee_name, tax_no, bank_name, bank_account(超管后台配,不进 git)
```

## 可访问性(Pass 6)

- 复制按钮 `aria-label="复制银行账号"`;上传区 `<button>` 可键盘聚焦 + Enter 触发文件选择。
- 状态徽章**文字+色双编码**(色盲可读:「已驳回」红字本身可读,不只靠红色)。
- 触控目标 ≥44px;sticky 底部条不遮挡最后一行内容(留 padding-bottom)。
- 对比度:徽章文字 ≥4.5:1(--green/--blue 在深底达标)。

## NOT in scope(显式延后)

- **在线支付**(微信/支付宝/网银直连):本轮纯线下对公,无支付网关。
- **到账主动通知**(站内信/短信/邮件):本轮靠台账静默转绿(Pass 3 用户选),记 TODO。
- **自定义充值金额**:取消,只走套餐(Pass 7 用户选),无 ¥→积分汇率。
- **发票红冲/作废**:本轮只做开具,冲红留后续。
- **多币种/外币**:仅人民币对公。
- **到账后追回(revoke 闭环)**:credited 终态,退款走手工 runbook(外部 #2),下轮补 revokeOrder UI。
- **增值税专票**:本轮仅普票;专票字段(开户行/账号/地址/电话)留下轮(外部 #9)。

## What already exists(复用)

- **设计系统**:app.css tokens(--card/--line/--blue/--green/999px pill/44px 按钮),pricing.html 卡片样式可抄。
- **套餐 CRUD**:`pricing_plan` 表 + `src/pricing/index.ts`(createPlan/listPlans/reorderPlans)—— 充值套餐直接复用,超管后台已能配名称/价格/积分/赠送。
- **发积分**:`grant(tenantId, amount, note)`(src/credits/index.ts:202)—— 确认到账调它。
- **账号隔离**:`scopeByActor`(上轮 feat/account-data-isolation)—— 订单/发票按 created_by 隔离。
- **存储**:storage 模块(putObject/getSignedUrl)—— 回单截图 + 发票 PDF 复用。
- **超管控制台**:admin.html —— 收款核对/发票开具加两个工作台区,不另起页。
- **shell.js 左导航**:link('key','名','x.html') 范式 —— 加两项即可。

## Approved Mockups

| 界面 | 路径 | 方向 | 备注 |
|------|------|------|------|
| 对公充值页 | ~/.gstack/projects/digital-human/designs/recharge-loop-20260612/recharge-wireframe.png(v2) | 左套餐选择 + 右 sticky 对公转账卡(状态条/复制/可选回单上传) | 已删自定义金额;移动端套餐在上+底部 sticky 操作条 |

## Implementation Tasks
Synthesized from this review's findings. Each任务 derives from a specific finding above.

- [ ] **T1 (P1, human: ~1d / CC: ~40min)** — db + 后端 — 建 recharge_order/invoice 表 + 状态机服务
  - Surfaced by: 状态机 / 数据模型 — 全闭环靠这两张表 + grant 守卫
  - Files: src/db/index.ts, src/orders/index.ts(新), src/credits/index.ts(grant 复用)
  - Verify: 单测覆盖 paid_claimed→credited 只 grant 一次 + 驳回回退 + 账号隔离
- [ ] **T2 (P1, human: ~4h / CC: ~25min)** — recharge.html — 充值全页(套餐选择 + 对公卡 + 我已打款)
  - Surfaced by: Pass1/Pass6 + approved mockup — 套餐-only,移动端底部 sticky 条
  - Files: prototype/recharge.html(新), prototype/app.css(badge/stepper 样式)
  - Verify: 浏览器选套餐→生成订单→跳 orders 高亮;375px 底部条可见
- [ ] **T3 (P1, human: ~3h / CC: ~20min)** — orders.html — 充值订单台账(徽章/空态/驳回重提/去开票)
  - Surfaced by: Pass2 状态表 — 暖场空态 + 红驳回态 + 状态徽章
  - Files: prototype/orders.html(新)
  - Verify: 空态显「去充值」;驳回单显红徽章+备注+重提
- [ ] **T4 (P1, human: ~3h / CC: ~20min)** — invoices.html + 发票服务 — 发票申请/台账/下载
  - Surfaced by: 发票闭环决策 — 用户申请填抬头/税号 + 下载 PDF
  - Files: prototype/invoices.html(新), src/orders/index.ts(invoice 部分)
  - Verify: credited 订单可去开票;issued 后可下载 PDF
- [ ] **T5 (P1, human: ~3h / CC: ~20min)** — admin.html — 超管收款核对 + 发票开具工作台
  - Surfaced by: IA 超管侧 — 看回单确认/驳回 + 回填发票号/传 PDF
  - Files: prototype/admin/admin.html, src/api/admin.ts
  - Verify: 确认→订单转绿+积分到账;回填→发票转已开票
- [ ] **T6 (P2, human: ~20min / CC: ~5min)** — shell.js — 左导航加「充值订单/发票管理」+ 充值链接改指向
  - Surfaced by: 左侧菜单改动 — 经营管理组加两项,余额条「充值」→recharge.html
  - Files: prototype/shell.js
  - Verify: 导航出现两项且高亮正确;点充值进 recharge

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Codex CLI 损坏(ENOENT)→ Claude subagent 顶替;9 findings,4 个 P1/P2 真缺口被吸收 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 9 issues(3 架构 + 1 DRY + 测试全GAP + 外部声音);0 critical gap,0 未决 |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 3/10 → 9/10, 11 decisions |

- **CODEX:** Codex CLI 二进制损坏(spawn ENOENT),按契约非阻塞回落 Claude subagent 独立二审,findings 全部吸收。
- **CROSS-MODEL:** 无 tension —— 外部声音找的是 review 漏掉的增量缺口(order_no 撞号、到账后追回、取消/确认竞态、面议套餐、ledger 审计列),非矛盾。全部经 AskUserQuestion 定夺。
- **VERDICT:** ENG + DESIGN CLEARED —— 钱路加固定稿:grant 原子条件UPDATE+同事务(复用 claimNextJob)、套餐全快照、order_no 事务内计数+UNIQUE、面议套餐拒单、取消/确认竞态守卫、ledger 加 order_id 幂等索引、下载过 scopeByActor、对公信息不进 git。到账后追回本轮不做(手工 runbook,已记 NOT in scope)。可开工。

NO UNRESOLVED DECISIONS
