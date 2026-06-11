# 租户品牌自定义 — 落地页 / 侧边栏 Logo 与名称

## 目标

租户管理员可在「系统设置」自定义机构 **Logo** 与 **名称**,即时反映在:
1. 登录后左侧菜单顶部(侧边栏 `.sb-brand`)
2. 公开落地页顶栏与页脚(`landing.html`),按 URL 识别租户

## 现状(已建部分 — 不要重写)

| 层 | 已存在 | 文件:行 |
|----|--------|---------|
| DB | `tenant.name`、`tenant_setting` 表、`org_logo_key` 设置项 | `src/db/index.ts:33`, `:98` |
| API 读 | `GET /settings` 返回 `orgName`+`orgLogoKey`;`/me` 返回 `tenantName`+`orgLogoKey` | `src/api/settings.ts:64`, `src/auth/index.ts:307` |
| API 写 | `POST /settings/logo`(admin,PNG/JPEG/WEBP,5MB,拒 SVG 防 XSS) | `src/api/settings.ts:114` |
| 公开图 | `GET /org-logo/:tenantId` 直出字节,onerror 回退默认 | `src/api/settings.ts:138` |
| 侧边栏 | `shell.js` 已用 `u.orgLogoKey` 换 logo mark | `prototype/shell.js:168` |
| 设置 UI | logo 上传控件已存在 | `prototype/settings.html:18,64` |

## 三个真实缺口

### 缺口 1 — 解锁机构名称可改(后端)

`src/api/settings.ts:89-91` 当前把 `orgName` 硬锁只读(返回 `ORG_NAME_READONLY`)。
**改为**:admin 可改 `tenant.name`。

- 校验(已决):**新增独立 `sanitizeOrgName`**(不复用 `sanitizeLabelText` —— 那是为 ffmpeg drawtext 调的,限 20 字、白名单会误删品牌名里的 `&()`,且不解决 HTML 渲染的 XSS)。规则:`trim()` + 限 30 字 + 允许中英数字、空格、`·-—&()`,剔控制字符。
- **XSS 防护(已决)**:渲染端(shell.js / landing.html)用 `textContent` 或现有 `esc()` 注入名称,**不用 innerHTML**(威胁模型 = HTML 文本注入,非 ffmpeg)。
- 写库:`UPDATE tenant SET name=? WHERE id=?`(名称在 `tenant` 表,不在 `tenant_setting`)。
- 审计(已决,外部评审修正):`name` 存在 `tenant` 表(非 `tenant_setting`)。**不参数化共享的 `applyIfChanged`**(3 个设置依赖它,为单字段改它 blast radius 大于收益)。改为 **name 单独内联 diff**:读旧 `tenant.name` → 若变则 `UPDATE tenant SET name` + push 一条 `{field:'name',old,new}` 进同一 `diff[]` 数组 → 同一 `audit(req,'update_settings',...,diff)` 路径。同审计出口,最小 diff。
- **只移除 orgName 只读拦截,保留 delivery 拦截**:`PUT /settings`(settings.ts:85-91)同时硬拦 `delivery` 和 `orgName`;T1 只删 orgName 那段(89-91),delivery 只读必须留(防误改能力网关)。
- 名称变更连带影响(必须在 PR 描述里点明,**不在本功能改**):成员列表、审计、计费归属处显示的机构名会同步变。这是预期行为(名称是单一真相源)。

### 缺口 2 — 侧边栏顶部渲染自定义名称(前端)

`prototype/shell.js:67` 名称硬编码 `Lingjing` / `灵镜`。
`bindAuth()`(`shell.js:168`)已换 logo,但**没换名称文本**。
**改为**:`bindAuth` 据 `u.isCustomBranded` 决定是否替换 `.sb-brand` 内的 `.nm`/`.cjk` 文本。

- **品牌哨兵(已决,外部评审修正)**:不靠字符串比 `我的机构`。`auth/index.ts:313` 的 `t?.name || '我的机构'` 是 NULL 回退**值**,非存储哨兵——真叫「我的机构」的租户会被误判。**`/me` 新增显式 `isCustomBranded` 布尔**(后端据「`tenant.name` 是否被用户设过 / `org_logo_key` 是否存在」判定),前端只读布尔,不复制魔术串。
- 单名称模型:自定义后**只显示一行**租户名(`.nm` = 租户名 via `textContent` 防 XSS,`.cjk` 隐藏)。
- 默认态(`isCustomBranded=false`)→ 保留原生 `Lingjing 灵镜`。
- **FOUC**:`.sb-brand` 同步渲默认名,`bindAuth` 异步换名会闪一下。可接受(同 logo 现状),但状态表已补记。
- logo:`bindAuth` 拼 `/api/org-logo/<id>?v=<ver>`(ver 来自 `/me` 的 logo 版本戳),改名/恢复后立即生效,不显 5 分钟旧图。onerror 回退默认 SVG。
- 折叠态(≤1000px 侧边栏收窄):名称 `<span>` 隐藏,只剩 logo mark — 现有 CSS 已处理。

### 缺口 3 — 落地页按 URL 识别租户并渲染品牌(前端 + 路由)

`landing.html` 是登录前公开页,无租户上下文。**按查询串识别**(外部评审修正):
- **查询串式(已决,替代原 `/t/:slug`)**:`/landing.html?org=<slug>`。
  - 原 `/t/:slug` 路径式如现写是**坏的**:Caddyfile 是透明 `reverse_proxy app:9372`(不做 path 路由),Express 无 `/t/*` 路由(落到 static → 404),且 `landing.html` 用**相对路径**加载 `app.css`(`landing.html:7`)——即使强路由 `/t/acme` 也会请求 `/t/app.css` → 无样式。
  - 查询串方案:页仍服务在 `/landing.html`(相对资产不破)、无需改 Caddy、无需新 Express 路由。只需 landing JS 从 `location.search` 读 `org` slug。三个 feasibility bug 一次性消除。
  - `/t/:slug` 美观路径 + 子域名留 `T-BRAND-SUBDOMAIN` 后续(届时同一 slug 解析换入口)。
- 新增公开端点:`GET /api/public-brand/:slug` → `{ tenantId, name, hasLogo }`(无敏感字段;查 `tenant` by slug + `org_logo_key` 是否存在)。挂在 `attachUser` 之后但**不加 requireAuth**(同 captchaRouter 的公开模式,server.ts:46);logo 仍走现有 `/org-logo/:tenantId`(拿到 tenantId 后拼)。
- `tenant` 表新增 `slug` 列(唯一)。**slug = 随机不可猜短串**(8 位 base62),防枚举发现「哪些机构用了平台 + 机构名」(政企/融媒隐私)。链接由平台/管理员主动分发,不做可读 slug。
- **迁移(已决)**:用现有 `addColumnIfMissing('tenant','slug',...)`(db/index.ts:234 幂等模式)加列;加列后跑一次性回填,给每个现有租户生成随机 slug(类似 max_creator_seats 的 `!tenantHadSeats` 一次性迁移)。slug 唯一索引。
- landing 顶栏/页脚的 logo+名称:若 `?org=<slug>` 合法 → fetch public-brand,替换 logo(`/api/org-logo/:tenantId?v=<ver>`)与名称(用 `textContent`);否则保留平台默认 `灵镜 Lingjing`。
- **裸访问 `landing.html`(无 slug)= 平台官网**,显示灵镜自有品牌。这是预期,不是 bug。
- **换皮深度(已决,MVP)**:只换品牌锁位(顶栏 `.logo` + 页脚 `.cp`)的 Logo 与名称;hero/正文保留平台通用文案。为消除「顶部 acme、正文灵镜」的认知冲突,租户态下在顶栏品牌旁(或 hero eyebrow 处)加一句轻量归属:「由 <租户名> 为您提供」,页脚保留「Powered by 灵镜」。这条归属是信任设计的关键,不可省。
- hero 标题/副文 / 自定义 hero 文案 = 明确不做(超出 Logo+名称 范围,见「不做」)。

## UI 设计(系统设置 — 机构品牌卡)

匹配现有暗色设计系统(`prototype/app.css`:`--modal #161618`、`--line #232327`、`--t1/t2/t3`、圆角卡、胶囊按钮)。

**卡位置(已决)**:升级现有「机构信息」卡(`settings.html:16`)为「机构品牌」,**置顶**(设置页第一块)。不新增卡。机构隔离说明文案保留为卡内副标题。

「机构信息」卡升级为「机构品牌」:

```
┌─ 机构品牌 ─────────────────────────────────────────────┐
│ 自定义落地页与侧边栏顶部显示的 Logo 与名称(仅管理员)        │
│                                                          │
│ 机构名称                                  实时预览          │
│ ┌────────────────────────┐  12/30        ┌───────────┐  │
│ │ 杭州融媒体中心            │               │ ◐ 杭州融媒 │  │  ← 侧边栏顶部样子
│ └────────────────────────┘               │   体中心   │  │
│                                            └───────────┘  │
│ 机构 Logo                                                 │
│ ┌────┐  [更换 Logo]  恢复默认                              │
│ │ ◐  │  PNG / JPEG / WEBP,≤5MB                          │
│ └────┘                                                    │
│                                                          │
│                              [保存名称]                    │
└──────────────────────────────────────────────────────────┘
```

设计要点:
- **双列**:左编辑、右实时预览(预览即所见 — 直接渲染侧边栏顶部片段,所改即所见)。
- 名称:输入框 + 字符计数(0/30),空值禁用保存 + 行内提示「名称不能为空」。
- Logo:64px 圆角预览缩略图 + 「更换 Logo」胶囊按钮 + 「恢复默认」弱化文字链。
- 「恢复默认」:`LJConfirm` 二次确认 → 清 `org_logo_key`(新增 `DELETE /settings/logo`)→ 预览回退默认 SVG。
- 非 admin:整卡只读,控件禁用,沿用现有 `guard()` + 「仅管理员可修改」toast。
- 保存反馈:沿用 `LJToast('✓ 机构名称已更新')`。
- Logo 上传成功 → 预览立即刷新(现有 `?t=Date.now()` 破缓存已做)。

## 状态覆盖(逐一指定)

| 状态 | 设计 |
|------|------|
| 首次(未设)| 名称 = 平台默认 / logo = 默认 SVG。预览显示默认锁版,提示「使用平台默认品牌」 |
| 编辑中未保存 | 输入框聚焦高亮;预览随输入实时更新(防抖 200ms);「保存」按钮高亮可点 |
| 名称空 | 保存禁用 + 行内 amber「名称不能为空」 |
| 名称超长 | 30 字截断 + 计数变 amber |
| 名称非法字符 | 白名单过滤,行内提示「已移除不支持的字符」 |
| Logo 上传中 | 缩略图蒙层 + spinner;按钮 disabled「上传中…」 |
| Logo 超 5MB | 红字「Logo 超过 5MB 上限」(后端已返回) |
| Logo 非位图 | 红字「仅支持 PNG / JPEG / WEBP」(后端已返回) |
| Logo 存储失败 | 红字「Logo 存储失败,请稍后重试」(后端 502) |
| 恢复默认 | 二次确认 → 清除 → 预览回默认 + toast「✓ 已恢复默认品牌」 |
| 落地页无 slug | 平台默认品牌(灵镜) |
| 落地页 slug 不存在 | 静默回退平台默认(不报错给匿名访客) |
| 落地页 logo 取不到 | onerror 回退默认 SVG |
| viewer/creator | 设置卡只读 |

## 响应式

- 设置卡双列 → ≤768px 单列堆叠,预览移到名称下方。
- 侧边栏折叠态(≤1000px):仅 logo mark,名称 span 隐藏(现有 CSS)。
- 落地页顶栏:移动端 logo+名称缩放,现有 `.lp-nav` 响应式沿用。

## 无障碍

- logo 预览 `<img alt>` = 机构名称。
- 名称输入 `<label for>` 关联;计数 `aria-live="polite"`。
- 「恢复默认」是按钮非纯链接(键盘可达,44px 触达)。
- 上传按钮触发隐藏 file input,保持键盘可触发。

## 测试要求(vitest，全覆盖)

新增 `test/settings-branding.test.ts`(复用 `settings-audit-diff.test.ts` / `rbac-tenancy.test.ts` 模式)+ slug 迁移测试。逐路径:

- `sanitizeOrgName`:空、trim、30 字截断、保留 `中英数字·-—&()`、剔控制字符、剥 `<script>` XSS payload。
- `PUT /settings`(name):admin+合法 → `UPDATE tenant` + 审计 diff;名称未变 → 无审计行;**[回归 R1]** 不再返回 400 `ORG_NAME_READONLY`(防未来 revert 静默重锁)。
- `PUT /settings`(name)RBAC:creator/viewer → 403。
- `DELETE /settings/logo`:admin → 清 `org_logo_key` + 审计;non-admin → 403;删后 `/org-logo/:id` → 404。
- `GET /api/public-brand/:slug`:合法 → `{tenantId,name,hasLogo}`;未知 slug → 404 不泄露;匿名无 cookie → 200(公开)。
- **[回归 R2]** slug 迁移:现有租户全部回填**唯一**随机 slug(否则 `/t/:slug` 对老客户全 404,功能静默失效 —— 同 max_creator_seats clamp 教训 db/index.ts:268);重跑 `addColumnIfMissing` 幂等不重复回填;slug 唯一约束。
- 租户隔离:A 租户 admin 不能改 B 租户品牌(沿用 rbac-tenancy 模式)。

前端(`shell.js`/`landing.html`)无 JS 单测框架 → 走 `/qa` 手测(同 prototype 其余前端)。

## 失败模式(每条新路径)

| 路径 | 生产失败方式 | 有测试? | 有错误处理? | 用户可见? |
|------|-------------|---------|------------|-----------|
| slug 迁移未回填 | 老租户 `/t/slug` 全 404 | R2 强制 | 静默回退平台默认 | 否(静默) → R2 兜住 |
| public-brand 存储读 logo 失败 | `/org-logo` 502/404 | 是 | onerror 回退默认 SVG | 否(优雅降级) |
| 名称 XSS 未转义 | 侧边栏/落地页注入脚本 | 是(sanitize+textContent) | 双层(后端剥+前端 textContent) | 否(被防住) |
| 名称写并发(两标签同存) | 后写覆盖先写 | — | last-write-wins(可接受,单字段) | 是(看到最后值) |

无「无测试 AND 无错误处理 AND 静默」的关键缺口 —— R2 把唯一静默风险兜住。

## 已解决的设计决策

| 决策 | 结论 |
|------|------|
| 品牌卡位置 | 升级现有「机构信息」卡为「机构品牌」,置顶 |
| 落地页换皮深度 | 仅顶栏/页脚 Logo+名称;加「由 X 为您提供 / Powered by 灵镜」归属 |
| 名称可改性 | 解锁 `tenant.name` 本身可改(单一真相源) |
| 落地页租户识别 | **查询串 `/landing.html?org=<slug>`**(原 `/t/:slug` 路由坏:Caddy 透明代理 + 无 Express 路由 + 相对资产破);路径式/子域名留后续 |
| slug 形态 | 随机不可猜 8 位 base62(防枚举机构名);平台/管理员分发链接 |
| 品牌哨兵 | `/me` 返回显式 `isCustomBranded` 布尔(不字符串比 `我的机构`) |
| name 审计写法 | 单独内联 diff(不参数化共享 `applyIfChanged`);只删 orgName 拦截留 delivery |
| Logo 缓存 | URL 拼 `?v=<版本戳>`(改名/恢复立即生效,不显 5 分钟旧图) |
| 孤儿 logo 回收 | 记 TODO(T-BRAND-LOGO-GC),不在本 PR(storage 无 deleteObject) |
| 实时预览时机 | 随输入实时变(草稿预览,防抖 200ms);Logo 预览在上传成功后变 |
| Logo 双版本 | 不做 |
| 恢复默认 | 做(`DELETE /settings/logo` + 二次确认) |

## 不做(明确划界)

- 子域名识别(需泛域名证书)— 留后续。
- 深/浅双版本 Logo — 用户已确认不做。
- 自定义主题色/字体 — 超出本次范围。
- 自定义 favicon — 超出本次范围(可作后续)。
- 子域名识别(`acme.lingjing.com`)— 已记 TODOS.md(T-BRAND-SUBDOMAIN)。

## What already exists(复用,勿重写)

- 暗色设计系统:`prototype/app.css` 的 CSS 变量(`--modal/--line/--t1-3`、胶囊按钮、圆角卡)。
- 共享组件:`LJToast`、`LJConfirm`、`LJPrompt`(shell.js)。
- Logo 上传后端:`POST /settings/logo`(admin、位图、5MB、拒 SVG)+ 公开读 `GET /org-logo/:tenantId`。
- 侧边栏 logo 替换逻辑:`shell.js:168` `bindAuth()` 已用 `u.orgLogoKey` 换 logo mark(含 onerror 回退)。
- `/me` 已返回 `tenantName`、`orgLogoKey`、`tenantId`(`src/auth/index.ts:307`)。**本次新增 `isCustomBranded`(布尔)与 logo 版本戳**(供 shell.js 判品牌态 + 拼 `?v=`)。
- 设置页字段级审计 diff 模式:`applyIfChanged`(settings.ts:97)。
- 无 DESIGN.md,但 app.css 是事实上的设计系统真相源。

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~1h / CC: ~15min)** — backend/settings — 解锁机构名称可改
  - Surfaced by: 缺口 1 — settings.ts:89-91 当前硬锁 `ORG_NAME_READONLY`
  - Files: `src/api/settings.ts`
  - 内容:`PUT /settings` 接受 `orgName`(1–30 字、白名单过滤、`UPDATE tenant SET name`)、字段级审计、移除只读拦截。
  - Verify:admin 改名后 `GET /settings` 与 `/me` 返回新名;非 admin 仍 403。

- [ ] **T2 (P1, human: ~1h / CC: ~12min, 依赖 T1 + /me 改造)** — frontend/shell + auth — 侧边栏渲染自定义名称 + 品牌哨兵
  - Surfaced by: 缺口 2 + 外部评审(默认哨兵 + FOUC + logo 缓存)
  - Files: `prototype/shell.js`、`src/auth/index.ts`(/me 加 `isCustomBranded` + logo 版本戳)
  - 内容:`/me` 加 `isCustomBranded`(后端据 name 被设过/logo 存在判定)+ 版本戳;`bindAuth` 据布尔换 `.nm`(textContent)、隐 `.cjk`、logo 拼 `?v=`。默认保留 `Lingjing 灵镜`。
  - Verify:自定义租户登录显其名;真名「我的机构」的租户不被误判;改 logo 后侧边栏即时更新。

- [ ] **T3 (P1, human: ~3h / CC: ~25min)** — settings UI — 机构品牌卡(名称编辑+Logo+实时预览+恢复默认)
  - Surfaced by: Pass 1/7 — 卡置顶、草稿实时预览、恢复默认
  - Files: `prototype/settings.html`
  - 内容:升级机构信息卡为机构品牌(置顶);名称输入+计数+空值禁存;右侧实时预览侧边栏片段(防抖 200ms 草稿态);恢复默认(LJConfirm→DELETE)。状态覆盖见状态表。
  - Verify:逐项过状态表(空/超长/非法/上传中/超限/恢复默认)。

- [ ] **T4 (P1, human: ~30min / CC: ~10min)** — backend/settings — 恢复默认 Logo 端点
  - Surfaced by: 缺口 3(恢复默认决策)
  - Files: `src/api/settings.ts`
  - 内容:`DELETE /settings/logo`(admin)清 `org_logo_key` + 审计。
  - Verify:删后 `/org-logo/:tenantId` 返 404,前端回退默认 SVG。

- [ ] **T5 (P1, human: ~3h / CC: ~25min)** — landing + db — 落地页按 `?org=<slug>` 识别租户并换品牌
  - Surfaced by: 缺口 3 + Pass 3(归属信任)+ 外部评审(路由修正,去 Caddy/路径式)
  - Files: `src/db/index.ts`(`addColumnIfMissing tenant.slug` 唯一 + 回填随机 slug)、`src/api/settings.ts`(`GET /api/public-brand/:slug` 返 `{tenantId,name,hasLogo}`)、`prototype/landing.html`(JS 读 `?org=`)
  - 内容:随机 slug 列+迁移回填;公开品牌端点(无 requireAuth);landing JS 从 `location.search` 读 slug → fetch → 换 logo(`?v=`)+名称(textContent)+「由 X 为您提供」;无/非法 slug 静默回退灵镜。**不动 Caddyfile**。
  - Verify:`/landing.html?org=<slug>` 显该租户品牌+归属;未知 slug 与裸 landing 显灵镜默认;相对资产正常加载。

- [ ] **R1+R2 (P1, 强制回归)** — tests — 名称解锁回归 + slug 迁移回归
  - Surfaced by: Test review IRON RULE
  - Files: `test/settings-branding.test.ts`、slug 迁移测试
  - 内容:R1 断言 `orgName` 不再 400 `ORG_NAME_READONLY` 且写生效;R2 断言现有租户迁移后全部有唯一 slug。

_No new tasks from Pass 4 (slop), Pass 5 (design system), Pass 6 (responsive) — covered within T3/T5._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | outside voice (Claude subagent): 6 substantive, all folded |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 8 issues, 0 critical gaps, 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score: 7/10 → 9/10, 7 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** Codex returned empty → Claude subagent ran the outside voice. It caught 3 load-bearing items the primary review missed: `/t/:slug` routing infeasible through transparent Caddy + relative assets (→ switched to `?org=slug`), no real brand sentinel (→ `/me.isCustomBranded`), and logo cache staleness (→ `?v=` version stamp). User accepted all 4 tensions; one reversed my own `applyIfChanged` recommendation (→ inline diff).
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement. 6 P1 task groups (T1–T5 + R1/R2 regressions), full vitest backend coverage, frontend → /qa.

NO UNRESOLVED DECISIONS
