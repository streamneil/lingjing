# 计划:充值下单流程重构(选套餐 → 下单 → 收银台付款页)

## Context(为什么做)

现状交互割裂(用户实测 + 截图):
1. recharge.html 选套餐时**右侧立刻摊开对公转账信息 + 应付金额 + 状态条**,但订单还没生成 —— 银行账号糊脸,状态条对不存在的订单亮着。
2. 「我已打款」弹窗里**看不到对公转账信息**,要核对账号得回上一页。
3. pricing.html 的「购买」只落 sales_lead(咨询式),与充值是两套流程。

改成标准电商收银台流程。

## 已决定(6 个 AskUserQuestion 定稿)

| # | 决策 | 选择 |
|---|------|------|
| 阶段拆分 | 下单/付款分页 | 选套餐页 → 下单 → 付款页(选方式+对公信息) |
| 付款方式 | 支付宝/微信 | 付款页列三个,支付宝/微信灰禁「敬请期待」,对公可选 |
| 定价页购买 | sales_lead | 走同一套下单流程(废弃 plan 类 sales_lead;企业定制/面议仍联系销售) |
| 订单列表 | 增强 | 发起人 + 付款方式 + 展开看对公转账信息 + 上传付款凭证 |
| 下单时机 | 订单何时生成 | 点「提交订单」即生成 pending_payment(状态机不改) |
| payment_method | 数据层 | recharge_order 加 payment_method 列(默认 offline_bank,为未来预留) |

## 新流程(收银台)

```
recharge.html / pricing.html:只选套餐 → 「提交订单」(无银行信息)
   ↓ POST /orders 生成 pending_payment 订单(payment_method 暂空/待选)
   ↓ 跳 pay.html?order=<id>
pay.html(收银台):
   ├─ 订单摘要(套餐/到账积分/订单号/应付金额)
   ├─ 选付款方式:对公账户(可选)/ 支付宝(敬请期待灰)/ 微信(敬请期待灰)
   │    选对公 → PATCH 订单 payment_method=offline_bank(或下单即默认)
   ├─ 展开对公转账信息(户名/税号/开户行/账号+复制 + 备注订单号提示)
   └─ 「我已完成支付」→ claim-paid(+可选传回单弹窗)→ 跳 orders 高亮
orders.html:列表加 发起人 / 付款方式 / 展开(对公信息+传凭证)
```

状态机**不变**(pending_payment → paid_claimed → credited/rejected),只是把「看对公信息」从
recharge 页挪到 pay 页;下单时机仍是「提交订单即 createOrder」。

## 改动清单

### 数据层(src/db/index.ts)
- recharge_order 加 `payment_method TEXT DEFAULT 'offline_bank'`(addColumnIfMissing 幂等;为未来支付宝/微信预留枚举)。
- RechargeOrderRow 加 payment_method 字段。

### 后端
- src/orders/index.ts:createOrder 写 payment_method(默认 offline_bank);可加 setPaymentMethod(选方式时,若做选择态)。
- src/api/orders.ts:serializeOrder 加 paymentMethod;订单列表/详情返回发起人名(JOIN user)。
  - 新增 GET /orders/:id 已有;pay 页读它显摘要 + 对公信息(payee-info 已有)。

### 前端
- **pay.html(新)**:收银台。读 /orders/:id + /payee-info。选付款方式(对公可选,支付宝/微信灰禁)
  → 展开对公信息 → 「我已完成支付」(claim-paid,复用现有 + 可选传回单弹窗)。移动端底部 sticky 确认条。
- **recharge.html(改)**:删右侧对公信息卡 + 状态条;改成纯选套餐 + 「提交订单」→ createOrder → 跳 pay.html。
- **pricing.html(改)**:plan 类「购买」改为 createOrder → 跳 pay.html(废弃 buyPlan 的 sales_lead);
  企业定制/面议仍走 leadEnterprise(联系销售)。
- **orders.html(改)**:列表行加 发起人(admin 看全机构时有用)+ 付款方式徽章;
  pending_payment/rejected 行加「去支付」(跳 pay.html);对公订单可展开看转账信息 + 上传凭证入口。

## Eng Review 定稿(架构 + 外部声音)

**下单守卫(钱路前置)** —— createOrder 加两道前置守卫:
- **payee 未配拒下单(外部 #7)**:createOrder 先查 getPayee(),户名/账号任一空 → 抛 `PAYEE_NOT_READY`(「平台尚未开通对公收款,请联系运营」)。不生成付不了的孤儿单。
- **复用未付单 + 防双击(外部 #1/#2)**:createOrder 先查同 (tenant_id, created_by, plan_id, status='pending_payment') 已有 → **返现有单**(不新建);前端提交按钮点击即 disable。镜 createLead 60s 去重范式,杀掉孤儿堆积 + 双击重单。
- 面议守卫(现有 PLAN_NOT_PRICED)保留;pricing 前端按 priceYuan 分流(有价→createOrder→pay,面议→leadEnterprise),400 兜底不 strand(外部 #8)。

**pay.html(收银台)**:
- load 即 fetch `/orders/:id`(账号隔离 getOrderForActor,IDOR→404)+ `/payee-info`。
- **按状态分支(架构 #2 + 外部 #6)**:pending_payment/rejected → 显支付 UI;paid_claimed → 「核对中」;credited → 「已到账」+跳订单;cancelled → 「已取消」+跳订单。跨标签/深链/刷新一致。
- **付款方式诚实化(外部 #3)**:不做可选 radio。直接显「付款方式:对公账户转账」(唯一);支付宝/微信「敬请期待」灰显**不可点**。payment_method 建单默认 offline_bank(为未来预留,本轮无 PATCH —— 不假装可选)。
- 对公信息 + 「我已完成支付」(claim-paid,复用 + 可选传回单)。移动端底部 sticky 确认条。

**serializeOrder 补全(外部 #4)**:listOrdersForActor/getOrderForActor 加 LEFT JOIN user 返发起人名(display_name||username);serializeOrder 加 paymentMethod + actorName(admin 看全机构时显谁下的单)。

**plan-lead 只改前端(外部 #5)**:pricing.html 的 buyPlan 从 postLead('plan') 改为 createOrder→pay;**createLead 的 plan 分支、test/sales-leads.test.ts、admin 线索台账全保留**(不破坏现有测试/台账;企业/topup lead 仍走 createLead)。

## 钱路 / 一致性(eng-review 重点)

- 下单仍走现有 createOrder(全快照 + order_no 事务计数 + 面议拒单),不动钱路核心。
- payment_method 仅展示/预留,本轮不影响 grant 逻辑(确认到账仍 confirmAndCredit 原子)。
- pricing 页改 createOrder 后,**面议套餐(price=null)**必须仍拒(createOrder 已守卫);
  pricing 页要区分:可购套餐→下单,面议→联系销售。
- 定价页废弃 plan 类 sales_lead,但 sales_leads 表 + enterprise/topop 线索保留(不删表,避免破坏 admin 线索台账)。

## NOT in scope
- 支付宝/微信真实接入(本轮仅占位灰禁)。
- 付款方式切换后的订单改价(对公只一种,无切换成本)。

## What already exists(复用)
- createOrder / claimPaid / confirmAndCredit / getPayee(orders/index.ts)—— 全复用,不重写钱路。
- /payee-info、/orders、/orders/:id、/orders/:id/claim-paid(api/orders.ts)—— pay 页直接用。
- 收银台线框稿已批:~/.gstack/projects/digital-human/designs/checkout-flow-20260612/pay-wireframe.png
  (注:线框稿的三选一付款 radio 实现时改为「单方式展示 + 支付宝/微信灰禁占位」,外部 #3 诚实化)。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | Codex CLI 损坏(ENOENT)→ Claude subagent 顶替;8 findings(#1/#2/#3/#5/#7 P1/P2 真缺口)全吸收 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 11 issues(2 架构 + 1 DRY + 测试 + 8 外部声音);0 critical gap,0 未决 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | 收银台线框已与用户确认(免完整 design-review) |

- **CODEX:** Codex CLI 二进制损坏(spawn ENOENT),按契约非阻塞回落 Claude subagent 独立二审。
- **CROSS-MODEL:** 无 tension —— 外部声音找的是 review 漏掉的增量缺口(孤儿单/双击/payment_method 假选/plan-lead 破测试/未配 payee),非矛盾。全部经 AskUserQuestion 定夺。
- **VERDICT:** ENG CLEARED(设计已线框确认)。关键加固:createOrder 加 payee守卫+复用未付单(杀孤儿单+双击);pay 页状态分支+付款方式诚实化(不假装可选);serializeOrder 补发起人/付款方式;plan-lead 只改前端不破测试。状态机/钱路不变(现有 17 用例护住)。可开工。

NO UNRESOLVED DECISIONS
