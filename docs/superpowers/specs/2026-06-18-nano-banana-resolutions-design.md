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
3. **复用现有 `pixelMatrix` 机制**:
   - `/image-models`(jobs.ts)对有 `pixelMatrix` 的模型,从矩阵首档的 ratio 键派生 `ratios` 列表 → 前端比例选择器据此渲染(两页都是)。
   - `pixelMatrix` 的「发 W×H」副作用只在 `sizeKind:'wh'` 的 `sizeParams` 路径触发;Gemini 是 `keyword` 且**网关根本不调 `sizeParams`** → 加 `pixelMatrix` 对 Gemini 纯属前端展示,不污染 keyword 发送路径。**无冲突**。
4. **清晰度档不被 `pixelMatrix` 隐藏**:`renderRes` 仅在 `canSetSize===false` 或有 `resolutions` 表时隐藏;`pixelMatrix` 模型(如 z-image)清晰度照显。档集由 `resolutionTiers` 驱动。
5. **512 档**:`resolutionTiers` 含 `'512'`,`pixelMatrix` 顶层键含 `'512'`。`RES_ORDER` 当前无 512,但 `renderRes` 有 `resolutionTiers` 时走精确档集分支(不读 RES_ORDER 上限),故 512 能正常出现并选中。`imageSize` 透传 `'512'`(Gemini 文档:512 档不带 K 后缀,大写其余档)——需确认网关对 '512' 不强行 `.toUpperCase()` 误伤(512 无字母,toUpperCase 无害)。

## 改动清单

### 1. `src/gateway/image-models.ts` — 两个 Gemini 条目加 `pixelMatrix` + `resolutionTiers`

新增两张精确像素矩阵常量(照用户文档表,平台暴露的比例):

- `GEMINI_FLASH_PIXELS`:键 `'512' | '1K' | '2K' | '4K'`,每档 14 比例(1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9),值为文档 "W*H"。
- `GEMINI_PRO_PIXELS`:键 `'1K' | '2K' | '4K'`,每档 10 比例(1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9),值为文档 "W*H"。

改两条目:
- `gemini-3.1-flash-image`:加 `pixelMatrix: GEMINI_FLASH_PIXELS`、`resolutionTiers: ['512','1K','2K','4K']`、`maxResolution: '4K'`(不变)。
- `gemini-3-pro-image`:加 `pixelMatrix: GEMINI_PRO_PIXELS`、`resolutionTiers: ['1K','2K','4K']`(已有)、`maxResolution: '4K'`(不变)。

> `sizeKind` 保持 `'keyword'`(网关靠它走 keyword 发送;且即使前端因 pixelMatrix 显示比例,后端 Gemini 网关仍发 aspectRatio 关键字)。

### 2. 前端 glyph 补全 — `prototype/ai-image.html` 和 `prototype/ai-image-edit.html`

两页的 `RATIO_GLYPH` 表补 4 个极端比例的字形尺寸(长条),否则回落 [18,18] 方块,极端比例显示不出形状:
- `'1:4':[7,28]`、`'4:1':[28,7]`、`'1:8':[4,32]`、`'8:1':[32,4]`(宽:高 比例对应,数值控制在格内即可)。

> 比例列表本身由 `m.ratios`(API 派生自 pixelMatrix)驱动,无需在前端写死;只需 glyph 表能查到这 4 个键。

### 3. (可选增强,YAGNI 默认不做)尺寸预览像素化

`syncPills`/edit 页仅对有 `resolutions` 表的模型显「16:9 · 2752×1536」像素预览;`pixelMatrix` 模型显「16:9 · 2K」档名。本轮**不改**(与 z-image 现状一致,够用)。若后续要像素预览,扩 `syncPills` 读 `pixelMatrix[res][ratio]`。

## 不改动

- `gemini.ts` 网关:零改动(已发 aspectRatio + imageSize)。
- `sizeParams` / keyword 路径:零改动。
- 计价:零改动(仍 2K 单档,分辨率分档是另一条 TODO)。
- 比例/清晰度的渲染主逻辑(`renderRatios`/`renderRes`):零改动(已支持 pixelMatrix 驱动的 ratios + resolutionTiers 驱动的档集)。

## 验证

- `npm run build` 通过;`npx vitest run test/gemini-gateway.test.ts test/ai-image.test.ts test/image-models-db.test.ts` 通过。
- `GET /image-models`:`gemini-3.1-flash-image.ratios` = 14 项(含 1:4/4:1/1:8/8:1)、`resolutionTiers` = ['512','1K','2K','4K'];`gemini-3-pro-image.ratios` = 10 项、`resolutionTiers` = ['1K','2K','4K']。
- 前端 AI图片页 + 编辑器页:选 Nano Banana 2 → 比例选择器出现 14 格(极端比例有长条 glyph)+ 清晰度 512/1K/2K/4K;选 Pro → 10 格 + 1K/2K/4K。
- 提交一张:网关请求体 `imageConfig.aspectRatio` = 所选比例、`imageSize` = 所选档(512/1K/2K/4K)。
- registry 自洽性测试(test/ai-image.test.ts):pixelMatrix 模型的 ratios 推导不破坏现有断言。
