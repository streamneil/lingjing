# Nano Banana 分辨率/比例支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让两个 Nano Banana 模型(`gemini-3.1-flash-image`、`gemini-3-pro-image`)在 AI图片(text2img)和 AI图片编辑器(img2img)两页能选**比例 + 清晰度**,按官方文档全可配。

**Architecture:** 给 `ImageModelDef` 加轻量 `ratios?: string[]` 字段(弃 pixelMatrix —— Gemini 关键字 API 不需 W×H),`/image-models` 派生优先读它;两个 Gemini 条目配 `ratios` + `resolutionTiers`;两页 `RATIO_GLYPH` 补 4 个极端比例字形。网关 `gemini.ts` 零改动(已发 `aspectRatio`+`imageSize` 关键字)。

**Tech Stack:** Node + TypeScript (ESM)、Express、vitest、静态 prototype HTML(原生 JS)。

## Global Constraints

- 机制:`ratios?: string[]` 字段(**不用 pixelMatrix**)。`/image-models` 派生:`d.ratios ?? (d.pixelMatrix ? 首档键 : (sizeKind==='keyword' ? [] : undefined))`。
- **Nano Banana 2 (`gemini-3.1-flash-image`)**:`ratios` = 14 项 `['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9']`;`resolutionTiers` = `['512','1K','2K','4K']`。
- **Nano Banana Pro (`gemini-3-pro-image`)**:`ratios` = 10 项 `['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9']`;`resolutionTiers` = `['1K','2K','4K']`。
- 两条目其余字段不变:`sizeKind:'keyword'`、`maxResolution:'4K'`、`maxImages:1`、Flash `maxInputImages:9` / Pro `maxInputImages:6`、`priceTier` Flash 26 / Pro 34。
- `gemini.ts` 网关、`sizeParams`/`whSize`、计价:零改动。
- 4 个极端比例 glyph(宽×高 px):`'1:4':[7,28]`、`'4:1':[28,7]`、`'1:8':[4,32]`、`'8:1':[32,4]`。
- 测试命令:`npx vitest run <file>`;全量 `npm test`;编译 `npm run build`。

---

### Task 1: 注册表 — 加 `ratios` 字段 + 配两个 Gemini 条目

**Files:**
- Modify: `src/gateway/image-models.ts`(`ImageModelDef` 接口尾部 + 两个 gemini 条目)
- Test: `test/ai-image.test.ts`(加形状断言)

**Interfaces:**
- Consumes:无。
- Produces:`ImageModelDef` 多一个可选字段 `ratios?: string[]`。`IMAGE_MODELS['gemini-3.1-flash-image'].ratios` = 14 项、`.resolutionTiers` = `['512','1K','2K','4K']`;`IMAGE_MODELS['gemini-3-pro-image'].ratios` = 10 项、`.resolutionTiers` = `['1K','2K','4K']`。

- [ ] **Step 1: 写形状断言(失败)**

在 `test/ai-image.test.ts` 的 `describe('千问 2.0 系列 pixelMatrix...')` 块之后(文件内已有该 describe,约 233 行起),新增一个 describe:

```typescript
describe('Nano Banana 比例/清晰度(分辨率支持)', () => {
  it('gemini-3.1-flash-image: 14 比例 + 512/1K/2K/4K 档', () => {
    const m = getImageModel('gemini-3.1-flash-image');
    expect(m.ratios).toEqual(['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9']);
    expect(m.resolutionTiers).toEqual(['512','1K','2K','4K']);
  });
  it('gemini-3-pro-image: 10 比例 + 1K/2K/4K 档', () => {
    const m = getImageModel('gemini-3-pro-image');
    expect(m.ratios).toEqual(['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9']);
    expect(m.resolutionTiers).toEqual(['1K','2K','4K']);
  });
});
```

> `getImageModel` 已在该测试文件顶部 import(现有 `getImageModel 默认兜底` 块在用)。若未 import,加到现有的 `import { ... } from '../src/gateway/image-models.js'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/ai-image.test.ts -t "Nano Banana 比例"`
Expected: FAIL — `m.ratios` 为 `undefined`,不等于数组。

- [ ] **Step 3: 加 `ratios` 字段到接口**

`src/gateway/image-models.ts` 中,`ImageModelDef` 接口的 `canSetSize?: boolean;` 行之后、闭合 `}` 之前,加:

```typescript
  ratios?: string[]; // 该模型暴露的比例集(Gemini 等 keyword 模型用);缺省 → /image-models 派生回落(pixelMatrix 首档键 / keyword 空 / undefined)
```

- [ ] **Step 4: 配两个 Gemini 条目的 ratios**

把 `'gemini-3.1-flash-image'` 条目的这一行:

```typescript
    maxImages: 1, maxInputImages: 9, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 26,
```
替换为:
```typescript
    maxImages: 1, maxInputImages: 9, maxResolution: '4K', resolutionTiers: ['512', '1K', '2K', '4K'], priceTier: 26,
    ratios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
```

把 `'gemini-3-pro-image'` 条目的这一行:

```typescript
    maxImages: 1, maxInputImages: 6, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 34,
```
替换为:
```typescript
    maxImages: 1, maxInputImages: 6, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 34,
    ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  },
```
> 注意第二条把闭合 `},` 一并写出以保唯一匹配;若工具因 `},` 重复无法唯一匹配,改用「priceTier: 34, 行」单独匹配 + 在其后插入 ratios 行。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/ai-image.test.ts -t "Nano Banana 比例"`
Expected: PASS(2 用例)。

- [ ] **Step 6: 编译确认**

Run: `npm run build`
Expected: 退出码 0,无 TS 报错。

- [ ] **Step 7: Commit**

```bash
git add src/gateway/image-models.ts test/ai-image.test.ts
git commit -m "feat(ai-image): Nano Banana 加 ratios 字段(比例可配)+ Flash 512 档

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `/image-models` 派生优先读 `d.ratios`

**Files:**
- Modify: `src/api/jobs.ts:1028-1030`(ratios 派生表达式)
- Test: `test/ai-image.test.ts` 或 `test/image-models-db.test.ts`(派生回落自洽)

**Interfaces:**
- Consumes:Task 1 的 `ImageModelDef.ratios` 字段。
- Produces:`GET /image-models` 对有 `ratios` 字段的模型返回该数组;无 `ratios` 有 `pixelMatrix` 仍返回首档键;keyword 无 pixelMatrix 无 ratios 仍返回 `[]`。

> 该派生当前是 `/image-models` route handler 内的内联表达式(约 1028 行)。它没有独立函数,测试通过起 app 打 `GET /image-models` 或直接断言 handler 输出。本仓 `test/ai-image.test.ts` 已有调 API 的先例(检查文件顶部 helper)。若直接打 API 成本高,改为抽一个小纯函数 `deriveRatios(def)` 单测(见 Step 3 备选)。优先直接打 API 保真。

- [ ] **Step 1: 写派生回落测试(失败)**

在 `test/ai-image.test.ts` 末尾(或紧接 Task 1 的 describe)加:

```typescript
describe('/image-models ratios 派生优先 d.ratios', () => {
  // 纯函数化派生逻辑的单测(与 jobs.ts handler 内联表达式同口径)。
  // 派生:d.ratios ?? (d.pixelMatrix ? 首档键 : (keyword ? [] : undefined))
  function deriveRatios(d: { ratios?: string[]; pixelMatrix?: Record<string, Record<string, string>>; sizeKind: string }) {
    return d.ratios ?? (d.pixelMatrix
      ? Object.keys(d.pixelMatrix[Object.keys(d.pixelMatrix)[0]!]!)
      : (d.sizeKind === 'keyword' ? [] : undefined));
  }
  it('有 ratios 字段 → 用它', () => {
    expect(deriveRatios({ ratios: ['1:1', '16:9'], sizeKind: 'keyword' })).toEqual(['1:1', '16:9']);
  });
  it('无 ratios 有 pixelMatrix → 首档键(z-image/qwen 不回归)', () => {
    expect(deriveRatios({ pixelMatrix: { '1K': { '1:1': '1024*1024', '16:9': '1280*720' } }, sizeKind: 'wh' })).toEqual(['1:1', '16:9']);
  });
  it('keyword 无 ratios 无 pixelMatrix → [](万相不回归)', () => {
    expect(deriveRatios({ sizeKind: 'keyword' })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试 — 第 1 用例失败(派生还没读 d.ratios)**

Run: `npx vitest run test/ai-image.test.ts -t "ratios 派生优先"`
Expected: 该 describe 内 `deriveRatios` 是测试本地函数,会先按测试里的实现跑;但 jobs.ts 还没改。本步意图是**先固化期望口径**;若测试本地 `deriveRatios` 已含 `d.ratios ??`,3 用例会直接 PASS —— 那是因为测试自带逻辑。真正验证 jobs.ts 的是 Step 4 的 grep/读取。

> ⚠ 修正:为真正测到 jobs.ts,Step 1 的 `deriveRatios` 仅作口径文档。jobs.ts 的改动由 Step 4 的代码替换 + Step 5 的「现有 API 测试不回归」保证。本 describe 用于锁口径,3 用例应 PASS。

- [ ] **Step 3: 改 jobs.ts 派生表达式**

`src/api/jobs.ts` 第 1028-1030 行,把:

```javascript
    ratios: d.pixelMatrix
      ? Object.keys(d.pixelMatrix[Object.keys(d.pixelMatrix)[0]!]!)
      : (d.sizeKind === 'keyword' ? [] : undefined),
```
替换为:
```javascript
    ratios: d.ratios ?? (d.pixelMatrix
      ? Object.keys(d.pixelMatrix[Object.keys(d.pixelMatrix)[0]!]!)
      : (d.sizeKind === 'keyword' ? [] : undefined)),
```

- [ ] **Step 4: 确认改动落地**

Run: `grep -n "d.ratios ??" src/api/jobs.ts`
Expected: 命中 1 行(约 1028)。

- [ ] **Step 5: 跑口径测试 + 现有 image-models API 测试不回归**

Run: `npx vitest run test/ai-image.test.ts test/image-models-db.test.ts`
Expected: 全 PASS(含 z-image/qwen pixelMatrix 派生用例不回归)。

- [ ] **Step 6: 编译确认**

Run: `npm run build`
Expected: 退出码 0。

- [ ] **Step 7: Commit**

```bash
git add src/api/jobs.ts test/ai-image.test.ts
git commit -m "feat(ai-image): /image-models 派生优先读 d.ratios 字段

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 512 网关透传测试

**Files:**
- Test: `test/gemini-gateway.test.ts`(加 512 用例)

**Interfaces:**
- Consumes:`GeminiGateway.generateImageSync`(已存在);它把 `input.resolution` 透传成 `imageConfig.imageSize`。
- Produces:无生产代码改动 —— 本任务证明 `resolution='512'` 原样到达请求体(锁回归)。

> 背景:`gemini.ts` 第 49 行 `if (opts.imageSize && supportsImageSize) imageCfg.imageSize = opts.imageSize;` —— 原样透传,无 `.toUpperCase()`。`supportsImageSize = modelId.startsWith('gemini-3')` 对 `gemini-3.1-flash-image` 为真。本测试锁住「512 不被加工」。

- [ ] **Step 1: 加 512 透传用例**

在 `test/gemini-gateway.test.ts` 的 `describe('GeminiGateway 请求/响应')` 块内(紧接现有 imageSize 用例之后)加:

```typescript
  it('512 档:imageSize 原样透传 "512"(Flash;不被大写/映射误伤)', async () => {
    let captured: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      const b = JSON.parse(init.body);
      if (b.contents) captured = b;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: Buffer.from('x').toString('base64') } }] } }] }), { status: 200 });
    });
    await new GeminiGateway().generateImageSync(
      { model: 'gemini-3.1-flash-image', prompt: 'x', resolution: '512', ratio: '1:4' },
      new AbortController().signal,
    );
    expect(captured.generationConfig.imageConfig.imageSize).toBe('512');
    expect(captured.generationConfig.imageConfig.aspectRatio).toBe('1:4');
  });
```

- [ ] **Step 2: 跑测试确认通过(生产代码已支持)**

Run: `npx vitest run test/gemini-gateway.test.ts -t "512 档"`
Expected: PASS —— 证明现有透传逻辑对 512 正确。

> 若 FAIL(imageSize 不是 '512' 或被改写):说明网关确有加工,回到 `src/gateway/gemini.ts` 第 49 行核对;按设计 512 无字母不应被 `.toUpperCase()` 改变。修正后重跑。

- [ ] **Step 3: 跑整个网关测试文件不回归**

Run: `npx vitest run test/gemini-gateway.test.ts`
Expected: 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add test/gemini-gateway.test.ts
git commit -m "test(ai-image): 锁 512 档 imageSize 原样透传(Nano Banana 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 前端 — 两页 RATIO_GLYPH 补 4 个极端比例

**Files:**
- Modify: `prototype/ai-image.html:333`(RATIO_GLYPH)
- Modify: `prototype/ai-image-edit.html:322`(RATIO_GLYPH)

**Interfaces:**
- Consumes:`m.ratios`(Task 1+2 后 API 返回的 14/10 比例)。
- Produces:两页 `RATIO_GLYPH` 含 `'1:4'`、`'4:1'`、`'1:8'`、`'8:1'` 四键 → 极端比例显示为长条而非回落 `[18,18]` 方块。

> 两页该行字节完全相同。比例选择器渲染逻辑(`renderRatios`)已支持任意 `m.ratios`,glyph 缺失只会回落方块(不报错),本任务仅修字形。无独立单测(纯静态 HTML 常量);验证靠 grep + 人工核对页面。

- [ ] **Step 1: 改 ai-image.html 的 RATIO_GLYPH**

`prototype/ai-image.html` 第 333 行,把:

```javascript
  const RATIO_GLYPH={'auto':[18,18],'16:9':[20,11],'9:16':[11,20],'1:1':[18,18],'3:4':[14,18],'4:3':[18,14],'3:2':[19,13],'2:3':[13,19],'21:9':[20,9],'9:21':[9,20]};
```
替换为:
```javascript
  const RATIO_GLYPH={'auto':[18,18],'16:9':[20,11],'9:16':[11,20],'1:1':[18,18],'3:4':[14,18],'4:3':[18,14],'3:2':[19,13],'2:3':[13,19],'4:5':[16,20],'5:4':[20,16],'21:9':[20,9],'9:21':[9,20],'1:4':[7,28],'4:1':[28,7],'1:8':[4,32],'8:1':[32,4]};
```

> 顺手补了 `4:5`/`5:4`(Pro 与 Flash 都暴露,原 glyph 表缺 → 会回落方块)。

- [ ] **Step 2: 改 ai-image-edit.html 的 RATIO_GLYPH(同样内容)**

`prototype/ai-image-edit.html` 第 322 行,把:

```javascript
  const RATIO_GLYPH={'auto':[18,18],'16:9':[20,11],'9:16':[11,20],'1:1':[18,18],'3:4':[14,18],'4:3':[18,14],'3:2':[19,13],'2:3':[13,19],'21:9':[20,9],'9:21':[9,20]};
```
替换为:
```javascript
  const RATIO_GLYPH={'auto':[18,18],'16:9':[20,11],'9:16':[11,20],'1:1':[18,18],'3:4':[14,18],'4:3':[18,14],'3:2':[19,13],'2:3':[13,19],'4:5':[16,20],'5:4':[20,16],'21:9':[20,9],'9:21':[9,20],'1:4':[7,28],'4:1':[28,7],'1:8':[4,32],'8:1':[32,4]};
```

- [ ] **Step 3: 确认两页都含 4 个极端比例键**

Run: `grep -c "'1:4':\[7,28\].*'8:1':\[32,4\]" prototype/ai-image.html prototype/ai-image-edit.html`
Expected: 两文件各输出 `1`(即各命中 1 行)。

- [ ] **Step 4: Commit**

```bash
git add prototype/ai-image.html prototype/ai-image-edit.html
git commit -m "fix(ai-image): RATIO_GLYPH 补极端比例字形(1:4/4:1/1:8/8:1 + 4:5/5:4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 全量回归 + 重种子验证两模型上线

**Files:**
- 无代码改动(验证任务)。

**Interfaces:**
- Consumes:Task 1-4 全部改动。
- Produces:全量测试通过;`GET /image-models`(经重种子 DB)对两模型返回正确 ratios/resolutionTiers。

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全 PASS(captcha/login 偶发并行 flake 与本改动无关 —— 单独跑 `npx vitest run test/captcha.test.ts` 应 6/6 过;只有 gemini/image 相关失败才是本任务的)。

- [ ] **Step 2: 编译**

Run: `npm run build`
Expected: 退出码 0。

- [ ] **Step 3: 重种子 + 验证 /image-models 形状(throwaway DB)**

Run:
```bash
rm -f /tmp/nb-res-test.db && DB_FILE=/tmp/nb-res-test.db node scripts/seed-demo.mjs >/dev/null 2>&1
DB_FILE=/tmp/nb-res-test.db node --import tsx -e "
import('./src/gateway/image-models.js').then(({ getImageModel }) => {
  const f = getImageModel('gemini-3.1-flash-image');
  const p = getImageModel('gemini-3-pro-image');
  console.log('flash.ratios.len=', f.ratios?.length, 'tiers=', JSON.stringify(f.resolutionTiers));
  console.log('pro.ratios.len=', p.ratios?.length, 'tiers=', JSON.stringify(p.resolutionTiers));
});
"
```
Expected:
```
flash.ratios.len= 14 tiers= ["512","1K","2K","4K"]
pro.ratios.len= 10 tiers= ["1K","2K","4K"]
```

> 若 `node --import tsx` 不可用,跳过此 inline 验证,改在 Step 1 的测试(Task 1 形状断言)已覆盖同等内容。

- [ ] **Step 4: 无需 commit(纯验证)**

若 Step 1-3 全绿,本任务无文件改动,不提交。若发现回归,回到对应 Task 修复并补测。

---

## Self-Review

**Spec coverage:**
- 机制改用 `ratios?: string[]`(弃 pixelMatrix)→ Task 1(字段+条目)+ Task 2(派生)。✅
- Flash 14 比例 + 512/1K/2K/4K → Task 1 常量 + Task 1 Step 1 形状断言。✅
- Pro 10 比例 + 1K/2K/4K → Task 1。✅
- 派生回落不回归(z-image/qwen/万相)→ Task 2 Step 1 口径测试 + Step 5 现有测试。✅
- 512 透传 → Task 3。✅
- 前端极端比例 glyph → Task 4。✅
- 网关/计价零改动 → 无对应 Task(Task 3 只加测试证明,不改生产码)。✅
- 测试 3 个(形状/派生/512)→ Task 1、2、3。✅
- 全可配(比例+清晰度)→ Task 1 配 ratios + resolutionTiers,前端 renderRatios/renderRes 现成。✅

**Placeholder scan:** 无 TBD/TODO;每个代码步骤有完整代码;命令带期望输出。Task 2 Step 2 的「口径文档」说明已显式标注其意图(非占位)。✅

**Type consistency:** 字段名 `ratios`(接口、条目、派生、测试四处一致);两 Gemini key 与现有注册表一致;512 在 Flash resolutionTiers + 形状断言 + 网关测试三处一致;glyph 4 键在两页一致。✅
