# AI 图片 — Nano Banana 模型收口设计

日期:2026-06-18
状态:已确认,待实现

## 背景

文档明确要求 AI 图片只用两个 Nano Banana 模型:

- **Nano Banana 2** = `gemini-3.1-flash-image`(Gemini 3.1 Flash Image,高效版,512/1K/2K/4K)
- **Nano Banana Pro** = `gemini-3-pro-image`(Gemini 3 Pro Image,专业版,1K/2K/4K,thinking)

当前注册表里是旧的 `gemini-2.5-flash-image` + `gemini-3-pro-image`。本设计把 2.5 彻底替换为 3.1 Flash,并梳理三种图片流(文字转图片 / 图片转图片 / 图片编辑含参考图)与现有架构的映射。

## 核心洞察:三种流是同一种 API 形状

Nano Banana 的 REST 调用形状只有一种:`contents:[{text}, {inline_data}...]`(最多 14 张参考图)。三种「流」只是 UX 层对输入图数量的不同包装:

| 用户视角流 | 页面 | mode | 输入图 | 后端路径 |
|---|---|---|---|---|
| 文字转图片 | `ai-image.html` | `text2img` | 0 | `generateImageSync` |
| 图片转图片 | `ai-image-edit.html`(上传主图) | `img2img` | 1 主图 | `editImage` |
| 图片编辑 + 参考图 | `ai-image-edit.html` | `img2img` | 1 主图 + 0–N 参考图 | `editImage` |

**结论:图片转图片 与 图片编辑(含参考图)是同一后端路径**(`img2img` / `editImage`),仅输入图数量不同。现有 `ai-image-edit.html` 已支持「主图 + 参考图 0/4」。`gemini.ts` 已实现 text2img(纯文本 content)与 img2img(含图 content),URL→base64 内联、thinking 中间图(`thought:true`)跳过都已就位。**无需新页面、无需新网关代码。**

## 决策(已与用户确认)

1. **模型替换**:`gemini-2.5-flash-image` 彻底删除(注册表 + 种子);新增 `gemini-3.1-flash-image`。保留 `gemini-3-pro-image`。
2. **页面组织**:保持现有两页 + 参考图模式,不新增页面。
3. **旧 job 兼容**:2.5 彻底删除(新装 dev,历史 job 风险低,用户确认可删)。
4. **计价**:图片计价**暂不做分辨率分档**(分档要穿透 mergeDef/buildImageJob/价格快照/admin,与加 2 模型不成比例)。每模型用 **2K 中间档**单一成本;后期再做分档(记 TODO)。

## 计价(美元 × 7.2 汇率,沿用现有约定;售价 = ⌈成本 × 35⌉)

| 模型 | 档 | 美元/张 | 成本(元) | 售价(积分) |
|---|---|---|---|---|
| Nano Banana 2 (3.1 Flash) | 2K | $0.101 | ¥0.73 | 26 |
| Nano Banana Pro (3 Pro) | 1–2K | $0.134 | ¥0.96 | 34(与现状一致) |

(参考:3.1 Flash 1K=$0.067→17、4K=$0.151→39;Pro 4K=$0.24→61。后期分档时用。)

## 改动清单(小)

### 1. `src/gateway/image-models.ts`
- 删除 `gemini-2.5-flash-image` 条目。
- 新增 `gemini-3.1-flash-image`:`label: 'Nano Banana 2 (Gemini 3.1 Flash)'`、`modelId: 'gemini-3.1-flash-image'`、`provider: 'google-ai-studio'`、`shape: 'S'`、`sizeKind: 'keyword'`、`modes: ['text2img','img2img']`、`maxImages: 1`、`maxInputImages: 10`(文档:3.1 Flash 高保真物体上限 10)、`maxResolution: '4K'`、`resolutionTiers: ['1K','2K','4K']`、`priceTier: 26`。
- `gemini-3-pro-image`:`label` 改为 `'Nano Banana Pro (Gemini 3 Pro)'`;`maxInputImages` 提到 6(文档:Pro 高保真物体 6);其余不变。

### 2. `src/gateway/gemini.ts`
- 无结构改动。校验 `supportsImageSize = modelId.startsWith('gemini-3')` 对 `gemini-3.1-flash-image` 为真(正确,3.1 Flash 支持 imageSize)。`thought:true` 跳过逻辑对 3.x thinking 模型已就位。

### 3. 计价种子 — `scripts/seed-demo.mjs`
- gemini 种子仅在 `seed-demo.mjs` 的 `DOUBAO_SEED` 数组里(`db/index.ts` 迁移只从旧表搬运,无硬编码 gemini)。
- 把 `gemini-2.5-flash-image` 行替换为 `gemini-3.1-flash-image`,成本 ¥0.73。
- `gemini-3-pro-image` 行保持 ¥0.96。
- 现有 dev DB(`lingjing-agent2.db`)无 gemini 行 → 重跑 seed 即生效;若已有旧 2.5 行需手动 DELETE。

### 4. 前端
- 模型下拉由 `/image-models` 动态填充,改注册表即自动更新,无 HTML 逻辑改动。
- 校验侧栏 `<span class="nano">Nano Banana</span>` 徽标文案仍合适(泛指,不写型号 → 保持)。

### 5. TODO(记入 TODOS.md)
- 图片计价分辨率分档(复用视频已有的 `model_pricing.variant` 机制):`gemini-*:1K/2K/4K` 多行 + `lookupCost` 透传 resolution + buildImageJob 快照按档。

## 不做(YAGNI)

文档展示但本轮不实现:新比例(1:4/4:1/1:8/8:1)、Google Search grounding、视频转图、thinking-level 控制、图像搜索 grounding。用户只要三个核心流。

## 验证

- `npm run build` / `tsc` 通过。
- 启动后 `GET /image-models` 返回含 `gemini-3.1-flash-image`、不含 `gemini-2.5-flash-image`。
- 文生图页下拉出现「Nano Banana 2」「Nano Banana Pro」;编辑页同。
- 文生图(0 图)、图生图(1 主图)、编辑+参考图(主图+参考)三条路径各跑通一次。
