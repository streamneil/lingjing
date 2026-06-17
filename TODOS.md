# TODOS — 灵镜

## 高优先级 / 战略验证

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
- **Context:** 来自 /plan-design-review 成员模块 D7。当前无计费后端,max_creator_seats 是 tenant 字段。
- **Depends on:** 计费/订单后端(尚不存在)。
- **Priority:** P2

## CEO 审计补充(2026-06-04,HOLD SCOPE — 项目收尾)

### T-MODERATION-API:内容审核接阿里云内容安全 Green 真实 API
- **What:** moderateScript/moderateOutput 从本地敏感词表升级为阿里云内容安全(Green)文本/图像检测 API。
- **Why:** 本轮做的是本地敏感词表过渡,覆盖有限;政企/广电审计可能要求真实内容检测(政治敏感、违禁、涉黄涉暴)。
- **Context:** 来自 /plan-ceo-review 项目收尾 D6。钩子已在 worker.ts:80/146 调用,接入成本低(换 moderation.ts 实现即可)。成片营业样先调低门槛(未达限放行加日志),避免阻断命脉。
- **Priority:** P2  **Depends on:** 阿里云内容安全 API 查证 + 开通

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

### T-IMGREF-IDOR:/jobs 输入图 imageRefs 跨租户/越权(MEDIUM)
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
- **Context:** 来自 2026-06-16 /plan-ceo-review 外部声音 #5。CEO plan: ~/.gstack/projects/digital-human/ceo-plans/2026-06-16-worker-concurrency.md。本轮 prod=16 不做也安全。
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
- **Context:** CEO plan ~/.gstack/projects/digital-human/ceo-plans/2026-06-17-admin-ops-dashboard.md。本轮已做点名的消耗快照/Top租户/充值/体感条/余额续航。消耗口径=reserve+release(非settle,settle 恒0);充值=recharge_order status='credited'。
- **Effort:** 每项 M(human)→ S(CC)。**Priority:** P3(数据量触发)。
- **Depends on / blocked by:** 租户/job 量增长;趋势图需先抽 bucketSeries helper + credit_ledger(created_at) 索引。
