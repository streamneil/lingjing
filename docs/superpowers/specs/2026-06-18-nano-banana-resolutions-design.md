# Nano Banana 分辨率/比例支持设计

日期:2026-06-18
状态:已确认,待实现

## 背景与目标

两个 Nano Banana 模型(`gemini-3.1-flash-image` = Nano Banana 2、`gemini-3-pro-image` = Nano Banana Pro)在 AI图片(text2img)和 AI图片编辑器(img2img)两页**目前没有比例选择器**:它们 `sizeKind:'keyword'`,`/image-models` 对 keyword 模型吐 `ratios:[]`,前端据此**隐藏比例控件**(该语义是为万相「输出比例随输入图」设计的,对 Gemini 是误伤)。用户只能选清晰度档(1K/2K/4K),选不了比例。

目标(用户确认):**比例 + 清晰度都开放**,按文档:
- **Nano Banana 2 (3.1 Flash)**:14 个比例(含极端 1:4 / 4:1 / 1:8 / 8:1),4 个清晰度档 **512 / 1K / 2K / 4K**。
- **Nano Banana Pro (3 Pro)**:10 个比例,3 个清晰度档 **1K / 2K / 4K**。
- 极端比例全显(按文档)。

## 关键技术事实

1. **Gemini API 用关键字,不吃显式 W×H**:调用发 `generationConfig.imageConfig.{aspectRatio,imageSize}`(如 `"16:9"` + `"2K"`)。用户给的像素表是 Gemini 各(比例×档)的**输出尺寸**,用于前端尺寸预览,不用于 API 入参。
2. **Gemini 网关已就绪**:`gemini.ts` 直接从 `input.ratio` / `input.resolution` 取值发 `aspectRatio` / `imageSize`(`imageSize` 仅 `gemini-3*` 发,两模型都满足)。**网关无需改动**。
3. **机制(plan-eng-review 改定:轻量 `ratios?: string[]`,不用 pixelMatrix)**:
   - 原方案复用 `pixelMatrix`(tier→ratio→"W*H")。但 Gemini 关键字 API **从不需要 W×H**,填 14×4/10×3 像素表是幽灵数据,且 `/image-models` 从「首档 ratio 键」派生比例列表对 Flash 是 '512' 档 → 各档比例键不一致时静默偏(eng-review 架构发现 1 + 外部声音 HIGH,跨模型一致)。
   - 改为给 `ImageModelDef` 加 `ratios?: string[]` 字段;`/image-models` 派生改为 `d.ratios ?? (d.pixelMatrix ? 首档键 : (sizeKind==='keyword' ? [] : undefined))`。Gemini 只给比例字符串数组 + `resolutionTiers`,零幽灵像素。
   - 顺手消除:首档键派生的脆弱性、512 死档(像素表里那一档无人读)。代码更少(~10 行 vs ~90)。
   - 网关仍发 `aspectRatio`+`imageSize` 关键字(`gemini.ts` 零改动);`sizeParams`/`whSize` 只在 `sizeKind:'wh'` 触发,Gemini 是 `keyword` 且网关不调 `sizeParams` → 比例/清晰度发送路径不变。
4. **清晰度档不被 `pixelMatrix` 隐藏**:`renderRes` 仅在 `canSetSize===false` 或有 `resolutions` 表时隐藏;`pixelMatrix` 模型(如 z-image)清晰度照显。档集由 `resolutionTiers` 驱动。
5. **512 档**:`resolutionTiers` 含 `'512'`,`pixelMatrix` 顶层键含 `'512'`。`RES_ORDER` 当前无 512,但 `renderRes` 有 `resolutionTiers` 时走精确档集分支(不读 RES_ORDER 上限),故 512 能正常出现并选中。`imageSize` 透传 `'512'`(Gemini 文档:512 档不带 K 后缀,大写其余档)——需确认网关对 '512' 不强行 `.toUpperCase()` 误伤(512 无字母,toUpperCase 无害)。

## 改动清单

### 1. `src/gateway/image-models.ts` — 加 `ratios?: string[]` 字段 + 两个 Gemini 条目配 `ratios` + `resolutionTiers`

(a) `ImageModelDef` 接口加可选字段 `ratios?: string[]`(该模型暴露的比例集;缺省 → 派生回落)。

(b) 两条目(比例/清晰度均按官方文档,全可配):
- `gemini-3.1-flash-image`:`ratios: ['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9']`(14)、`resolutionTiers: ['512','1K','2K','4K']`、`maxResolution: '4K'`(不变)、`sizeKind:'keyword'`(不变)。
- `gemini-3-pro-image`:`ratios: ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9']`(10)、`resolutionTiers: ['1K','2K','4K']`(已有)、`maxResolution:'4K'`、`sizeKind:'keyword'`。

### 1b. `src/api/jobs.ts` — `/image-models` ratios 派生加 `d.ratios` 优先

第 ~1028 行派生改为:
```js
ratios: d.ratios ?? (d.pixelMatrix
  ? Object.keys(d.pixelMatrix[Object.keys(d.pixelMatrix)[0]!]!)
  : (d.sizeKind === 'keyword' ? [] : undefined)),
```
> 现有 pixelMatrix(z-image/qwen)与 keyword(万相)行为不变;仅新增 `d.ratios` 显式优先。

### 2. 前端 glyph 补全 — `prototype/ai-image.html` 和 `prototype/ai-image-edit.html`

两页的 `RATIO_GLYPH` 表补 4 个极端比例的字形尺寸(长条),否则回落 [18,18] 方块,极端比例显示不出形状:
- `'1:4':[7,28]`、`'4:1':[28,7]`、`'1:8':[4,32]`、`'8:1':[32,4]`(宽:高 比例对应,数值控制在格内即可)。

> 比例列表本身由 `m.ratios`(API 来自模型 `ratios` 字段)驱动,无需在前端写死;只需 glyph 表能查到这 4 个键。

### 3. (可选增强,YAGNI 默认不做)尺寸预览像素化

`syncPills`/edit 页仅对有 `resolutions` 表的模型显「16:9 · 2752×1536」像素预览;走 `ratios[]` 的 Gemini 显「16:9 · 2K」档名。本轮**不改**(与 z-image 现状一致,够用)。已记 TODOS.md:若后续要像素预览,把官方像素表录为静态展示常量供 `syncPills` 查。

## 不改动

- `gemini.ts` 网关:零改动(已发 aspectRatio + imageSize)。
- `sizeParams` / keyword 路径:零改动。
- 计价:零改动(仍 2K 单档,分辨率分档是另一条 TODO)。
- 比例/清晰度的渲染主逻辑(`renderRatios`/`renderRes`):零改动(已支持 `m.ratios` 驱动的比例 + `resolutionTiers` 驱动的档集)。

## 测试(eng-review 定:3 个新测试)

1. **形状断言**(test/ai-image.test.ts):`gemini-3.1-flash-image.ratios` = 14 项(含 1:4/4:1/1:8/8:1)、`resolutionTiers` = ['512','1K','2K','4K'];`gemini-3-pro-image.ratios` = 10 项、`resolutionTiers` = ['1K','2K','4K']。防手录漏行。
2. **512 网关透传**(test/gemini-gateway.test.ts):Flash + `resolution='512'` → 请求体 `imageConfig.imageSize === '512'`(不被 toUpperCase/映射误伤)。
3. **派生回落自洽**(test/ai-image.test.ts 或 image-models-db.test.ts):有 `ratios` 字段的模型 → `/image-models` 派生用它;无 `ratios` 有 `pixelMatrix` → 仍用首档键(现有 z-image/qwen 行为不回归)。

## 验证

- `npm run build` 通过;`npx vitest run test/gemini-gateway.test.ts test/ai-image.test.ts test/image-models-db.test.ts` 通过。
- 前端 AI图片页 + 编辑器页:选 Nano Banana 2 → 比例选择器出现 14 格(极端比例有长条 glyph)+ 清晰度 512/1K/2K/4K;选 Pro → 10 格 + 1K/2K/4K。
- 提交一张:网关请求体 `imageConfig.aspectRatio` = 所选比例、`imageSize` = 所选档(512/1K/2K/4K)。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 4 issues, 0 critical gaps — all folded |
| Outside Voice | (Claude subagent) | Independent 2nd opinion | 1 | issues_found | 3 gaps (1 dup, 1 false-alarm, 1 strategic adopted) |

**CODEX:** Codex auth failed at runtime (token refresh) → fell back to Claude subagent.

**CROSS-MODEL:** Outside voice independently confirmed架构发现 1(首档键派生脆弱,HIGH)= 跨模型一致;其 strategic 建议(弃 pixelMatrix 改 `ratios[]`)经用户批准采纳;其「512 死档」基于错的 resolutionTiers 假设(本平台 512 是活档);其「模型未启用」是 false alarm(seed-demo 已种且已并 main)。

**VERDICT:** ENG CLEARED — ready to implement. 机制改定:轻量 `ratios?: string[]` 字段(弃 pixelMatrix),比例+清晰度全按官方文档可配(Flash 14 比例×512/1K/2K/4K;Pro 10 比例×1K/2K/4K),`gemini.ts` 网关零改动,计价不变。3 个新测试。

NO UNRESOLVED DECISIONS
