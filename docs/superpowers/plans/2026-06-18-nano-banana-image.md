# Nano Banana 图片模型收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI 图片的 Gemini 模型收口为文档要求的两个 Nano Banana 模型(删除旧 `gemini-2.5-flash-image`,新增 `gemini-3.1-flash-image`,保留 `gemini-3-pro-image`),三种流(文生图/图生图/图片编辑含参考图)沿用现有两页 + 现有同步网关。

**Architecture:** 改动集中在「单一真相源」注册表 `image-models.ts`、计价种子 `seed-demo.mjs`、以及随之失效的测试。网关 `gemini.ts` 与前端无逻辑改动(前端下拉由 `/image-models` 动态填充,改注册表即自动更新)。三种流是同一种 Nano Banana API 形状(`contents:[{text},{inline_data}...]`),`text2img` 走 `generateImageSync`,`img2img`(含图片转图片 + 编辑+参考图)走 `editImage`,均已实现。

**Tech Stack:** Node + TypeScript (ESM)、better-sqlite3、vitest、Express。

## Global Constraints

- 汇率约定:美元 × 7.2 折人民币(沿用 `seed-demo.mjs` 现有注释约定)。
- 售价公式:`sellPrice = ⌈realCostYuan × 35⌉`(由 `credits/pricing.ts` 的 `sellPrice` 自动算,种子只录 `real_cost_yuan`)。
- 图片计价**不做分辨率分档**:每模型单一 `real_cost_yuan` = 2K 档成本。后期分档记 TODO。
- Nano Banana 2 (`gemini-3.1-flash-image`):2K 成本 ¥0.73($0.101×7.2)→ 售价 26 积分。
- Nano Banana Pro (`gemini-3-pro-image`):1–2K 成本 ¥0.96($0.134×7.2)→ 售价 34 积分(与现状一致)。
- 模型 `provider` 恒为 `'google-ai-studio'`,`shape='S'`,`sizeKind='keyword'`。
- 测试命令:`npm test`(= `vitest run`)。单文件:`npx vitest run test/<file>`。
- TypeScript 编译:`npm run build`(= `tsc -p tsconfig.json`)。

---

### Task 1: 注册表收口(删 2.5 / 增 3.1 Flash / 改 Pro label)

**Files:**
- Modify: `src/gateway/image-models.ts:167-176`(`IMAGE_MODELS` 内 gemini 两条)
- Test: `test/gemini-gateway.test.ts`(已存在;本任务先改它的注册表相关断言)

**Interfaces:**
- Consumes:无(改数据定义)。
- Produces:`IMAGE_MODELS['gemini-3.1-flash-image']` 与 `IMAGE_MODELS['gemini-3-pro-image']` 两条 `ImageModelDef`;`IMAGE_MODELS['gemini-2.5-flash-image']` 不再存在。`providerForModel('gemini-3.1-flash-image') === 'google-ai-studio'`、`getGateway('gemini-3.1-flash-image') instanceof GeminiGateway`。

- [ ] **Step 1: 改测试 — providerForModel / getGateway 用新 key**

`test/gemini-gateway.test.ts` 第 28–37 行的 `describe('providerForModel + getGateway(Gemini)')` 整块替换为:

```typescript
describe('providerForModel + getGateway(Gemini)', () => {
  it('gemini 模型 → google-ai-studio', () => {
    expect(providerForModel('gemini-3.1-flash-image')).toBe('google-ai-studio');
    expect(providerForModel('gemini-3-pro-image')).toBe('google-ai-studio');
  });
  it('getGateway 选 GeminiGateway(sync image 形状)', () => {
    const gw = getGateway('gemini-3.1-flash-image') as unknown;
    expect(gw).toBeInstanceOf(GeminiGateway);
  });
});
```

- [ ] **Step 2: 跑测试确认失败(注册表里还没 3.1 Flash)**

Run: `npx vitest run test/gemini-gateway.test.ts -t "providerForModel"`
Expected: FAIL — `providerForModel('gemini-3.1-flash-image')` 返回 `'bailian'`(未知 key 回落),不等于 `'google-ai-studio'`。

- [ ] **Step 3: 改注册表 — 删 2.5、增 3.1 Flash、改 Pro**

`src/gateway/image-models.ts` 中,把第 167–176 行(`'gemini-2.5-flash-image'` 与 `'gemini-3-pro-image'` 两条)整体替换为:

```typescript
  // ── Google AI Studio Gemini(Nano Banana,文档收口:只用这 2 个模型)──
  // shape='S':同步生成(走 generateImageSync/editImage)。sizeKind='keyword':resolution→imageSize(1K/2K/4K)。
  // 文生图(text2img,0 图)+ 图生图/图片编辑/多图融合(img2img,1 主图 + 0..N 参考图,均同一 API 形状)。
  // 真实价(美元×7.2 汇率,2K 档单一计价;后期分辨率分档见 TODOS):
  //   3.1 Flash 2K $0.101→0.73元→⌈×35⌉=26;3 Pro 1–2K $0.134→0.96元→34。
  'gemini-3.1-flash-image': {
    key: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini 3.1 Flash)', modelId: 'gemini-3.1-flash-image', provider: 'google-ai-studio',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 10, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 26,
  },
  'gemini-3-pro-image': {
    key: 'gemini-3-pro-image', label: 'Nano Banana Pro (Gemini 3 Pro)', modelId: 'gemini-3-pro-image', provider: 'google-ai-studio',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 6, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 34,
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/gemini-gateway.test.ts -t "providerForModel"`
Expected: PASS(2 个用例)。

- [ ] **Step 5: 编译确认无类型错误**

Run: `npm run build`
Expected: 退出码 0,无 TS 报错。

- [ ] **Step 6: Commit**

```bash
git add src/gateway/image-models.ts test/gemini-gateway.test.ts
git commit -m "feat(ai-image): 注册表收口 — 删 gemini-2.5、增 Nano Banana 2 (3.1 Flash)、改 Pro label

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 网关测试收口(删 2.5 引用,imageSize 断言改双新模型)

**Files:**
- Modify: `test/gemini-gateway.test.ts`(剩余引用 `gemini-2.5-flash-image` 的用例:行 ~40–60、~97–110、~112–118、~120–127,及该文件其余 2.5 字面量)

**Interfaces:**
- Consumes:Task 1 的注册表(但本任务测试直接给 `model` 字符串调 `GeminiGateway`,不读注册表 —— 网关用 `modelId.startsWith('gemini-3')` 判 imageSize)。
- Produces:`test/gemini-gateway.test.ts` 内不再出现 `gemini-2.5-flash-image`。

> 背景:`GeminiGateway` 的 `generateImageSync/editImage` 直接吃传入的 `model` 字符串当 `modelId`,不查注册表。原「imageSize 仅 3.x 发;2.5 不发」用例靠 2.5 当反例;2.5 删除后产品已无非-3.x Gemini 模型,反例变合成。保留网关 `startsWith('gemini-3')` 守卫(无害、未来兼容),把该用例改为「两个新模型都发 imageSize」。

- [ ] **Step 1: 把 generateImageSync 主用例的 2.5 换成 3.1 Flash**

`test/gemini-gateway.test.ts` 中 `generateImageSync:x-goog-api-key 头...` 用例(约行 48–54),把:

```typescript
    const urls = await new GeminiGateway().generateImageSync(
      { model: 'gemini-2.5-flash-image', prompt: '一只猫', resolution: '2K', ratio: '16:9' },
      new AbortController().signal,
    );
```
改为:
```typescript
    const urls = await new GeminiGateway().generateImageSync(
      { model: 'gemini-3.1-flash-image', prompt: '一只猫', resolution: '2K', ratio: '16:9' },
      new AbortController().signal,
    );
```
同一用例内的端点断言(约行 54):
```typescript
    expect(captured.url).toContain('/v1beta/models/gemini-2.5-flash-image:generateContent'); // v1beta(实测 v1 不认 image-gen)
```
改为:
```typescript
    expect(captured.url).toContain('/v1beta/models/gemini-3.1-flash-image:generateContent'); // v1beta(实测 v1 不认 image-gen)
```

- [ ] **Step 2: 重写「imageSize 仅 3.x 发」用例为「两个新模型都发 imageSize」**

把整段 `it('imageSize 仅 Gemini 3.x 发;2.5-flash 不发(只发 aspectRatio)', ...)`(约行 97–110)替换为:

```typescript
  it('两个 Nano Banana 模型都发 imageSize + aspectRatio(均 3.x)', async () => {
    // 2.5 已下线;产品仅余 3.1 Flash 与 3 Pro,两者都支持 imageSize。
    // 网关 startsWith('gemini-3') 守卫保留(无害、未来若再接非-3.x 模型仍正确)。
    let flash: any = null, pro: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init: any) => {
      const b = JSON.parse(init.body);
      if (b.contents) { if (!pro) pro = b; else flash = b; }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: Buffer.from('x').toString('base64') } }] } }] }), { status: 200 });
    });
    await new GeminiGateway().generateImageSync({ model: 'gemini-3-pro-image', prompt: 'x', resolution: '2K', ratio: '16:9' }, new AbortController().signal);
    await new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x', resolution: '4K', ratio: '1:1' }, new AbortController().signal);
    expect(pro.generationConfig.imageConfig.imageSize).toBe('2K');
    expect(pro.generationConfig.imageConfig.aspectRatio).toBe('16:9');
    expect(flash.generationConfig.imageConfig.imageSize).toBe('4K');
    expect(flash.generationConfig.imageConfig.aspectRatio).toBe('1:1');
  });
```

- [ ] **Step 3: camelCase 用例 + 无图抛错用例的 2.5 换成 3.1 Flash**

`camelCase 响应(inlineData)也能解析` 用例(约行 116):
```typescript
    const urls = await new GeminiGateway().generateImageSync({ model: 'gemini-2.5-flash-image', prompt: 'x' }, new AbortController().signal);
```
改为:
```typescript
    const urls = await new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x' }, new AbortController().signal);
```
`无图响应(被安全策略拦)→ 抛错`(约行 125)与 `HTTP 错误 → 抛错`(约行 132)两个用例里各有一处:
```typescript
      new GeminiGateway().generateImageSync({ model: 'gemini-2.5-flash-image', prompt: 'x' }, new AbortController().signal),
```
两处都改为:
```typescript
      new GeminiGateway().generateImageSync({ model: 'gemini-3.1-flash-image', prompt: 'x' }, new AbortController().signal),
```
(可用 `replace_all` 替换该行字面量,但注意 Step 1/Step 3 上文已改的几处用了不同上下文 —— 此处仅指这两个抛错用例的相同行。)

- [ ] **Step 4: 确认文件内再无 2.5 残留**

Run: `grep -n "gemini-2.5" test/gemini-gateway.test.ts || echo "CLEAN"`
Expected: 输出 `CLEAN`(无匹配)。

- [ ] **Step 5: 跑整个网关测试文件**

Run: `npx vitest run test/gemini-gateway.test.ts`
Expected: 全部 PASS(含改写后的 imageSize 用例、edit、thinking、camelCase、抛错等)。

- [ ] **Step 6: Commit**

```bash
git add test/gemini-gateway.test.ts
git commit -m "test(ai-image): 网关测试收口 — 2.5 引用换 3.1 Flash,imageSize 断言改双新模型

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 计价种子收口(seed-demo:删 2.5 行 / 增 3.1 Flash 行 / 改 Pro 成本)

**Files:**
- Modify: `scripts/seed-demo.mjs:125-127`(`DOUBAO_SEED` 内两条 gemini 行)

**Interfaces:**
- Consumes:Task 1 的注册表 key(种子 `id`/`model_key` 须与注册表 key 一致,`isEnabled`/`mergeDef` 才查得到价)。
- Produces:`model_pricing` 表含 `gemini-3.1-flash-image`(¥0.73,enabled=1)与 `gemini-3-pro-image`(¥0.96,enabled=1);不含 `gemini-2.5-flash-image`。

> 注:gemini 模型**仅**靠 `model_pricing` 行 + 代码注册表上线(`image_model_override` 无 gemini 行,`IMG_SEED` 也没有)。`isEnabled(key)` 读 `model_pricing.enabled`,`mergeDef` 读 `model_pricing.real_cost_yuan` 算售价。所以只改这两行即可。

- [ ] **Step 1: 替换 DOUBAO_SEED 内的两条 gemini 行**

`scripts/seed-demo.mjs` 第 125–127 行:

```javascript
  // Google Gemini(Nano Banana):美元×7.2 汇率折人民币(后台可调)。
  ['gemini-2.5-flash-image', 'gemini-2.5-flash-image', 'image', '张', null, 0.28], // $0.039×7.2≈0.28→⌈×35⌉=10
  ['gemini-3-pro-image', 'gemini-3-pro-image', 'image', '张', null, 0.96],         // $0.134×7.2≈0.96→⌈×35⌉=34
```
替换为:
```javascript
  // Google Gemini(Nano Banana,文档收口:只这 2 个模型):美元×7.2 汇率折人民币(后台可调)。
  // 图片暂不分辨率分档,用 2K 档单一成本(后期分档见 TODOS)。
  ['gemini-3.1-flash-image', 'gemini-3.1-flash-image', 'image', '张', null, 0.73], // Nano Banana 2:$0.101(2K)×7.2≈0.73→⌈×35⌉=26
  ['gemini-3-pro-image', 'gemini-3-pro-image', 'image', '张', null, 0.96],         // Nano Banana Pro:$0.134(1–2K)×7.2≈0.96→⌈×35⌉=34
```

- [ ] **Step 2: 确认 seed 文件内再无 2.5 残留**

Run: `grep -n "gemini-2.5" scripts/seed-demo.mjs || echo "CLEAN"`
Expected: 输出 `CLEAN`。

- [ ] **Step 3: 干净库重跑 seed,验证两模型上线、2.5 不在**

Run:
```bash
rm -f /tmp/nb-seed-test.db && DB_FILE=/tmp/nb-seed-test.db node scripts/seed-demo.mjs >/dev/null 2>&1; \
sqlite3 /tmp/nb-seed-test.db "SELECT id, real_cost_yuan, enabled FROM model_pricing WHERE model_key LIKE 'gemini%' ORDER BY id;"
```
Expected:
```
gemini-3-pro-image|0.96|1
gemini-3.1-flash-image|0.73|1
```
(无 `gemini-2.5-flash-image` 行。)

> 若 `sqlite3` CLI 不可用,改用:`DB_FILE=/tmp/nb-seed-test.db node -e "const{db}=await import('./src/db/index.js');console.log(db.prepare(\"SELECT id,real_cost_yuan,enabled FROM model_pricing WHERE model_key LIKE 'gemini%' ORDER BY id\").all())" --input-type=module`(注意:需 tsx,改 `node --import tsx`)。

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-demo.mjs
git commit -m "feat(ai-image): 计价种子收口 — 删 gemini-2.5、增 Nano Banana 2 (¥0.73/26 积分)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 全量测试 + 记 TODO(分辨率分档)

**Files:**
- Modify: `TODOS.md`(追加一条「图片分辨率分档计价」)

**Interfaces:**
- Consumes:Task 1–3 的全部改动。
- Produces:全量测试通过;`TODOS.md` 有分档 TODO。

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS。重点关注 `gemini-gateway.test.ts`、`image-models-db.test.ts`、`ai-image.test.ts`、`unified-pricing.test.ts`、`pricing-management.test.ts` 均绿。

> 若任一测试因找不到 `gemini-2.5-flash-image` 而失败,说明有遗漏引用 —— 回到对应文件把 2.5 换成 `gemini-3.1-flash-image` 或删除该断言(2.5 已彻底下线)。先 `grep -rn "gemini-2.5" src test scripts` 定位全部残留。

- [ ] **Step 2: 编译确认**

Run: `npm run build`
Expected: 退出码 0。

- [ ] **Step 3: 在 TODOS.md 末尾追加分档 TODO**

在 `TODOS.md` 文件末尾追加:

```markdown

## AI 图片:分辨率分档计价(后期)

Nano Banana 价格随分辨率变(3.1 Flash 1K=$0.067/2K=$0.101/4K=$0.151;Pro 1–2K=$0.134/4K=$0.24),
当前 `model_pricing` 图片表「一模型一行」,用 2K 档单一成本(3.1 Flash ¥0.73、Pro ¥0.96)。
后期分档方案:复用视频已有的 `model_pricing.variant` 机制 —— 每模型种 `gemini-*:1K/2K/4K` 多行,
`lookupCost` 图片路径透传 resolution,`buildImageJob` 价格快照按所选档取。改动穿透 mergeDef/buildImageJob/价格快照/admin。
决策记录:docs/superpowers/specs/2026-06-18-nano-banana-image-design.md。
```

- [ ] **Step 4: Commit**

```bash
git add TODOS.md
git commit -m "docs(todo): AI 图片分辨率分档计价(后期);记录 Nano Banana 各档价格

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- 模型替换(删 2.5、增 3.1 Flash、保留 Pro)→ Task 1(注册表)+ Task 3(种子)。✅
- 页面组织(两页 + 参考图模式,无新页面)→ 无代码改动(前端动态读 `/image-models`),设计已说明。✅
- 三种流映射(text2img/img2img 同一网关)→ 现有 `gemini.ts` 已实现,无改动;Task 1 注释明确两 modes。✅
- 旧 job 兼容(2.5 彻底删除)→ Task 1/2/3 删除全部 2.5 引用;Task 4 grep 兜底。✅
- 计价(2K 单一档,Nano Banana 2=26、Pro=34)→ Task 3。✅
- TODO(分辨率分档)→ Task 4。✅

**Placeholder scan:** 无 TBD/TODO 占位;每个代码步骤含完整代码;每个命令含期望输出。✅

**Type consistency:** 注册表 key `gemini-3.1-flash-image` 在 Task 1(注册表)、Task 2(测试)、Task 3(种子 id/model_key)三处一致。`ImageModelDef` 字段沿用现有 `gemini-3-pro-image` 形状(provider/shape/sizeKind/modes/maxImages/maxInputImages/maxResolution/resolutionTiers/priceTier)。售价积分(26/34)与成本(0.73/0.96)在设计、Task 1 注释、Task 3 种子一致。✅
