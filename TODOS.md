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

## CEO 审计补充(2026-06-04,HOLD SCOPE — 系统设置)

### T-SETTINGS-AUDIT-DIFF:设置变更字段级审计
- **What:** update_settings 审计记录改了哪个字段、旧值→新值,而非只记一条"改了设置"。
- **Why:** 政企合规可能要求设置变更可追溯到字段。送审已改常开(消除最敏感操作),但默认参数/AI 标识文案变更仍值得留痕。
- **Context:** 来自 /plan-ceo-review 系统设置审计。audit 表可加 detail 字段;settings.ts:66 现只 audit('update_settings')。
- **Priority:** P2  **Depends on:** audit 表加 detail 列

## 设计评审补充(2026-06-10,img2video UI parity)

### T-PASTE-UPLOAD:粘贴上传(Cmd/Ctrl+V)
- **What:** img2video / ai-image / ai-image-edit 三页支持直接粘贴剪贴板图片上传。
- **Why:** 融媒体编辑常从截图/素材库复制图,省去「存文件→选文件」两步。三页共享一个 paste 监听实现。
- **Context:** 来自 /plan-design-review img2video UI parity 轮。需处理焦点上下文(粘在提示词框里的文字 vs 图)+ 三页各自槽位路由(img2video 还分首帧/尾帧/参考)。全站级体验缺口而非 img2video 个体差距,故不入 parity 轮。
- **Priority:** P3  **Depends on:** 无

## CEO 审计补充(2026-06-10,SELECTIVE EXPANSION — 文字转语音 声音面板)

### T-TTS-QUALITY-MODEL:品质模型选择 + 按 model tier 计价
- **What:** 文字转语音左面板加「品质」下拉(cosyvoice-v1 免费 / qwen3-tts-flash / MiniMax),不同模型能力与价格不同;estimateTtsCost 加 model 参,buildTtsJob 快照 modelTier。
- **Why:** 截图竞品左下有「品质 V2.0」下拉;不同模型音质/价格分层是付费分级的抓手。
- **Context:** 来自 /plan-ceo-review 声音面板轮(候选4,Defer)。钱路改动:estimateTtsCost(textLength) → estimateTtsCost(textLength, modelTier),buildTtsJob 必须快照 modelTier 保 reserve==settle(即便厂商返回不同)。本轮已加 voice.target_model 列为此铺路。是 T-TTS-EMOTION 的前置(情绪需 Qwen-Instruct/MiniMax)。
- **Priority:** P2  **Depends on:** 无(但解锁 T-TTS-EMOTION)

### T-TTS-EMOTION:情绪下拉 + 音高滑块
- **What:** 文字转语音左面板加「情绪」下拉(自动/开朗/沉稳/温柔/严肃/活泼…)+ 音高滑块 -12~+12;经 instruction 参数透传给 Qwen3-TTS-Instruct。
- **Why:** 截图竞品左面板有「情绪:自动」下拉 + 音高滑块;情感化配音是有声书/广告核心诉求。
- **Context:** 来自 /plan-ceo-review 声音面板轮(候选3,Defer)。强依赖 T-TTS-QUALITY-MODEL:cosyvoice-v1 不支持情绪/指令,情绪需 Qwen3-TTS-Instruct 或 MiniMax。buildTtsJob 加 instruction/pitch 校验,gateway 透传 instruction(Qwen 路径)。
- **Priority:** P2  **Depends on:** T-TTS-QUALITY-MODEL

## 设计评审补充(2026-06-11,文字转语音 声音面板)

### T-TTS-PANEL-SHEET-DEDUP:.vsheet 重构到 app.css 已有 .sheet-side 范式
- **What:** tts.html 的 .vsheet 声音面板重造了 app.css 已有的侧滑组件(.sheet-side/.ss-seg/.ss-filters/.ss-body/.vcard + @keyframes slideIn),用了不同 token(--bg-soft vs --modal、硬编码 radii、方角 tab vs pill segment)。重构到共享范式或把新组件提升进 app.css 配真 token。
- **Why:** 两套并行侧滑组件做同一件事、样式发散 —— 维护陷阱 + 视觉不一致(双 radii 体系、tab active 态语言不同)。来自 /design-review Claude 子代理 #5/#1/#6。
- **Context:** app.css:389-414 已有 .sheet-side 全套(pill segment .ss-seg、--blue-bg、--r-pill)。.vsheet 在 tts.html:18-57 内联。重构需同步改面板 markup + JS(switchVTab/renderVoices 用新类名),有视觉回归风险,故 design-review 本轮未动(按 CSS-first + 低风险原则)。
- **Priority:** P3  **Depends on:** 无

### T-TTS-PANEL-TOKENS:声音面板硬编码 radii 对齐 --r* token
- **What:** .vtab/.vfilter/.vcard2/.vd-dim 等硬编码 9/12/7/5px 圆角,非 --r-sm(11)/--r(15)/--r-pill token。
- **Why:** token 债;与系统圆角体系不一致。来自 /design-review 子代理 #1。本轮未改因强行对齐会改变面板紧凑观感(视觉回归风险)。
- **Context:** 若做 T-TTS-PANEL-SHEET-DEDUP 则一并解决(重构到 .ss-* 自带 token)。
- **Priority:** P3  **Depends on:** 可并入 T-TTS-PANEL-SHEET-DEDUP
