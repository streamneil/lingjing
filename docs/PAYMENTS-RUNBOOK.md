# 在线支付运维 Runbook(微信支付 / 支付宝)

设计文档:`docs/designs/online-payments.md`。日志前缀:`[支付]`(回调 `[支付][回调]`、差异 `[支付][对账差异]`)。
查看日志:`docker compose logs app --since 2h | grep '支付'`。

## 0. 通道配置字段速查(/admin → 在线支付)

- **微信**(APIv3,v1 仅「微信支付公钥」模式):`appid` / `mchid`(商户号)/ `merchantSerial`(商户证书序列号)/
  `publicKeyId` + `publicKeyPem`(微信支付公钥);密钥:`apiV3Key`、商户私钥 `privateKeyPem`。五项非密字段缺一即降级占位。
- **支付宝**(RSA2 普通公钥模式):`appId` / `alipayPublicKeyPem`(支付宝公钥)/ 可选 `gateway`
  (默认 `https://openapi.alipay.com/gateway.do`,沙箱联调时改);密钥:应用私钥 `privateKeyPem`。
- 密钥经 MASTER_KEY 加密落库,保存后不回显;通道级前提:`.env` 已配 `PUBLIC_BASE_URL`。

## 1. 回调验签持续失败(`[支付][回调] wechat 验签失败`)

- **最常见**:商户号在「平台证书」模式,微信用证书序列号签回调,与配置的公钥 ID(`PUB_KEY_ID_…`)不符。
  → 商户平台 → 账户中心 → API 安全 → 启用「微信支付公钥」,核对公钥 ID 与 PEM(v1 仅支持公钥模式,决策14)。
- 回调解密失败 → APIv3 密钥不对:商户平台重置后在 `/admin → 在线支付` 重新保存。
- 支付宝验签失败 → 开放平台「支付宝公钥」(普通公钥模式)贴错,或 app_id 不符。
- **兜底**:验签失败不丢钱——服务端每 60s 对在途码主动查单入账(`pollActivePendingAttempts`),
  前端每 ~9s 穿插主动查单。回调只是把到账从秒级提前到毫秒级。

## 2. 完全收不到回调(日志无任何 `[支付][回调]`)

- 安全组/WAF 对微信/支付宝来源封了 443 POST。验证:外网 `curl -X POST https://<域名>/api/payments/notify/wechat -d '{}'`
  应返回 401/503(而非超时)。
- `PUBLIC_BASE_URL` 配错(下单时传给通道的 notify_url 就是错的)。改 `.env` 后重启。

## 3. 对账差异面板出现记录(admin → 在线支付 → 对账差异)

| kind | 含义 | 处置 |
|---|---|---|
| `missing_local` | 通道收了钱,本地无此单号 | 核实通道商户后台流水 → 人工补账或联系买家原路退回 |
| `status_mismatch`(paid_on_cancelled 等) | 已取消/已入账订单收到收款(迟到支付/双重支付) | 面板「原路退回」按钮(attempt 级退款,不动 ledger,决策11) |
| `amount_mismatch` | 回调/账单金额 ≠ 订单快照 | 拒绝入账是护栏在工作;核实后人工处理并「标记已处理」 |
| `status_mismatch`(channel_refunded_local_not_clawed_back / channel_refunded_not_credited) | 通道侧(手工)退款,本地未同步 | 钱已回买家,**别点「原路退回」**(已入账订单会被 ATTEMPT_CREDITED_ORDER 拒绝);核实通道退款流水后人工处理(已入账订单需人工扣回积分/先驳回发票),再「标记已处理」 |
| `missing_channel` | 本地已收款,通道账单没有 | 极罕见;核对账单日期时区,联系通道客服 |

处理完点「标记已处理」。差异落表即打 error 日志,可被日志监控拾取(v1 无主动推送,TODOS T-NOTIFY)。

## 4. 退款失败 / 订单卡「退款中」

- 退款失败自动回退:订单回 `credited`、attempt 记 `refund_failed` + 原因(admin 订单抽屉可见),可直接重试
  (同 refund_no 复用,通道侧幂等)。常见原因:商户可用余额不足。
- 微信退款是异步:`refunding` 属正常中间态,退款结果通知到达后自动转 `refunded` 并追回积分。
  长期卡住 → 查退款通知日志;微信商户后台确认退款单状态。

## 5. 通道整体不可用 / 需要紧急下线

- `/admin → 在线支付` 取消全部场景勾选并保存 → 收银台该通道立即回「敬请期待」,无需发版重启。
- 对公转账不受任何在线通道故障影响。

## 6. MASTER_KEY 相关

- MASTER_KEY 丢失/变更 → 商户密钥解不开 → 通道自动降级占位(不崩进程),日志
  `[支付] wechat 商户密钥解密失败`。恢复:用原 MASTER_KEY,或在 admin 重新录入商户密钥。
- 轮换主密钥:换 ENV 后到 admin 重新保存各通道密钥即可(密文按当前主密钥重写)。

## 7. 私有化 / 内网部署(收不到公网回调)

- 属预期形态:sweep 查单路径具备完整入账能力(决策13),到账延迟约 1–2 分钟(60s 轮询 tick
  + 新单 30s 观察期,单 tick 上限 40 单);用户停在收银台时前端主动查单仍是秒级。
- 出网需代理时配 `WECHAT_PROXY` / `ALIPAY_PROXY`(.env + compose 已转发)。
