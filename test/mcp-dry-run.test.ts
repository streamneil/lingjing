// MCP dry_run — 「报价 ≡ 提交」对称性(v0.9.2,eng-review D4/D9/D11)。
//
// 背景:v0.9.1 的 estimate 工具走 estimateJob,而提交走 JOB_BUILDERS —— 两个独立校验器。
// 实测分歧:estimate({type:'ai_music', prompt:'x'}) 返回 {cost:3},同参数提交却 400「缺少 mode」。
// Agent 对这类错误无法自救,只会一路重试到限速。
//
// 修法不是「让两条路共用 zod schema」——那只统一了**参数形状**,统一不了**校验结论**。
// dry_run 直接跑 quoteJob(),而 quoteJob 跑的就是提交时那个 JOB_BUILDERS,只跳过余额闸/入队/预扣。
//
// 本文件钉的就是这条性质。**两张表缺一不可**:
//   合法表 —— dry_run 不入队不扣分,且同参数提交必成功;
//   非法表 —— 两条路对同一个非法值给出同一个结论。
// 只有合法表的测试在构造上就不可能失败(全是最小合法参数),检不出任何口径分歧 —— 那正是
// 上一版方案的漏洞,由外部声音指出。

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Client as McpSdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
// 本文件打 ~50 次 tools/call,默认写限速 60/min 只剩 20% 余量 —— 再加两三个用例就会
// 以「dry_run 放行了但提交失败」的面目随机翻车,把限速问题误报成口径问题。限速另有专测。
process.env.API_RATE_WRITE_PER_MIN = '100000';

const mem = new Map<string, Buffer>();
vi.mock('../src/storage/index.js', () => ({
  putObject: vi.fn(async (key: string, data: Buffer | string) => { mem.set(key, Buffer.from(data)); return key; }),
  getObject: vi.fn(async (key: string) => { const b = mem.get(key); if (!b) throw new Error('NoSuchKey'); return b; }),
  putObjectFromUrl: vi.fn(async (key: string) => key),
  getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  signOutputUrls: vi.fn(async () => []),
  parseOutputKeys: vi.fn(() => []),
  storage: {
    putObject: vi.fn(async (key: string, data: Buffer | string) => { mem.set(key, Buffer.from(data)); return key; }),
    getObject: vi.fn(async (key: string) => { const b = mem.get(key); if (!b) throw new Error('NoSuchKey'); return b; }),
    putObjectFromUrl: vi.fn(async (key: string) => key),
    getSignedUrl: vi.fn(async (key: string) => `signed://${key}`),
  },
}));
vi.mock('../src/pipeline/ai-label.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/ai-label.js')>();
  return { ...actual, probeVideoMeta: vi.fn(async () => ({ duration: 8, width: 1920, height: 1080 })) };
});

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant, balance } = await import('../src/credits/index.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');
const { serverPort } = await import('./helpers.js');

seedPlatformDefaults();
const app = createApp();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const MP4 = Buffer.from('ftypisom-fake-mp4-for-dry-run-tests');

let port = 0;
let key = '';
let tId = '';
let imgRef = '';
let imgRef2 = '';
let vidRef = '';
let voiceRef = '';

async function mcp() {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const c = new McpSdkClient({ name: 'dry-run-agent', version: '1.0.0' });
  await c.connect(transport);
  return c;
}

const jobCount = (): number =>
  (db.prepare(`SELECT COUNT(*) n FROM job WHERE tenant_id=?`).get(tId) as { n: number }).n;

type Sc = { cost?: number; balance?: number; job_id?: string; error?: string; code?: string };
// callTool 的返回是联合类型(有一支不带 structuredContent),故入参收 unknown 再取。
const sc = (r: unknown): Sc => ((r as { structuredContent?: unknown }).structuredContent ?? {}) as Sc;

beforeAll(async () => {
  tId = createTenant('dry-run 台').id;
  const uid = (await createUser(tId, 'dryrunner', 'pw123456', 'creator')).id;
  grant(tId, 10_000_000);
  key = createApiKey(tId, uid, 'dry-key').key;
  port = await serverPort(app);

  const c = await mcp();
  const up = await c.callTool({
    name: 'upload_image',
    arguments: {
      images: [
        { filename: 'a.png', data_base64: PNG.toString('base64') },
        { filename: 'b.png', data_base64: Buffer.concat([PNG, Buffer.from('second')]).toString('base64') },
      ],
      consent: true,
    },
  });
  const refs = (up.structuredContent as { imageRefs: string[] }).imageRefs;
  imgRef = refs[0]!; imgRef2 = refs[1]!;

  const uv = await c.callTool({
    name: 'upload_video',
    arguments: { filename: 'clip.mp4', data_base64: MP4.toString('base64'), consent: true },
  });
  vidRef = (uv.structuredContent as { videoRef: string }).videoRef;

  const vs = await c.callTool({ name: 'list_voices', arguments: {} });
  voiceRef = (vs.structuredContent as { voices: { id: string }[] }).voices[0]!.id;
  await c.close();
}, 60000);

// ── 合法表:七个生成工具,dry_run 与提交对称 ────────────────────────────────
describe('dry_run 对称性 — 合法参数(七个生成工具全覆盖)', () => {
  const cases = () => [
    { tool: 'generate_image', args: { prompt: '一只柴犬', count: 1 } },
    { tool: 'generate_video', args: { prompt: '海边日落' } },
    { tool: 'generate_video_from_image', args: { task: 'first_frame', imageRefs: [imgRef] } },
    { tool: 'generate_video_from_refs', args: { prompt: '按 [图1] 的风格生成', imageRefs: [imgRef] } },
    { tool: 'edit_video', args: { videoRef: vidRef, prompt: '把外套换成红色风衣' } },
    { tool: 'generate_music', args: { mode: 'instrumental', prompt: '轻快的电子舞曲' } },
    { tool: 'generate_speech', args: { text: '你好,世界', voice_ref: voiceRef } },
  ];

  for (const idx of [0, 1, 2, 3, 4, 5, 6]) {
    it(`[${idx}] dry_run:true → 回 cost + balance,不入队、不扣分`, async () => {
      const c = await mcp();
      const { tool, args } = cases()[idx]!;
      const jobsBefore = jobCount();
      const creditsBefore = balance(tId);
      const r = await c.callTool({ name: tool, arguments: { ...args, dry_run: true } });
      const s = sc(r);
      expect(r.isError, `${tool} dry_run 不该报错:${s.error}`).toBeFalsy();
      expect(typeof s.cost, `${tool} 应返回 cost`).toBe('number');
      expect(s.cost!).toBeGreaterThan(0);
      expect(typeof s.balance).toBe('number'); // 顺带回余额,Agent 能自己比
      expect(s.job_id).toBeUndefined();        // 报价不产生任务
      expect(jobCount()).toBe(jobsBefore);     // 没入队
      expect(balance(tId)).toBe(creditsBefore); // 没扣分
      await c.close();
    });

    it(`[${idx}] 同参数去掉 dry_run → 必定提交成功(报价 ≡ 提交)`, async () => {
      const c = await mcp();
      const { tool, args } = cases()[idx]!;
      const quote = await c.callTool({ name: tool, arguments: { ...args, dry_run: true } });
      const submit = await c.callTool({ name: tool, arguments: args });
      const q = sc(quote); const s = sc(submit);
      expect(submit.isError, `${tool} 报价通过却提交失败:${s.error}`).toBeFalsy();
      expect(s.job_id).toBeTruthy();
      expect(s.cost, `${tool} 报价与实扣不一致`).toBe(q.cost); // 数值也必须相等,不只是「都成功」
      await c.close();
    });
  }
});

// ── 非法表:两条路对同一个非法值必须给出同一个结论 ──────────────────────────
// 这些参数**单看每个字段都合法**(类型对、范围看起来也没问题),只有结合所选模型才知道非法 ——
// 静态 zod schema 表达不了,只能靠两条路跑同一个 builder 来保证一致。
// 每一条都对应一处 v0.9.1 实测存在的 estimateJob/builder 分歧。
describe('dry_run 对称性 — 非法参数(两条路结论必须一致)', () => {
  const illegal = () => [
    { name: 'duration 超模型 durationRange(estimateJob 曾静默 clamp 给价)',
      tool: 'generate_video', args: { prompt: 'x', duration: 999 } },
    { name: 'i2v duration 超范围',
      tool: 'generate_video_from_image', args: { task: 'first_frame', imageRefs: [imgRef], duration: 999 } },
    { name: 'resolution 不在模型 resolutions 内(estimateJob 曾透传按 1080 计价)',
      tool: 'generate_video_from_image', args: { task: 'first_frame', imageRefs: [imgRef], resolution: '4320P' } },
    { name: 'voice_ref 伪造(estimateJob 曾完全不读 voiceRef)',
      tool: 'generate_speech', args: { text: '你好', voice_ref: 'no-such-voice' } },
    { name: 'i2v first_frame 传了 2 张图(张数与 task 不匹配)',
      tool: 'generate_video_from_image', args: { task: 'first_frame', imageRefs: [imgRef, imgRef2] } },
    { name: 'i2v first_last 只传 1 张图',
      tool: 'generate_video_from_image', args: { task: 'first_last', imageRefs: [imgRef] } },
    { name: 'edit_video 的 videoRef 不存在(sidecar 读不到)',
      tool: 'edit_video', args: { videoRef: `video-inputs/${'x'.repeat(8)}/nope.mp4`, prompt: '换装' } },
    { name: 'r2v 只给音频没有画面来源',
      tool: 'generate_video_from_refs', args: { prompt: '', audioRefs: [`audio-inputs/${'x'.repeat(8)}/a.mp3`] } },
  ];

  for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
    it(`[${idx}] 两条路同拒`, async () => {
      const c = await mcp();
      const { name, tool, args } = illegal()[idx]!;
      const quote = await c.callTool({ name: tool, arguments: { ...args, dry_run: true } });
      const submit = await c.callTool({ name: tool, arguments: args });
      expect(quote.isError, `${name}:dry_run 放行了,但提交会拒 —— 这正是要防的分裂`).toBe(true);
      expect(submit.isError, `${name}:提交竟然放行了`).toBe(true);
      // 错误必须带机器可读码,否则 Agent 会把「参数错」当「临时故障」一路重试到限速
      expect(sc(quote).code).toBeTruthy();
      expect(sc(submit).code).toBeTruthy();
      await c.close();
    });
  }

  it('跨租户素材在两条路上都被拦(quoteJob 与 submitJob 同一道 checkRefsOwned)', async () => {
    const other = createTenant('别家').id;
    const forged = `image-inputs/${other}/deadbeef.png`;
    const c = await mcp();
    const quote = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { task: 'first_frame', imageRefs: [forged], dry_run: true },
    });
    const submit = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { task: 'first_frame', imageRefs: [forged] },
    });
    expect(quote.isError).toBe(true);
    expect(submit.isError).toBe(true);
    expect(sc(quote).error).toContain('不属于本机构');
    await c.close();
  });
});

// ── 幂等(D6)────────────────────────────────────────────────────────────────
describe('idempotency_key — 超时重试不双扣', () => {
  it('同 key 同参数重放 → 同一个 job_id,积分只扣一次', async () => {
    const c = await mcp();
    const k = 'idem-test-同一次请求';
    const before = balance(tId);
    const a = await c.callTool({
      name: 'generate_image',
      arguments: { prompt: '幂等测试图', count: 1, idempotency_key: k },
    });
    const afterFirst = balance(tId);
    const b = await c.callTool({
      name: 'generate_image',
      arguments: { prompt: '幂等测试图', count: 1, idempotency_key: k },
    });
    expect(sc(b).job_id).toBe(sc(a).job_id);
    expect(balance(tId)).toBe(afterFirst);           // 第二次没再扣
    expect(afterFirst).toBeLessThan(before);          // 第一次确实扣了
    await c.close();
  });

  it('同 key 不同参数 → IDEMPOTENCY_CONFLICT(不会张冠李戴)', async () => {
    const c = await mcp();
    const k = 'idem-conflict-key';
    await c.callTool({ name: 'generate_image', arguments: { prompt: '第一版', count: 1, idempotency_key: k } });
    const b = await c.callTool({ name: 'generate_image', arguments: { prompt: '换了个提示词', count: 1, idempotency_key: k } });
    expect(b.isError).toBe(true);
    expect(sc(b).code).toBe('IDEMPOTENCY_CONFLICT');
    await c.close();
  });

  it('不传 key → 每次都是新任务(想再来一张就别复用 key)', async () => {
    const c = await mcp();
    const a = await c.callTool({ name: 'generate_image', arguments: { prompt: '再来一张', count: 1 } });
    const b = await c.callTool({ name: 'generate_image', arguments: { prompt: '再来一张', count: 1 } });
    expect(sc(b).job_id).not.toBe(sc(a).job_id);
    await c.close();
  });
});

// ── quoteJob 存在的理由(回归护栏)────────────────────────────────────────
// 把「estimateJob 比 builder 松」这件事本身钉成测试。若将来有人图省事把 dry_run 改回
// estimateJob(看起来「少一个函数」),下面这组断言会立刻红 —— 而不是等 Agent 在生产上
// 拿着一个报价去撞 400。
//
// 注:estimateJob **不是 bug**,它是网页端实时报价故意做松的(用户还没选音色就得能出个数)。
// 两个函数各司其职;彻底统一需要同时改前端,见 TODOS.md 的 T-ESTIMATE-BUILDER-DRY。
describe('quoteJob 严于 estimateJob —— dry_run 必须走前者', () => {
  const divergent: [string, Record<string, unknown>][] = [
    ['t2v duration 超范围', { type: 'video_t2v', prompt: 'x', duration: 999 }],
    ['i2v resolution 非法', { type: 'video_i2v', task: 'first_frame', imageRefs: [], resolution: '4320P' }],
    ['tts voiceRef 伪造', { type: 'tts', text: '你好', voiceRef: 'nope' }],
    ['tts text 为空', { type: 'tts', text: '', voiceRef: 'nope' }],
    ['ai_music 缺 mode', { type: 'ai_music', prompt: 'x' }],
    ['ai_image prompt 为空', { type: 'ai_image', prompt: '', count: 1 }],
  ];

  for (const [name, body] of divergent) {
    it(`${name}:estimateJob 放行给价,quoteJob 拒`, async () => {
      const { estimateJob, quoteJob } = await import('../src/api/jobs.js');
      const uid = (db.prepare(`SELECT id FROM user WHERE tenant_id=? LIMIT 1`).get(tId) as { id: string }).id;
      const loose = await estimateJob(tId, body);
      const strict = await quoteJob(tId, uid, body);
      expect(loose.ok, `${name}:estimateJob 变严了 —— 说明它已被收口,本护栏可以退休`).toBe(true);
      expect(strict.ok, `${name}:quoteJob 放行了,dry_run 会给出提交不了的报价`).toBe(false);
    });
  }
});
