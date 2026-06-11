# 探索页（explore.html）设计方案 — /plan-design-review

> 灵镜 LINGJING · 融媒体数字人内容平台
> 评审日期：2026-06-11 · 设计稿：`~/.gstack/projects/prototype/designs/explore-page-20260611/explore-mockup.html`
> 设计系统：`app.css` v3 —「Silent Precision Instrument」(静默的精密器械)

## 这页是什么

`explore.html` 不是工具启动器 —— 它是**登录后的主界面**：侧栏品牌 logo 指向它（`shell.js` `sb-brand href="explore.html"`），viewer 角色无创作权限时也被打回这里（`shell.js:244`）。当前线上版本是 5KB 的占位：一段 hero + 9 个工具卡平铺，没有发现、没有灵感、没有社会证明。

**定位**（已与用户确认）：灵感发现首页。先「看见好内容是怎么生成的」，再一键开始。聚合系统里已散落的发现内容，而不是再造一套。

## 信息架构（最终）

```
┌─────────────────────────────────────────────────────────────┐
│ 1. HERO 带  (grid 1.5 : 0.9)                                 │
│   ┌──────────────────────────┐ ┌─────────────────────────┐  │
│   │ LINGJING · 灵镜           │ │ ◈ 剩余点数               │  │
│   │ 看见好内容，是怎么生成的   │ │ 8,240  (Space Mono)     │  │
│   │ 一句副文案                 │ │ ── 作品 形象 音色 ──     │  │
│   │ [开始创作] [我的作品]      │ │                          │  │
│   └──────────────────────────┘ └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│ 2. 看见可能 — 案例展示墙（横向 9:16，hover/常驻播放）  ← 视觉锚点 │
│   [新闻播报][政策解读][出镜报道][财经][宣传片][教育] →        │
├─────────────────────────────────────────────────────────────┤
│ 3. 一键开始 — 4 张模板/预置卡（聚合散落的发现内容）           │
│   [新闻播报脚本][政策解读模板][演播室配图][片头背景乐]        │
├─────────────────────────────────────────────────────────────┤
│ 4. 创作工具 — auto-fill 网格（tools.js 驱动，即将上线角标）   │
├─────────────────────────────────────────────────────────────┤
│ 5. 最近作品 — /jobs 真实作品做社会证明（状态徽标 Space Mono）  │
└─────────────────────────────────────────────────────────────┘
```

**扫描层级**：Hero（定位+行动）→ 展示墙（灵感，第一眼）→ 一键开始（起步）→ 工具（导航）→ 最近作品（继续）。每个区块一个职责。

**约束取舍（constraint worship）**：若只能留 3 块，是 ① 展示墙 ② 一键开始 ③ 工具网格 —— 看见、起步、导航。Hero 与最近作品是增强。

## 数据来源（混合，已确认）

| 区块 | 来源 | 备注 |
|------|------|------|
| Hero 点数/统计 | `/me`、`/credits/balance`、`/jobs`/`/avatars`/`/voices` 计数 | 真实 |
| 案例展示墙 | 精选样例（占位视频/图 + 元数据常量） | 演示用，复用 landing.html `.demo` 范式 |
| 一键开始 | 聚合 create.html 案例灵感、ai-image 示例提示词、ai-music 风格 chip | 真实内容，常量化 |
| 创作工具 | `tools.js` 注册表 | 真实，`enabled` 决定即将上线态 |
| 最近作品 | `/jobs`（取前 6） | 真实 |

## 设计决策（本次评审确认）

### D1 — 轻度角色/状态自适应（Pass 1）
同一套布局，区块随角色与数据自适应，三种人都不会看到错位界面：

```
角色/状态          | Hero 主按钮      | 一键开始     | 最近作品
-------------------|----------------|-------------|------------------
新用户(零作品)      | 开始创作        | 显示(主推)   | 替换为「从模板开始」引导
老用户(有作品)      | 开始创作        | 显示        | 真实 /jobs，最近在进行的上提
viewer(无创作权)    | 隐藏「开始创作」 | 隐藏        | 仅浏览展示墙 + 最近作品(只读)
                   | 仅留「我的作品」 |             |
```

判定：`LJ.me().role`（admin/creator/viewer）+ `/jobs` 长度。沿用 dashboard.html 已有的 `ROLE_CN` 与 `data-requires-create` 约定。

### D2 — 全状态覆盖（Pass 2）

| 区块/FEATURE | LOADING | EMPTY | ERROR | SUCCESS |
|------|------|------|------|------|
| Hero 点数 | `—` 占位（沿用 dashboard `.skel`） | n/a | 静默退 `—`，不报错 | 数字 + Space Mono；低余额 `.low` 琥珀色 + 警示 |
| Hero 统计(作品/形象/音色) | `—` 骨架 | `0` | 静默退 `0` | 真实计数 |
| 案例展示墙 | 6 张骨架卡（脉冲） | n/a（常量，恒有） | n/a | 横向卡，hover/常驻播放 |
| 一键开始 | n/a（常量即时渲染） | n/a | n/a | 4 卡 |
| 创作工具 | 「加载工具中…」(沿用现版) | n/a | 工具表本地常量，恒有 | auto-fill 卡 |
| 最近作品 | 4 张 4:3 骨架卡 | **零作品**：暖文案「你的第一条作品会出现在这里」+ 主行动「从模板开始 →」(非冷冰冰「暂无作品」) | 「作品加载失败，点此重试 ↻」内联可点 | 真实 /jobs 卡 + 状态徽标 |

**空状态是功能**：最近作品零作品态不写「暂无作品」，而是温度文案 + 指向一键开始的主行动，把空页变成起步引导。

### D3 — 完整 a11y + 触屏（Pass 6）
- 播放按钮：`<div>` → `<button aria-label="播放 {标题}">`，可聚焦、可回车触发。
- 案例卡：整卡 `role="button"` + `tabindex="0"` + 键盘 `Enter/Space` 触发弹窗；可见 `:focus-visible` 描边（`--blue` 2px）。
- 触屏：展示墙播放按钮在 `(hover:none)` 媒介下**常驻显示**，不依赖 hover 才出现。
- 触点：所有可点元素 ≥ 44×44px（卡片本身满足；一键开始卡 padding 已够）。
- Landmark：展示墙/一键开始/工具/最近作品各用 `<section aria-label="…">`；横向滚动区 `role="region" aria-label="案例展示" tabindex="0"` 使键盘可滚。
- 对比度：正文 ≥ 16px 或符合 `--t2 #ABABB2` on `--card #161618`（达 4.5:1）；元数据用 Space Mono 但不低于 11px 且仅用于非关键信息。
- 减少动效：`@media (prefers-reduced-motion: reduce)` 关闭 `rise`/hover transform。

### D4 — 案例卡点击：弹窗播放 + 「用此模板」（Pass 7）
点击/回车案例卡 → 弹出播放器（复用 app.css `.modal`/`--sh-pop` 范式）看样片视频，弹窗底部一个主按钮「用这个模板创作」→ 跳到对应工具页并带场景预填（如 `create.html?template=news` 或 `ai-image.html?prompt=…`）。把「看见」直接连到「开始」。

**展示墙数据模型**（每条案例常量）：
```js
{ id, title, sub, tag, ratio, posterUrl, sampleVideoUrl, toolKey, prefill }
```
`toolKey` 映射 tools.js；`prefill` 决定跳转参数。

## 新增组件（设计系统词汇）

| 组件 | 说明 | 是否新 |
|------|------|------|
| `.demo`(展示墙卡) | 复用 landing.html，9:16 + hover-play + tag | 复用 |
| `.start`(一键开始卡) | 小卡 + 蓝底 icon + 标题 + 来源 kind 标签 | **新**，沿用既有 radii/shadow/hover-lift，融入词汇 |
| `.tool-card` | 复用现 explore.html | 复用 |
| `.rcard`(最近作品) | 复用 dashboard.html | 复用 |
| `.hero-side`(点数+统计侧卡) | 复用 dashboard.html `.credit`/`.stat` 拼接 | 复用 |

## 评分（评审前 → 评审后）

| Pass | 维度 | 前 | 后 |
|------|------|----|----|
| 1 | 信息架构 | 8 | 10 |
| 2 | 交互状态 | 6 | 9 |
| 3 | 用户旅程 | 8 | 9 |
| 4 | AI Slop 风险 | 9 | 9 |
| 5 | 设计系统对齐 | 9 | 10 |
| 6 | 响应式/无障碍 | 5 | 9 |
| 7 | 未决决策 | — | 4 项已决 |
| **总分** | | **3** | **9** |

AI Slop 检查：无紫色渐变、无对称三栏 icon-circle 特性墙、非全居中、radii 分级、无装饰 blob/emoji、无彩色左边框、真实字体（Noto/Manrope/Space Mono）、product-specific 文案。**无硬拒绝。** Litmus 7 项全 YES。

## 响应式断点

| 视口 | 布局 |
|------|------|
| ≥ 880px | Hero 1.5:0.9 双栏；工具 auto-fill ≥230px；展示墙横滚 |
| 560–880px | Hero 单栏堆叠；一键开始 2 栏；工具 2 栏；展示墙横滚（卡略缩） |
| < 560px | 全单栏；展示墙保持横滚（移动端原生手势）；播放按钮常驻 |

## NOT in scope（明确不做）

- **作品社区/UGC 发布流**：展示墙用精选样例，不做用户作品公开广场（需审核/隐私机制，另立 scope）。
- **个性化推荐算法**：一键开始用固定精选，不做基于历史的智能推荐（数据量不足，过早优化）。
- **展示墙真实视频生产**：本期用占位/示例视频，真实样片由运营后续补素材。
- **搜索/筛选**：探索页不加搜索框（发现靠编排，不靠搜索；搜索属 works.html/assets.html 职责，clarity over feature bloat）。
- **dashboard.html 合并**：探索与概览暂保持两页（概览偏数据看板，探索偏发现），不在本期合并。

## What already exists（应复用）

- **设计系统**：`app.css` v3 全套 token（黑阶、描边、文字阶、`--sh-card`/`--sh-pop`、`--ease`/`--ease-out`、`rise`/`rv` 动画）。
- **`.demo` 展示墙范式**：landing.html `.marquee`/`.demo` 直接可搬（hover-play、tag、veil）。
- **卡片范式**：`.rcard`(dashboard)、`.tool-card`(现 explore)、`.acard`/`.fitem`(assets/各工具)。
- **`tools.js`**：工具注册表唯一真源，含 enabled/badge/page/icon。
- **`shell.js` + api.js**：壳、`LJ.me()`/`LJ.get()`、401 跳登录。
- **发现内容**：create.html 4 条案例灵感脚本、ai-image 4 张示例提示词、ai-music 14 风格 chip、6 预置形象、N 预置音色。

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [x] **T1 (P1)** — explore.html — 重写探索页为 5 区块灵感发现首页 ✅ 已落地
  - Surfaced by: Pass 1 信息架构 — 现版仅工具平铺，缺 Hero/展示墙/一键开始/最近作品
- [x] **T2 (P1)** — explore.html — 案例展示墙 + 弹窗播放 + 「用此模板」(D4) ✅ 已落地
  - `SHOWCASE` 常量 + `.ex-ov`/`.player` 弹窗，`prefill`/`toolKey` 驱动跳转
- [x] **T3 (P1)** — explore.html — 全状态覆盖（加载/空/错误，D2）✅ 已落地
  - `renderRecentEmpty`(暖文案+主行动)/`renderRecentErr`(内联重试)/骨架卡/点数 `—` 兜底
- [x] **T4 (P1)** — explore.html — 完整 a11y + 触屏（D3）✅ 已落地
  - 真 `<button aria-label>`、卡 `role+tabindex+Enter/Space`、`:focus-visible`、`(hover:none)` 常驻播放、`prefers-reduced-motion`、`<section aria-label>` landmark
- [x] **T5 (P2)** — explore.html — 轻度角色/状态自适应（D1）✅ 已落地
  - `data-requires-create`(viewer 隐藏开始创作/一键开始)、`__ljRole` 判定零作品引导文案
- [x] **T6 (P2)** — explore.html — 一键开始内容聚合 ✅ 已落地
  - `STARTS` 常量聚合 news/policy 模板、ai-image sample、ai-music style，带预填参数

**状态**：全部 6 项已实现于 `prototype/explore.html`（LOW risk，detect_changes 零受影响流程）。后续待真实后端验证：模板/示例预填参数（`?template=`/`?sample=`/`?style=`）需对应工具页接收端实现；展示墙 `sampleVideoUrl` 待运营补样片。

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| 探索页全页 | `~/.gstack/projects/prototype/designs/explore-page-20260611/explore-mockup.html` | 灵感发现首页：Hero + 案例展示墙 + 一键开始 + 工具网格 + 最近作品，全程 app.css v3 token | PNG 生成器不可用(OpenAI key 401)，改用真实 app.css 的 HTML 设计稿——对本项目保真度更高。落地时按 D1–D4 补状态/a11y/自适应/弹窗 |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | score: 3/10 → 9/10, 4 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** DESIGN REVIEW CLEARED (9/10) — 4 design decisions resolved (D1 角色自适应 / D2 全状态 / D3 a11y+触屏 / D4 弹窗+用此模板). Eng Review required before shipping.

NO UNRESOLVED DECISIONS
