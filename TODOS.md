# TODOS — 灵镜

## 高优先级 / 战略验证

### T-DATA-DURABILITY:Litestream 流式备份到 OSS + 恢复 runbook + 宕机告警(数据安全,重点)
- **What:** 把现在的「每天 03:30 本地 cron 备份(scripts/backup.sh)」升级为 **Litestream 把 SQLite 秒级流式复制到 OSS**。配套三件:① Litestream 配好并**真的演练一次从 OSS 恢复到新机器**;② 写恢复 runbook(机器挂 → 拉新机 → 从 OSS 恢复 → 切流量,目标 RTO ~30 分钟);③ 加宕机告警(机器/服务一停就通知)。
- **Why:** 当前是「单机 SQLite + 本地 cron 备份」,有一个不该接受的洞——**磁盘/整台 VM 丢了,服务停 + 最多丢 24h 数据,而且本地备份跟机器一起没**。对 B 端运营平台,丢的是积分流水/对公订单/发票/生成记录这些财务与合规数据。Litestream 把 RPO 从 24h 降到 ~几秒,且备份落在异地(OSS,不同故障域)。**这是一扇单向门:数据丢了找不回,所以值得早做。**
- **Pros:** 数据安全做满,过 B 端运营及格线;不动架构(仍单机 SQLite);成本极低(一个 sidecar 进程 + OSS 桶)。媒体已在 OSS,这步补齐元数据的异地持续备份。
- **Cons:** Litestream 只保证「数据能恢复」,不解决「服务零停机」——发版/崩溃仍有短时停机(那是高可用问题,属另一条线,等签 SLA 再说)。需配 Docker sidecar + 一次恢复演练。
- **Context:** 来自 2026-06-30 /plan-ceo-review 数据层讨论。结论:**单机 SQLite + Litestream 流式 OSS 对当前到成长期完全可运营,且最合适**;真 HA(多机 + 托管 Postgres,见 T-HA-POSTGRES 思路)等业务信号(书面 SLA / 停机开始掉单)再上,不是现在。现有 scripts/backup.sh 的 WAL 安全热备做法正确,Litestream 是它的「连续版」升级,非推倒重来。
- **Effort:** M(human)→ S(CC)。**Priority:** P1(重点,有空即做;先于任何架构迁移)。

### T-FIDELITY:验证预置/照片形象保真度是否足以打动那家电视台
- **What:** 用 C-code 出的预置/照片样片给目标电视台看,确认保真度是否足以推进签约。
- **Why:** 电视台对主持人分身保真度要求极高。高精训练(C4)已推迟到签约后,但客户可能要先看到高保真才签——先有鸡还是先有蛋的死锁。这是切片顺序第一性假设的验证点。
- **Pros:** 早发现"必须高保真才签"的情况,避免 Slice 1 做完才撞墙。
- **Cons:** 依赖 C-code 产出 + 客户沟通,不是纯工程。
- **Context:** 来自 /plan-eng-review 外部声音 #7。设计文档把 C4 高精训练推迟到私有化签单后(§Premise 2)。若验证发现保真度不够,C4 需提前。
- **Depends on / blocked by:** C-code(T1)产出样片;不阻塞 Slice 1 开工,可并行问客户。

### T-SAAS-RISK:验证"多家中小机构愿意用托管 SaaS"
- **What:** 用早期真实线索验证 SaaS 需求,而非假设。两个 AI 模型都警告:唯一真需求要私有化,你押的是完整 SaaS。
- **Why:** 这是整个项目最大未验证风险(设计文档 Open Q1)。Slice 2 多租户/RBAC 只有在"出现第二家愿意用托管的客户"时才有价值。
- **Pros:** 决定 Slice 2 该不该做;避免为不存在的多租户需求投几周工程。
- **Cons:** 需要市场动作,非工程可解。
- **Context:** 来自 /office-hours + /plan-eng-review 外部声音 #1。Slice 1 已设计为双用(私有化 POC + SaaS 起点),所以在拿到验证前不必先做 Slice 2。
- **Depends on / blocked by:** 无工程依赖;Slice 1 交付给首个电视台后,观察是否有第二家要托管。

### T-PUBLIC-URL:私有化内网下 wan2.2-s2v 的公网 URL 问题(查证发现)
- **What:** wan2.2-s2v 要求 image_url / audio_url **公网可访问**。私有化部署时素材在客户内网 MinIO,百炼云端访问不到。
- **Why:** 托管模式没问题(MinIO 在公网);但私有化是护城河,这条会卡住私有化交付。
- **Pros:** 早发现避免私有化签约后才暴雷。
- **Cons:** 需方案设计(临时公网中转/客户侧出网白名单/或私有化改用可内网部署的 s2v 方案)。
- **Context:** 2026-06 查证阿里官方文档得知。能力网关已抽象,可在私有化网关实现里换"先把素材推到一个百炼可达的临时桶"。
- **Depends on / blocked by:** 私有化首单落地前必须解决。

### T-SHOWCASE-ASSETS:示范图文媒体随 git 带 + 部署时灌各自桶(去中心化)
- **What:** 落地页/探索灵感的示范图文媒体(showcase 40+ 图 + 果茶示范 + AI 音乐示例,共 ~54MB)现在写死引用公共桶 `lh-lingjing`(showcase-data.js / landing.html 等 147 处 URL)。改为:媒体随 git 提交进 `prototype/showcase/`,部署时 seed 脚本幂等上传到运营自己的 OSS,前端 URL 改为按当前环境桶动态拼(或走 `/api/showcase` 后端返回)。
- **Why:** 当前所有部署共享 `lh-lingjing` 公共桶 —— 桶一旦关停/迁移,所有运营部署的落地页图全裂;且依赖单点长期在线。去中心化后每个部署自包含,无外部依赖。
- **Pros:** 部署完全自包含;私有化内网下示范图也能本地化;不再有公共桶单点。
- **Cons:** 仓库变大 ~54MB;要改 147 处写死 URL + 写媒体上传 seed(已有幂等上传范式可复用,见 seed-preset-samples.mjs);需充分测试防回归。
- **Context:** 2026-06 一键种子工作的延伸建议。现状"能用、零成本"(公共桶 HTTP 200 可读),故二期再做;方案选型见当时分析("媒体方案1:随 git 带 + 种子上传各自桶")。运营生成产物已写各自 `OSS_BUCKET`,与示范数据隔离 —— 本条只动示范数据。
- **Depends on / blocked by:** 不阻塞当前部署;`lh-lingjing` 公共桶要下线前必须先做。

### T-ORPHAN-ASSETS:成员删除后的孤儿作品与资产无人可清理(隐私隔离的已知代价)
- **What:** 成员被移除后,其作品/形象/音色的 `created_by` 指向一个已不存在的用户 → **谁都看不见、谁都删不掉**,OSS 存储费持续计费。只有平台超管(`/admin`)能直接操作库与桶。要做的是二选一:① 删除成员时弹窗强制选「资产一并删除」或「转交给指定成员」(改写 `created_by`);② 或提供一个超管侧的孤儿资产清理任务。
- **Why:** 2026-07 隐私隔离(见 `docs/superpowers/specs/2026-07-25-tenant-admin-privacy-design.md`)把管理员对他人内容的可见性彻底收掉,连带封掉了原本用于「善后/审核」的删除后门(`deleteJobForTenant` 的 `isAdmin` 豁免)。这是有意的取舍:**隐私承诺保持无条件,不留任何「管理员可以看」的例外**,代价就是治理能力这个缺口。
- **Pros:** 补上后存储成本可控、数据治理闭环;交接方案还能顺带解决「员工离职,他做的形象库全机构没法接着用」的真实运营诉求。
- **Cons:** 交接 UI + `created_by` 改写要走审计;「转交」本身是一次归属变更,需想清楚是否要通知被转交人(否则等于管理员单方面把别人的东西给了第三人)。
- **Context:** 2026-07-25 brainstorm 明确选择「什么都不做,孤儿数据留库里」,把这笔记账。当前用户规模下成本可忽略;等到有客户真的开始频繁增删成员再做。
- **Effort:** S(CC)。**Priority:** P2(不阻塞;有客户反馈或存储账单异常时提上来)。

### T-VIDEO-TIMING:wan2.2-s2v 视频时长 = 音频时长(计费精细化)
- **What:** s2v 视频长度由驱动音频决定。当前计费按文案字数估算(够用),二期可改为按音频真实时长精确计费。
- **Context:** 见设计文档 D17;字数估算是合理近似(字数≈语音时长)。低优先级。

## 已并入本期 PR 的事项(不在此列,见设计文档 Eng Review 增补)
- 授权存证、合规 moderation 钩子、DB 队列、MinIO 存储 — 均已纳入 Slice 1/3 任务清单。

## CEO 审计补充(2026-06-03,SELECTIVE EXPANSION)

### T-CUSTOM-BG:自定义视频背景上传(PRD E6)
- **What:** 创作时上传高清背景图,生成视频用该背景。
- **Why:** PRD E6 列为需求。
- **Cons:** wan2.2-s2v 是"图+音驱动口型",背景是原图一部分;换背景需额外抠图/合成,百炼接口未必直接支持。
- **Context:** 来自 /plan-ceo-review D3.5。需先验证百炼 s2v 能否换背景,否则要自建抠图管线。
- **Priority:** P2  **Depends on:** 百炼能力确认(C-research)

### T-SEAT-BILLING:席位与计费/订单后端打通
- **What:** 把 tenant.max_creator_seats 接入真实计费——"升级套餐买更多席位"的支付流程。
- **Why:** 本轮席位已真实强制(默认 10,超限拦截),但上限值现在靠后台/SQL 手设;商业化需让客户自助升级。
- **Context:** 来自 /plan-design-review 成员模块 D7。max_creator_seats 是 tenant 字段,上限值目前靠后台/SQL 手设。
- **Depends on:** ~~计费/订单后端(尚不存在)~~ → **已解锁**(v0.6.0.0 在线支付上线:`src/payments/` 通道层 + 订单/发票闭环已就绪,席位升级可复用同一条收款链路,只需加「席位」商品类型)。
- **Priority:** P2

## CEO 审计补充(2026-06-04,HOLD SCOPE — 项目收尾)

### T-MODERATION-API:内容审核接阿里云内容安全 Green 真实 API
- **What:** moderateScript/moderateOutput 从本地敏感词表升级为阿里云内容安全(Green)文本/图像检测 API。
- **Why:** 本轮做的是本地敏感词表过渡,覆盖有限;政企/广电审计可能要求真实内容检测(政治敏感、违禁、涉黄涉暴)。
- **Context:** 来自 /plan-ceo-review 项目收尾 D6。钩子已在 worker.ts:80/146 调用,接入成本低(换 moderation.ts 实现即可)。成片营业样先调低门槛(未达限放行加日志),避免阻断命脉。
- **Priority:** ~~P2~~ → **P1**(2026-07-22 Open API eng-review D8 升级:API key 开放给外部 Agent 后,本地敏感词 stub 的盲区被自动化流量放大;定为 API **对外推广**(非上线)前的硬条件)  **Depends on:** 阿里云内容安全 API 查证 + 开通

### T-VOICE-MIGRATION:声音迁移(歌曲演唱迁移)
- **What:** 上传歌曲,用克隆音色完成演唱迁移,自动识别并校正歌词。
- **Why:** 原 landing 页列为"即将上线"(本轮已从界面撤下,不再公开承诺)。是与 s2v/CosyVoice 不同的另一整套能力。
- **Context:** 来自 /plan-ceo-review 项目收尾 D2/TODO2。界面已按用户要求撤掉"即将上线"标。做之前需先验证百炼是否支持演唱迁移(SVC/歌声合成),否则要自建管线。
- **Priority:** P3  **Depends on:** 百炼演唱迁移能力验证

### T-FFMPEG-PRIVATE:私有化交付 ffmpeg 装包
- **What:** AI 水印用系统 ffmpeg;私有化进客户内网时需把 ffmpeg 纳入装包/镜像清单。
- **Why:** 托管 SaaS 系统自带 ffmpeg;私有化(护城河)是离线内网,漏一个二进制依赖交付时会卡壳。
- **Context:** 来自 /plan-ceo-review 项目收尾 D5/TODO3。与 T-PUBLIC-URL 同类私有化交付细节。本轮水印已做优雅降级(ffmpeg 缺失跳过烙字但标 ai_label)。
- **Priority:** P2  **Depends on:** 私有化首单落地

## 设计评审补充(2026-06-10,img2video UI parity)

### T-PASTE-UPLOAD:粘贴上传(Cmd/Ctrl+V)
- **What:** img2video / ai-image / ai-image-edit 三页支持直接粘贴剪贴板图片上传。
- **Why:** 融媒体编辑常从截图/素材库复制图,省去「存文件→选文件」两步。三页共享一个 paste 监听实现。
- **Context:** 来自 /plan-design-review img2video UI parity 轮。需处理焦点上下文(粘在提示词框里的文字 vs 图)+ 三页各自槽位路由(img2video 还分首帧/尾帧/参考)。全站级体验缺口而非 img2video 个体差距,故不入 parity 轮。
- **Priority:** P3  **Depends on:** 无

## CEO 审计补充(2026-07-13,SELECTIVE EXPANSION — 收银台在线支付)

### T-NOTIFY:到账主动通知(对公单)
- **What:** 超管确认对公打款到账时,站内信/邮件主动告知用户;对账差异告警同通道推送。
- **Why:** 用户旅程已知缺口:对公打款后用户反复刷台账看「钱到了吗」。微信/支付宝单秒到账已免疫;对公单(大额主力)仍靠人工确认后用户无感知。
- **Pros:** 对公单体验闭环;对账差异从「超管登录才见」升级为主动推送。
- **Cons:** 平台无站内信/邮件基础设施,需从零建通知通道,超出支付范畴。
- **Context:** 来自 2026-07-13 /plan-ceo-review 在线支付轮 D4.4。在线支付上线后对公单占比可能下降,优先级随之浮动。
- **Effort:** L(human)→ M(CC)。**Priority:** P2。**Depends on:** 无(通知基建独立一条线)。

### T-JSAPI:微信内 JSAPI 支付
- **What:** 公众号 openid 体系 + JSAPI 下单,微信内浏览器原生拉起支付。
- **Why:** 收银台链接在微信聊天里传播是国内 B 端常态;v1 兜底是「Native 码+长按识别」,JSAPI 才是该场景正解体验。
- **Pros:** 微信内支付从长按识别变一键拉起。
- **Cons:** 要公众号资质 + 网页授权 openid 流,独立一条线。
- **Context:** 来自 2026-07-13 /plan-ceo-review 在线支付轮(微信内浏览器场景决策)。通道层已预留:JSAPI 只是 wechat provider 的第三个场景实现。
- **Effort:** L(human)→ M(CC)。**Priority:** P3。**Depends on:** 公众号资质;本轮通道层。

### T-PARTIAL-REFUND:部分退款 + 发票红冲
- **What:** 按金额部分退款;已开票订单退款的红冲/重开票流程。
- **Why:** v1 规则是整单全额退款 + 挂票订单拒退(先驳回发票);客户量起来后「退一半」「票已寄出要红冲」会出现。
- **Pros:** 退款能力闭环到财务真实全谱。
- **Cons:** 部分退款的积分折算口径(退钱退多少积分)需产品决策;红冲涉税务流程。
- **Context:** 来自 2026-07-13 /plan-ceo-review 在线支付轮外部声音 #2。当前拦截规则在 refund 入口检查 invoice_order 关联。
- **Effort:** M(human)→ S(CC)。**Priority:** P3。**Depends on:** 本轮退款闭环落地。

## 工程质量(2026-07-14 发现)

### T-TEST-ORDER-DEPENDENCE:测试用例间存在执行顺序依赖(打乱即挂)
- **What:** `npx vitest run --sequence.shuffle` 会挂 4-13 个用例(默认顺序全绿)。根因:同文件内多个 describe 共享 beforeAll 造的数据,后面的用例会改掉前面用例依赖的状态。典型:`order-management.test.ts` 的 `cancelStalePendingOrders(-1)`(全库取消所有待支付单)一旦先于 `adminOrderCounts 计数正确` 执行,后者的 pending 基线就没了;`ai-music` / `img2video` 等文件也有同类问题。
- **Why:** 顺序依赖 = 隐性耦合。今天靠"声明顺序恰好正确"活着;将来任何人插一个 describe、或 vitest 改并发策略,就会随机红,且极难定位(2026-07-14 合并 v0.6.0.0 时就出现过一次 4 例偶发失败)。
- **Pros:** 修完后测试可任意并行/打乱,CI 更可信;flake 归零。
- **Cons:** 要逐文件把「跨 describe 共享可变状态」改成各自造数据(或用 beforeEach 重置),涉及多个存量测试文件。
- **Context:** **不是本轮引入**——在 v0.6.0.0 前的 base(6aeac96)上打乱跑挂 12-13 例,本轮后反而只挂 4-8 例。默认顺序在 base 与 main 上都全绿(822 / 931)。修复策略:自破坏性用例(如 sweep、全局取消)独立文件或自造数据;计数类断言用增量基线(order-management 已用此范式,只是被后续用例破坏)。
- **Effort:** M(human)→ S(CC)。**Priority:** P2(不影响当前 CI,但属定时炸弹)。
- **注意(2026-07-25):** v0.8.0.6 修的是**另一个** flake 源(端口 churn:mcp / job-channel 各自多 listen 了一个 server,默认顺序下约 20% 概率随机某文件级联失败),不是本条。本条的顺序依赖仍未修 —— 别因为「flake 修好了」就关掉它。

## Open API 评审补充(2026-07-22,/plan-eng-review — API key + MCP 轮)

### T-APIKEY-SPEND-CAP:per-key 日消费上限 + 异常用量告警
- **What:** API key 增加可选「日消费积分上限」;超常用量(如单 key 单日消耗超历史均值 N 倍)告警给 admin。
- **Why:** key 存在客户 agent 的配置文件里,泄露概率高于人用 session;当前模型「余额即上限」意味着泄露即可烧光租户全部余额。本轮产品决策明确不做(保持简单),此条保留风险记录。
- **Pros:** 泄露爆炸半径从「全部余额」缩到「日上限」;Cons:多一层配置概念,与「简单」原则相悖。
- **Context:** 来自 2026-07-22 Open API eng-review 外部声音 #10(「最贵资产×最易泄露凭证」)。设计文档:docs/superpowers/specs/2026-07-22-open-api-mcp-design.md。
- **Effort:** M(human)→ S(CC)。**Priority:** P2(触发条件:出现真实 API 客户)。**Depends on:** PR1 api_key 落地。

### T-RATELIMIT-UTIL-MIGRATE:login-throttle 迁移到通用滑窗限速工具
- **What:** PR1 新建 src/auth/rate-limit.ts 通用滑窗限速器(API key 限速用);本条把 login-throttle.ts 迁到同一工具,消除第二份滑窗副本。
- **Why:** DRY 收口,同 T-GPTIMG2-GEMINI-DRY 节奏(先建 helper 新代码用,老副本独立后续迁)。
- **Cons:** 碰活的认证代码,需登录限流回归(login-throttle.test.ts 全绿)。
- **Context:** 2026-07-22 Open API eng-review D5。**Priority:** P3。**Depends on:** PR1 rate-limit.ts 落地。

### T-API-CLI:命令行客户端(npm 包)
- **What:** `npx lingjing gen ...` 风格 CLI,REST 开放面的薄封装(~200 行)。
- **Why:** 脚本/CI 场景接入;方案评审时已定后置(MCP 优先,Agent 生态 MCP 是事实标准)。
- **Cons:** 多一个需构建/发布/更新的 npm 制品,发布管线(npm registry、版本策略)是本条 scope 的一部分,不另立项。
- **Context:** 2026-07-22 Open API 方案讨论,接入层三形态(REST/MCP/CLI)中的第三档。**Priority:** P3(触发条件:客户明确要脚本化接入)。**Depends on:** PR1 REST 落地。

### T-API-WEBHOOK:任务完成 Webhook 回调
- **What:** 任务终态时 POST 客户配置的回调 URL(带签名),免轮询。
- **Why:** 纯轮询模式下视频类长任务轮询流量大;PR1 的读写分级限流(读 300/min)已缓解,webhook 是根治。
- **Cons:** 出站请求一整套新面:重试、HMAC 签名、SSRF 防护(回调 URL 校验)、失败降级回轮询。
- **Context:** 2026-07-22 Open API eng-review 外部声音 #5 派生。**Priority:** P3(触发条件:轮询流量成为可观测问题)。**Depends on:** PR1/PR2 落地。

## ✅ 已完成(归档,保留可追溯)

### T-TTS-QUALITY-MODEL:品质模型选择 + 按 tier 计价 — ✅ 2026-06-11
- 完成证据:TTS_MODELS 注册表(cosyvoice-v1/v3.5-flash/qwen3-tts-flash/instruct)+ 品质下拉按音色 transport 过滤。estimateTtsCost(len,pricePerChar) 默认不变(byte-identical)、costFor 读 pricePerCharSnapshot;buildTtsJob 校验模型⟂音色 transport(不兼容 400)+ 快照单价(reserve==settle);GET /tts-models。test/tts-quality-model.test.ts 15 例。merge fd18281。

### T-TTS-EMOTION:情绪下拉 + 音高滑块 — ✅ 2026-06-11
- 完成证据:EMOTIONS 注册表 + buildInstruction(emotion,pitch);gateway 两路透传(CosyVoice instruction+pitch、Qwen instructions);buildTtsJob 情绪/音高仅 supportsInstruction 模型可用(否则 400)+ 越界校验;前端情绪下拉+音高滑块仅指令模型启用。test/tts-emotion.test.ts 12 例。merge 400958a。

### T-SETTINGS-AUDIT-DIFF:设置变更字段级审计 — ✅ 2026-06-11
- 完成证据:audit_log 加 detail 列;audit()/writeAudit() 加 detail 参(AuditDetail);settings.ts applyIfChanged 逐字段对比旧→新只记真正变的、空改动不写;GET /audit 投影 detail。test/settings-audit-diff.test.ts 4 例。merge 9d63e0e。

### T-TTS-PANEL-SHEET-DEDUP:.vsheet 重构到共享 .sheet-side 范式 — ✅ 2026-06-11
- 完成证据:tts.html 旧自定义类(.vtab/.vcard2/.vdesign-btn/.vplay)已删干净(grep 零残留),改用共享 .sheet-side/.ss-head/.ss-seg/.ss-filters/.ss-body/.vcard/.vc-play(19 处)。commit b821630。真机 480px 单列、pill segment、选中蓝边、设计弹窗 z 在上;voices.html 未受影响。

### T-TTS-PANEL-TOKENS:声音面板硬编码 radii 对齐 token — ✅ 2026-06-11
- 完成证据:随 T-TTS-PANEL-SHEET-DEDUP 一并解决。面板 CSS 无 9/12/7px 硬编码圆角(grep 空),现存圆角均 var(--r-sm)/var(--r) token(filter 下拉 10px 为合理局部值)。

### T-ROLE-CHANGE:改已有成员角色 — ✅ 漏标补归档
- 完成证据:auth.ts:152 有 PUT /members/:id/role(requireRole admin)+ changeRole();约束完整 —— 角色合法性、席位上限(升 creator 校验 SEATS_FULL)、last-admin 保护(降级 admin 查 countActiveAdmins<=1)。test/members-seats.test.ts 覆盖。

### T-WORKS-POLL:作品库轮询自动刷新 — ✅ 漏标补归档
- 完成证据:works.html:210/214 有列表级自动轮询(schedulePoll,仅 queued/running 才轮、全终态停、离页 visibilitychange 暂停、回页立刷),复用 load() 全量刷新。

### T-BRAND-LOGO-GC:孤儿 Logo 对象回收 — 📋 后续增强
- What:改 logo / 恢复默认 / 重传时,删除存储里被替换的旧对象(`logos/<tenant>/<uuid>`)。
- Why:目前只清 `org_logo_key` 不删 blob,每次重传/恢复漏一个对象,长期累积。
- Depends on:`src/storage/index.ts` 加 `deleteObject`(minio + oss 两后端都要实现,现仅有 put/get)。
- Context:租户品牌 MVP 接受孤儿对象(logo 5MB 封顶,成本极低)。见 settings.ts:130(重传已覆盖 key 不删旧)。

### T-BRAND-SUBDOMAIN:落地页子域名识别租户 — 📋 后续增强
- What:落地页支持 `acme.lingjing.com` 子域名识别租户并渲染其品牌(MVP 用路径式 `/t/:slug`)。
- Why:子域名比 `/t/slug` 更像「租户自己的站」,品牌感更强,适合给政企客户做白标。
- Depends on:泛域名证书(`*.lingjing.com`)、Caddy 动态签证/通配 host 路由、`tenant.slug` 唯一列(MVP 已加)。
- Context:租户品牌自定义(Logo/名称)MVP 已落地路径式识别;子域名是同一识别逻辑换入口,后端 `GET /api/public-brand/:slug` 可复用,只需把 slug 来源从 path 改为 Host 头。见 prototype/TENANT-BRANDING-PLAN.md「缺口 3」。

## 种子/部署脚本建默认四档套餐
- **What:** 在 scripts/seed(或部署初始化)里建默认四档定价套餐(入门体验/标准充值/专业充值/大富罁)。
- **Why:** 全新部署种子当前不建任何套餐,公开价格接口 `/api/public-pricing-plans` 返 `{plans:[]}`,新部署的落地页价格区会空白(只靠空态兜底文案)。
- **Pros:** 新环境一部署落地页价格区即有内容;营销页不空。
- **Cons:** 需维护一份默认套餐数据 + 幂等插入(避免重复建)。
- **Context:** 发现于 landing-flagship eng-review(2026-06-13)外部声音。现有 lingjing.db 已有四档真实套餐,仅「全新空库部署」会空。落地页本身已有空态兜底(同 pricing.html「暂无可购套餐」),所以不阻塞落地页上线。
- **Depends on / blocked by:** 无。独立于落地页 PR。

## 安全(2026-06-15,eng-review 发现 — explore 多模态轮)

### T-IMGREF-IDOR:/jobs 输入图 imageRefs 跨租户/越权(MEDIUM) — ✅ 2026-07-23(Open API PR0)
- **What:** `/jobs` 的 i2v/图片编辑/视频编辑 builder 只做 `imageRefs.filter(string)`(src/api/jobs.ts:446/534),不校验 key 归属本租户、不校验有无 authorization 行;worker 对任意 key 直接 `publisher.publish(k)→getSignedUrl(k)`(worker.ts:363)。
- **Why:** 登录用户 POST `/jobs` 带 `imageRefs:["image-inputs/<他租户>/<uuid>.png"]` → worker 签名送百炼 = 跨租户输入图读取(IDOR)+ consent 合规闸旁路。需登录 + 猜 UUID(跨租户),故 MEDIUM。
- **Fix:** builder 加校验:imageRef 必须 `image-inputs/<本租户>/` 前缀 **且** 存在对应 authorization 行(本租户)。回归测试入 `test/account-isolation.test.ts`(creator A 拿 B 的 imageRef 建 job → 拒)。
- **Context:** 发现于探索页多模态 eng-review。该轮原计划的 `?img=` 预填会把此旁路产品化,已改降级方案(只填文本)规避,但底层缺陷仍在。既有缺陷,非该轮引入。
- **Depends on / blocked by:** 无。独立于探索页 PR。

### T-RATE-LIMIT:三个 gateway 加 429/退避重试(调高并发的前置)
- **What:** baichuan/ark/gemini 三个 gateway 现均无 429/Throttling 处理。在 pollUntilDone + 同步调用路径加 429 检测 + 指数退避重试(复用现有 job deadline)。
- **Why:** worker 改并发池后(2026-06-16 CEO review),prod POOL_SIZE=16 不撞百炼/火山账号级 RPM/TPM 额度(账号级配额远高,见 help.aliyun.com/zh/model-studio/rate-limit);但若以后调更高并发、或厂商降额度,无退避会让任务直接 failed。这是「调更高并发」的前置安全网。
- **Pros:** 解锁安全地把 POOL_SIZE 调到几十;限流时透明重试而非报错给用户。
- **Cons:** 三处 gateway 都改;需区分可重试(429/5xx)vs 不可重试(4xx 参数错)。
- **Context:** 来自 2026-06-16 /plan-ceo-review 外部声音 #5。CEO plan: ~/.gstack/projects/lingjing/ceo-plans/2026-06-16-worker-concurrency.md。本轮 prod=16 不做也安全。
- **Effort:** M(human)→ S(CC)。**Priority:** P2。
- **Depends on / blocked by:** 无;但「把 POOL_SIZE 调到 >16」依赖它先落地。

### T-POOL-HOTCONFIG:admin 热调 worker 并发池大小(免重启)
- **What:** POOL_SIZE 现为环境变量 WORKER_POOL_SIZE(改值需重启)。改为存 platform_config 表 + admin 运营页加滑块,worker 循环每轮读最新值 → 不重启即时改并发。
- **Why:** 运营高峰临时扩容/缩容不必走部署重启,与现有「运营监控」驾驶舱(admin.ts)体验一致。
- **Pros:** 运营自助调并发;配合「进行中 N/容量 M」看板形成闭环。
- **Cons:** 多一个配置表 + API + 前端控件 + requirePlatformAdmin 越权校验。
- **Context:** 来自 2026-06-16 /plan-ceo-review(SELECTIVE EXPANSION cherry-pick,延后)。环境变量先够用。CEO plan 同上。
- **Effort:** M(human)→ S(CC)。**Priority:** P3。
- **Depends on / blocked by:** 并发池基线 PR 先落地。

### T-OPS-DASHBOARD-V2:运营看板进阶指标(等 ~20+ 租户 / job 量起来)
- **What:** 2026-06-17 CEO review(EXPANSION→TRIM)砍下的 5 个看板指标,数据量够大再做:① 收入vs消耗 30日双线趋势图(届时抽 bucketSeries 时间分桶 helper,复用 concurrency:285 模式)② 消耗 by 工具/模型 条形榜(ledger JOIN job,json_extract input_json.model,NULL→其他桶)③ 今日失败错误分类榜(job.error 关键词归类:送审拒/限流429/超时/参数错)④ 增长指标(新增租户月 / 活跃7日 / sales_leads 转化 / 付费租户数)⑤ 流失预警(MAX(job.created_at)<now−7d 的曾活跃租户)。
- **Why:** 现在 2 租户/63 job,这些图表/榜单是噪声(~2 job/天的折线、n=2 的活跃率/Top10 无分辨率)。外部声音 strategic review 判定 premature。量起来后才有信号。
- **Pros:** 量大后是真运营驾驶舱(收支趋势/成本结构/排障/增长)。**Cons:** 现在做=看着像坏了。
- **Context:** CEO plan ~/.gstack/projects/lingjing/ceo-plans/2026-06-17-admin-ops-dashboard.md。本轮已做点名的消耗快照/Top租户/充值/体感条/余额续航。消耗口径=reserve+release(非settle,settle 恒0);充值=recharge_order status='credited'。
- **Effort:** 每项 M(human)→ S(CC)。**Priority:** P3(数据量触发)。
- **Depends on / blocked by:** 租户/job 量增长;趋势图需先抽 bucketSeries helper + credit_ledger(created_at) 索引。

## AI 图片:Nano Banana 尺寸预览像素化(后期)

走 `ratios?: string[]` 轻量机制后,Gemini 的 setPill 尺寸预览显档名(如「16:9 · 2K」),
不显具体像素(如「16:9 · 2752×1536」)——与 z-image 现状一致。官方像素表(见
docs/superpowers/specs/2026-06-18-nano-banana-resolutions-design.md 的 Flash 14×4 / Pro 10×3 表)
将来可录为静态展示常量供 setPill 查,做像素级预览。本轮不做(档名够用)。
决策:plan-eng-review 2026-06-19。

### T-USERASSET-REUSE-URL:复用预览硬编码 lh-lingjing 桶(非示范媒体)
- **What:** ai-image-edit/img2video/video-edit.html 的 `const OSS_BASE='https://lh-lingjing...'`(3 处),用于「重新提示」复用上一次 job 输入图的预览(OSS_BASE+key)。这是**用户自产资产**,非示范媒体,本次去中心化未动。
- **Why:** 换个部署/桶时这 3 处仍指向 lh-lingjing → 复用预览裂图(指向错桶)。正解:走一个鉴权签名端点 `/api/sign?key=`(按租户签自己桶的 key),或复用 works 已有签名 URL,不要前端拼桶域名。
- **Context:** 2026-06 示范媒体去中心化(/api/showcase-asset)的遗留邻项;示范媒体已全部自包含,这条是用户资产预览,影响面小(仅复用交互),单列。
- **Depends on / blocked by:** 不阻塞部署。

### T-SMS-COST-CEILING:自助注册的成本-DoS 闸(试用积分门控 + 全局短信/新机构日上限)
- **What:** 给开放自助注册加全局闸:① 试用积分门控(注册默认 0 或极小额,真发 200 需一个门控动作);② 全局每日「新机构数 + 短信发送量」上限,超阈停发/停建兜底。
- **Why:** /plan-ceo-review + 外部声音两模型一致告警:国内接码平台便宜,N 手机号 → N 机构 ×200 积分 = 按真实模型成本免费生成;captcha+限频挡脚本但挡不住代理池/SIM 农场。本轮用户选保留现状(200 自动 + 无上限),此为已知开放风险。
- **Context:** CEO plan ~/.gstack/projects/streamneil-lingjing/ceo-plans/2026-06-24-sms-login.md(OPEN RISK 段)。短信登录 PR 上线后盯 recharge/grant 异常 + 短信量。
- **Effort:** S(human)→ S(CC)。**Priority:** P2(上线即暴露成本面)。
- **Depends on / blocked by:** 短信登录主功能上线。

### T-SMS-WELCOME-STATE:新管理员欢迎/空组织首次引导(E2,跳过)
- **What:** 自助注册的 admin 一进来是空机构(无成员/积分/作品),给个引导空状态(去试用/去充值/改 brand_name)。
- **Why:** 减少首次跳出。本轮用户选不做(不重复提示设密码/补机构信息,#7 已在账户页覆盖)。
- **Effort:** S/M(human)→ S(CC)。**Priority:** P3。

### T-SMS-BUDGET-DASH:短信预算告警 + 超管可见(E3,跳过)
- **What:** 超管后台看得见短信发送量 + 超阈告警。
- **Why:** 开放注册下的运营可观测。与 T-SMS-COST-CEILING 互补(那条是硬闸,这条是看板/告警)。本轮用户选不做。
- **Effort:** S/M(human)→ S(CC)。**Priority:** P3。

### T-SMS-TRUSTED-DEVICE:可信设备免滑块(E4,跳过)
- **What:** 30 天内记住设备,老用户登录免再拖滑块(发短信仍验证)。
- **Why:** 老用户体验。本轮用户选不做(每次滑块,简单一致)。
- **Effort:** M(human)→ S(CC)。**Priority:** P3。

### T-SEEDREAM-TIER-PRICING:豆包 Seedream 分辨率分档成本核实 + 变体行
- **What:** 核实火山 Seedream 4.0/4.5/5.0-lite 各清晰度档真实成本(官方按 token 计,4K 耗 token 远多于 1K),差异显著则用 imagePriceTier 通用变体机制种入 `doubao-seedream-*:{档}` 行。
- **Why:** Gemini 分档计价 review(2026-07-04)外部声音指出同病未治:机制已通用化,但 3 个豆包多档模型仍全档扁价(¥0.20–0.25 占位,image-models.ts 自认「火山按 token 计」「价格未录」),4K 按 1K 价卖,毛利漏洞同款。
- **Context:** 分档机制、种子护栏(基础行改价则跳过)、disabled=下架语义均已随 Gemini 轮落地,本条只剩「核价 + 种行」。火山 token→每张成本需实测或查计费文档。
- **Effort:** S/M(human)→ S(CC)。**Priority:** P2(有真实流量后毛利面暴露)。
- **Depends on / blocked by:** Gemini 分辨率分档计价落地(imagePriceTier 机制)。

### T-PRICING-DEAD-ROWS:清理「模板已亡」的遗留模型行(gemini-2.5-flash-image)
- **What:** 启动幂等迁移:image_model_override 行的 shape_template 指向已删除代码模板时(mergeDef 返回 undefined,用户端永不可见),自动把该行及同 key 的 model_pricing 行标 disabled(或删除)。
- **Why:** 本地库实查 gemini-2.5-flash-image 两表行均 enabled(定价 ¥0.28),admin 统一定价页挂着一条看似在售的幽灵行,运营排查制造困惑。纯数据卫生,不影响计费。
- **Context:** Gemini 分档计价 review(2026-07-04)顺手发现。需幂等迁移而非手工 SQL(每个部署库都有)。
- **Effort:** S(human)→ S(CC)。**Priority:** P3。
- **Depends on / blocked by:** 无。

### T-GPTIMG2-GEMINI-DRY:Gemini 网关改调共享 helper(消双副本漂移)
- **What:** 把 GeminiGateway 里的「代理 dispatcher」+「base64 buffer → storage.putObject → media-publisher 转公网 URL 尾」两块,改调 gpt-image-2 本轮新建的 `src/gateway/sync-image-common.ts`(`proxyDispatcher(envVar)` + `b64ToPublicUrl(buf, tenant)`)。自带回归跑(现有 Gemini 测试全绿)。
- **Why:** gpt-image-2 接入时抽了这两个真通用的 helper,OpenAI 首日即用。Gemini 目前仍是自己那份副本 —— 两份代理缓存 + 存储尾逻辑并存,后续改一处易忘另一处(漂移)。改调消除双副本。
- **Pros:** DRY 收口;代理/存储尾逻辑单一真源。
- **Cons:** 碰活着的 Gemini provider(有回归面),故本轮特意后置,不阻 gpt-image-2 上线。
- **Context:** 来自 2026-07-07 /plan-eng-review + 外部声音 #8。外部声音提醒「别为 DRY 拿活 provider 降险」→ 决定:本轮只建 helper + OpenAI 用,Gemini 改调作独立后续 commit。注意:只搬「已提取的 buffer → url 尾」+ 代理;Gemini 的响应解析(inline_data snake/camel、thinking-part 跳过、safety-block)是 Gemini 专属,不进共享 helper。
- **Depends on / blocked by:** 本轮 gpt-image-2 的 sync-image-common.ts 先落地。**Priority:** P3(清理,不阻功能)。

### T-SEEDANCE-ASSET:火山私域素材库解 Seedance 人脸拦截(2026-07 上线,默认关)
- **What:** 开关 `ARK_ASSET_LIBRARY_ENABLED`(默认 false)。开=Seedance 视频"先用原图提交,若被隐私拦截(HTTP 400 `InputImageSensitiveContentDetected`)才把参考图报备入库换 `asset://` 重试一次";无脸视频首次即成功,不入库。
- **Why:** Seedance 2.0 反 Deepfake 会拦带脸参考图 → 图生视频/首帧/首尾帧/参考生全挂。素材库是火山给的官方白名单通道。
- **范围:** 仅 Seedance 视频(volc-ark);Seedream 图片不适用(火山未提供 asset:// 图片输入)。拦截码可配 `ARK_ASSET_RETRY_ON_CODES`。被拦 job 多一次厂商提交往返,无脸 job 无额外开销。
- **真人脸约束:** 素材库虚拟人像通道自动审核;真实真人脸需"被拍摄者本人活体认证",后端传照片≠授权。本方案面向虚拟/自有形象。
- **实现:** `src/gateway/ark-assets-client.ts`(AK/SK 签名)+ `ark-assets.ts`(入库轮询缓存)+ `worker.ts` runMediaVideoJob 提交处 try/catch。表 `ark_asset` / `ark_asset_group`。计划:`docs/superpowers/plans/2026-07-16-seedance-asset-library.md`。
- **待真机验证:** AK/SK 是脱敏的,真机 spike(`npx tsx scripts/ark-asset-spike.ts`)+ 端到端需真实 key。ProjectName 先按 default,不通再问对接方。**Priority:** 待验证后启用。
- **【二期 P2】** AK/SK 从 .env 迁到加密入库(provider-keys,同其它厂商 key);素材入库轮询在 worker 线内阻塞该 job,并发大时可抽独立预注册队列。

