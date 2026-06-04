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

### T-WORKS-POLL:作品库轮询自动刷新
- **What:** 作品库页对生成中任务轮询,自动转"已完成",无需手动刷页。
- **Why:** 体验连贯,用户不用手动刷新看进度。
- **Context:** 来自 /plan-ceo-review D3.6。create.html 对话流已有轮询,复用其模式即可。非断裂(手动刷新可见),优先级低。
- **Priority:** P3

### T-SEAT-BILLING:席位与计费/订单后端打通
- **What:** 把 tenant.max_creator_seats 接入真实计费——"升级套餐买更多席位"的支付流程。
- **Why:** 本轮席位已真实强制(默认 10,超限拦截),但上限值现在靠后台/SQL 手设;商业化需让客户自助升级。
- **Context:** 来自 /plan-design-review 成员模块 D7。当前无计费后端,max_creator_seats 是 tenant 字段。
- **Depends on:** 计费/订单后端(尚不存在)。
- **Priority:** P2

### T-ROLE-CHANGE:改已有成员角色
- **What:** 后端 PUT /members/:id/role 接口 + UI,允许 admin 调整已有成员角色(creator↔viewer↔admin)。
- **Why:** 当前只能在邀请时定角色;改角色得删了重建,丢历史。
- **Context:** 来自 /plan-design-review 成员模块 Pass7。需复用席位校验(viewer→creator 要查席位)+ last-admin 校验(admin→其他要保最后一个 admin)。
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
