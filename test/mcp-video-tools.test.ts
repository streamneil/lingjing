// MCP 影片工具族 + 发现工具投影 + 协议层(v0.9.2 全量补全)。
//
// 补的是 v0.9.1 的覆盖缺口:平台 8 类创作能力,MCP 只暴露了 3 类,且 generate_music 必然失败
// (schema 只有 prompt,builder 却要求 mode,zod 还会把手动补的 mode 剥掉 → Agent 无法自救)。
//
// 本文件只测 **MCP 这道缝**:zod schema → 参数映射 → quoteJob/submitJob 的接线。
// builder 的业务逻辑(校验规则、计价、快照)已由 img2video-api / ref-video-api / video-edit-api /
// ai-music 等测试覆盖,不重复。

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Client as McpSdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
// 本文件要打 60+ 次 tools/call。写限速(默认 60/min/密钥)有 mcp-inflight-bytes 与生产口径单独覆盖,
// 在这里触发只会把「工具行为」测试变成「限速」测试,且随用例增减而随机翻车。
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
let probeResult: { duration: number; width: number; height: number } | null = { duration: 8, width: 1920, height: 1080 };
vi.mock('../src/pipeline/ai-label.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline/ai-label.js')>();
  return { ...actual, probeVideoMeta: vi.fn(async () => probeResult) };
});

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');
const { serverPort } = await import('./helpers.js');

seedPlatformDefaults();
const app = createApp();
// probeResult 是模块级可变状态。用例内改完若中途抛错就不会复原,后续 upload_video 会全线
// 「无法解析视频」把真正的失败埋掉 —— 统一在 afterEach 复位。
afterEach(() => { probeResult = { duration: 8, width: 1920, height: 1080 }; });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const mp4 = (salt: string) => Buffer.concat([Buffer.from('ftypisom-fake-mp4'), Buffer.from(salt)]);
const mp3 = (salt: string) => Buffer.concat([Buffer.from('ID3-fake-mp3'), Buffer.from(salt)]);

let port = 0;
let key = '';
let tId = '';
let imgA = '';
let imgB = '';
let uid = '';  // 本测试租户里「API 密钥代表的那个人」——投影测试要用它当 created_by

async function mcp() {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const c = new McpSdkClient({ name: 'video-tools-agent', version: '1.0.0' });
  await c.connect(transport);
  return c;
}
type Sc = Record<string, unknown>;
// callTool 的返回是联合类型(有一支不带 structuredContent),故入参收 unknown 再取。
const sc = (r: unknown): Sc => ((r as { structuredContent?: unknown }).structuredContent ?? {}) as Sc;

beforeAll(async () => {
  tId = createTenant('影片工具台').id;
  uid = (await createUser(tId, 'videotools', 'pw123456', 'creator')).id;
  grant(tId, 10_000_000);
  key = createApiKey(tId, uid, 'vt-key').key;
  port = await serverPort(app);

  const c = await mcp();
  const up = await c.callTool({
    name: 'upload_image',
    arguments: {
      images: [
        { filename: 'first.png', data_base64: PNG.toString('base64') },
        { filename: 'last.png', data_base64: Buffer.concat([PNG, Buffer.from('LAST')]).toString('base64') },
      ],
      consent: true,
    },
  });
  const refs = (up.structuredContent as { imageRefs: string[] }).imageRefs;
  imgA = refs[0]!; imgB = refs[1]!;
  await c.close();
}, 60000);

// ── 协议层 ────────────────────────────────────────────────────────────────
describe('协议层 — 工具全集 / instructions / version', () => {
  it('tools/list 暴露全部 17 个工具(逐一断言,不是只查几个)', async () => {
    const c = await mcp();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'edit_video', 'estimate', 'generate_image', 'generate_music', 'generate_speech',
      'generate_video', 'generate_video_from_image', 'generate_video_from_refs',
      'get_balance', 'get_job', 'list_avatars', 'list_jobs', 'list_models', 'list_voices',
      'upload_audio', 'upload_image', 'upload_video',
    ].sort());
    await c.close();
  });

  it('instructions 非空,且写清了 MCP 做不到的事(避免 Agent 反复试不存在的工具)', async () => {
    const c = await mcp();
    const ins = c.getInstructions(); // 来自 initialize,**不在** tools/list 里
    expect(ins).toBeTruthy();
    expect(ins).toContain('数字人口播');   // 平台有但 MCP 没有 → 必须明说
    expect(ins).toContain('声音克隆');
    expect(ins).toContain('dry_run');      // 先问价
    expect(ins).toContain('idempotency_key'); // 重试别双扣
    expect(ins).toContain('consent');      // 合规红线
    expect(ins).toContain('≥5 秒');        // 轮询节奏
    await c.close();
  });

  it('serverInfo.version 与 package.json 一致(T-MCP-VERSION-DRIFT:不再写死)', async () => {
    const c = await mcp();
    const pkg = JSON.parse(
      (await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(c.getServerVersion()?.version).toBe(pkg.version);
    // 再钉一道:VERSION 文件与 package.json 必须同步。只断言「等于 package.json」的话,
    // 发版时只改了 VERSION 没改 package.json,握手依然回旧版本号 —— 漂移换了扇门溜回来。
    const versionFile = (await import('node:fs'))
      .readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
    expect(pkg.version, 'VERSION 与 package.json 不一致 —— MCP 握手会回错版本号').toBe(versionFile);
    await c.close();
  });

  it('只读工具标了 readOnlyHint,花钱的工具没标(客户端据此决定要不要向用户确认)', async () => {
    const c = await mcp();
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['get_job', 'list_jobs', 'get_balance', 'list_models', 'list_voices', 'list_avatars']) {
      expect(byName[n]!.annotations?.readOnlyHint, `${n} 应为只读`).toBe(true);
    }
    for (const n of ['generate_image', 'generate_video_from_image', 'edit_video', 'upload_video']) {
      expect(byName[n]!.annotations?.readOnlyHint, `${n} 会花钱/写数据,不该标只读`).toBe(false);
    }
    await c.close();
  });
});

// ── 上传工具 ──────────────────────────────────────────────────────────────
describe('upload_video — 视频进 MCP 的唯一入口', () => {
  it('happy:返回 videoRef + 时长尺寸,视频与 sidecar 真落存储', async () => {
    probeResult = { duration: 8, width: 1920, height: 1080 };
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'ok.mp4', data_base64: mp4('happy').toString('base64'), consent: true },
    });
    const s = sc(r);
    expect(r.isError).toBeFalsy();
    expect(s.videoRef as string).toMatch(new RegExp(`^video-inputs/${tId}/`));
    expect(s.duration).toBe(8);
    expect(mem.has(`${s.videoRef}.meta.json`)).toBe(true);
    await c.close();
  });

  it('consent 缺省 → zod 层就拒(合规闸,Agent 绕不过)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'x.mp4', data_base64: mp4('noconsent').toString('base64') },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it('consent=false → 拒(与 REST 同口径)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'x.mp4', data_base64: mp4('false').toString('base64'), consent: false },
    });
    expect(r.isError).toBe(true);
    expect(String(sc(r).error)).toContain('授权');
    await c.close();
  });

  it('非 .mp4/.mov 扩展名 → INVALID_INPUT_FILE(不猜 MIME)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'x.avi', data_base64: mp4('avi').toString('base64'), consent: true },
    });
    expect(r.isError).toBe(true);
    expect(sc(r).code).toBe('INVALID_INPUT_FILE');
    await c.close();
  });

  it('ffprobe 失败 → 拒(时长是计费真相,不优雅放行)', async () => {
    probeResult = null;
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'broken.mp4', data_base64: mp4('broken').toString('base64'), consent: true },
    });
    probeResult = { duration: 8, width: 1920, height: 1080 };
    expect(r.isError).toBe(true);
    expect(String(sc(r).error)).toContain('无法解析视频');
    await c.close();
  });

  it('时长越界 → 拒', async () => {
    probeResult = { duration: 90, width: 1920, height: 1080 };
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'long.mp4', data_base64: mp4('long').toString('base64'), consent: true },
    });
    probeResult = { duration: 8, width: 1920, height: 1080 };
    expect(r.isError).toBe(true);
    expect(String(sc(r).error)).toContain('2-60 秒');
    await c.close();
  });

  it('重传同一视频 → 同一个 videoRef(内容寻址,重试不产生孤儿对象)', async () => {
    const c = await mcp();
    const args = { filename: 'retry.mp4', data_base64: mp4('mcp-retry').toString('base64'), consent: true };
    const a = await c.callTool({ name: 'upload_video', arguments: args });
    const b = await c.callTool({ name: 'upload_video', arguments: args });
    expect(sc(b).videoRef).toBe(sc(a).videoRef);
    await c.close();
  });
});

describe('upload_audio — 参考音频', () => {
  it('happy:返回 audioRef,字节真落存储', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'bgm.mp3', data_base64: mp3('happy').toString('base64'), consent: true },
    });
    expect(r.isError).toBeFalsy();
    expect(sc(r).audioRef as string).toMatch(new RegExp(`^audio-inputs/${tId}/`));
    await c.close();
  });

  it('非音频扩展名 → INVALID_INPUT_FILE', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'x.ogg', data_base64: mp3('ogg').toString('base64'), consent: true },
    });
    expect(r.isError).toBe(true);
    expect(sc(r).code).toBe('INVALID_INPUT_FILE');
    await c.close();
  });
});

// ── 图转影片(用户点名功能之一)────────────────────────────────────────────
describe('generate_video_from_image — 三种 task 全覆盖', () => {
  it('★ 闭环:upload_image → from_image(first_frame) → get_job', async () => {
    const c = await mcp();
    const gen = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { task: 'first_frame', imageRefs: [imgA], prompt: '让画面动起来' },
    });
    const jobId = sc(gen).job_id as string;
    expect(jobId).toBeTruthy();
    const row = getJob(jobId)!;
    expect(row.tenant_id).toBe(tId);
    expect(row.type).toBe('video_i2v');
    expect(row.channel).toBe('mcp'); // 记录卡显「MCP 创建」
    const input = JSON.parse(row.input_json) as { task: string; imageRefs: string[] };
    expect(input.task).toBe('first_frame');
    expect(input.imageRefs).toEqual([imgA]);
    const got = await c.callTool({ name: 'get_job', arguments: { job_id: jobId } });
    expect(['queued', 'running', 'done', 'failed']).toContain(sc(got).status);
    await c.close();
  });

  it('first_last:两张图按「开始图、结束图」顺序入 input', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { task: 'first_last', imageRefs: [imgA, imgB] },
    });
    expect(r.isError).toBeFalsy();
    const input = JSON.parse(getJob(sc(r).job_id as string)!.input_json) as { imageRefs: string[] };
    expect(input.imageRefs).toEqual([imgA, imgB]);
    await c.close();
  });

  // task 是**模型能力**,不是全局开关:默认 i2v 模型只声明 first_frame。Agent 的正确姿势是
  // 先 list_models 挑一个 tasks 含 reference 的模型再传 —— 这条测试就照这个姿势走一遍,
  // 顺带验证 list_models 吐出的 tasks 字段确实能指导选型(不是摆设)。
  it('reference:先按 list_models 的 tasks 选模型,再传 → 入队', async () => {
    const c = await mcp();
    const models = sc(await c.callTool({ name: 'list_models', arguments: { kind: 'i2v' } }))
      .models as { key: string; tasks: string[] }[];
    const m = models.find((x) => x.tasks?.includes('reference'));
    expect(m, 'list_models(i2v) 应至少有一个支持 reference 的模型').toBeTruthy();
    const r = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { task: 'reference', imageRefs: [imgA], prompt: '照 [图1] 的风格', model: m!.key },
    });
    expect(r.isError, String(sc(r).error)).toBeFalsy();
    expect(JSON.parse(getJob(sc(r).job_id as string)!.input_json).task).toBe('reference');
    await c.close();
  });

  it('给不支持该 task 的模型传 reference → 明确报错(不静默降级成首帧)', async () => {
    const c = await mcp();
    const models = sc(await c.callTool({ name: 'list_models', arguments: { kind: 'i2v' } }))
      .models as { key: string; tasks: string[] }[];
    const noRef = models.find((x) => !x.tasks?.includes('reference'));
    // 静默 return 会让这条护栏在「所有模型都支持 reference」时永远绿而不提示。
    expect(noRef, '所有 i2v 模型都支持 reference —— 本护栏失去意义,需改造').toBeTruthy();
    if (!noRef) return;
    const r = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { task: 'reference', imageRefs: [imgA], prompt: 'x', model: noRef.key },
    });
    expect(r.isError).toBe(true);
    expect(String(sc(r).error)).toContain('不支持');
    await c.close();
  });

  it('task 缺省 → zod 拒,且错误里能看到三个合法值(Agent 能自我纠正)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'generate_video_from_image',
      arguments: { imageRefs: [imgA] },
    });
    expect(r.isError).toBe(true);
    // 错误里必须能看到合法取值 —— 否则 Agent 只知道「错了」,不知道该填什么,会瞎试
    expect(JSON.stringify(r)).toMatch(/first_frame/);
    await c.close();
  });
});

// ── 参考生成影片(用户点名功能之二)────────────────────────────────────────
describe('generate_video_from_refs — 多模态组合', () => {
  it('纯图片参考即可跑通(videoRefs/audioRefs 都是可选的)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'generate_video_from_refs',
      arguments: { prompt: '按 [图1] 生成一段影片', imageRefs: [imgA] },
    });
    expect(r.isError).toBeFalsy();
    expect(getJob(sc(r).job_id as string)!.type).toBe('video_r2v');
    await c.close();
  });

  it('图 + 视频 + 音频三模态一起传 → 三种 ref 都进 input', async () => {
    const c = await mcp();
    const uv = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'ref.mp4', data_base64: mp4('r2v-ref').toString('base64'), consent: true },
    });
    const ua = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'ref.mp3', data_base64: mp3('r2v-ref').toString('base64'), consent: true },
    });
    const r = await c.callTool({
      name: 'generate_video_from_refs',
      arguments: {
        prompt: '融合 [图1] [视频1] [音频1]',
        imageRefs: [imgA],
        videoRefs: [sc(uv).videoRef as string],
        audioRefs: [sc(ua).audioRef as string],
      },
    });
    // 默认 r2v 模型(doubao-seedance-2.0)声明了 maxVideoRefs=3 / maxAudioRefs=3,所以这里
    // 必须硬断言。原先写成 if (r.isError) 双分支是多余的对冲 —— 那样即使三模态提交根本没通,
    // 测试也会绿,等于没测。
    expect(r.isError, `三模态提交失败:${String(sc(r).error)}`).toBeFalsy();
    const input = JSON.parse(getJob(sc(r).job_id as string)!.input_json) as
      { imageRefs?: string[]; videoRefs?: string[]; audioRefs?: string[] };
    expect(input.imageRefs, '图参考没进 input').toBeTruthy();
    expect(input.videoRefs, '视频参考被静默丢弃 —— 用户付了钱拿到不含参考的结果').toBeTruthy();
    expect(input.audioRefs, '音频参考被静默丢弃').toBeTruthy();
    await c.close();
  });

  it('默认 Seedance 2.0 只有音频、没有画面来源 → 拒', async () => {
    const c = await mcp();
    const ua = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'only.mp3', data_base64: mp3('only-audio').toString('base64'), consent: true },
    });
    const r = await c.callTool({
      name: 'generate_video_from_refs',
      arguments: { audioRefs: [sc(ua).audioRef as string] },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it('Seedance 2.5 只有音频、没有 prompt → 入队', async () => {
    const c = await mcp();
    const ua = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 's25-only.mp3', data_base64: mp3('s25-only-audio').toString('base64'), consent: true },
    });
    const r = await c.callTool({
      name: 'generate_video_from_refs',
      arguments: {
        model: 'doubao-seedance-2.5', audioRefs: [sc(ua).audioRef as string],
        resolution: '480P', duration: 30,
      },
    });
    expect(r.isError, String(sc(r).error)).toBeFalsy();
    const input = JSON.parse(getJob(sc(r).job_id as string)!.input_json) as Record<string, unknown>;
    expect(input.audioRefs).toEqual([sc(ua).audioRef]);
    expect(input.resSnapshot).toBe('480P');
    expect(input.durationSnapshot).toBe(30);
    await c.close();
  });
});

// ── 影片编辑 ──────────────────────────────────────────────────────────────
describe('edit_video — 影片编辑闭环', () => {
  it('★ 闭环:upload_video → edit_video → get_job,计费秒读服务端 sidecar', async () => {
    probeResult = { duration: 8, width: 1920, height: 1080 };
    const c = await mcp();
    const uv = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'edit-src.mp4', data_base64: mp4('edit-closure').toString('base64'), consent: true },
    });
    const r = await c.callTool({
      name: 'edit_video',
      arguments: { videoRef: sc(uv).videoRef as string, prompt: '把外套换成红色风衣' },
    });
    expect(r.isError, String(sc(r).error)).toBeFalsy();
    const row = getJob(sc(r).job_id as string)!;
    expect(row.type).toBe('video_edit');
    const input = JSON.parse(row.input_json) as { inputDurationSnapshot?: number };
    expect(input.inputDurationSnapshot).toBe(8); // 时长来自服务端探测,不是客户端上报
    await c.close();
  });

  it('videoRef 缺省 → zod 拒', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'edit_video', arguments: { prompt: '换装' } });
    expect(r.isError).toBe(true);
    await c.close();
  });
});

// ── 音乐修复(v0.9.1 的死工具)──────────────────────────────────────────────
describe('generate_music — 修复 v0.9.1 的必然失败', () => {
  it('mode=instrumental + prompt → 真入队(旧版此路必然 400)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'generate_music',
      arguments: { mode: 'instrumental', prompt: '轻快的电子舞曲,适合短视频片头' },
    });
    expect(r.isError, String(sc(r).error)).toBeFalsy();
    expect(getJob(sc(r).job_id as string)!.type).toBe('ai_music');
    await c.close();
  });

  it('mode=song + lyrics + gender → 真入队', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'generate_music',
      arguments: { mode: 'song', lyrics: '春天的风吹过山岗\n带来远方的消息', gender: 'female' },
    });
    expect(r.isError, String(sc(r).error)).toBeFalsy();
    const input = JSON.parse(getJob(sc(r).job_id as string)!.input_json) as { mode: string; gender?: string };
    expect(input.mode).toBe('song');
    expect(input.gender).toBe('female');
    await c.close();
  });

  it('缺 mode → zod 层拒,错误里列出两个合法值(旧版这里是死路)', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'generate_music', arguments: { prompt: '轻快的电子舞曲' } });
    expect(r.isError).toBe(true);
    const blob = JSON.stringify(r);
    expect(blob).toMatch(/instrumental/);
    expect(blob).toMatch(/song/);
    await c.close();
  });

  it('纯音乐不能带歌词 → 拒(builder 口径透传到 MCP)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'generate_music',
      arguments: { mode: 'instrumental', prompt: 'x', lyrics: '不该有的歌词' },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });
});

// ── TTS 参数补齐 ──────────────────────────────────────────────────────────
describe('generate_speech — 情绪/语速/音高/语言', () => {
  it('四个参数都透传进 job input', async () => {
    const c = await mcp();
    const voices = sc(await c.callTool({ name: 'list_voices', arguments: {} })).voices as { id: string }[];
    const { EMOTIONS, SPEEDS, LANGUAGES } = await import('../src/gateway/tts-models.js');
    const emotion = Object.keys(EMOTIONS).find((k) => k !== 'auto')!;
    const rate = Object.keys(SPEEDS).find((k) => k !== 'normal')!;
    const language = Object.keys(LANGUAGES).find((k) => k !== 'Auto')!;
    const r = await c.callTool({
      name: 'generate_speech',
      arguments: { text: '你好,世界', voice_ref: voices[0]!.id, emotion, rate, pitch: 3, language },
    });
    expect(r.isError, String(sc(r).error)).toBeFalsy();
    const input = JSON.parse(getJob(sc(r).job_id as string)!.input_json) as Record<string, unknown>;
    expect(input.emotion).toBe(emotion);
    expect(input.rate).toBe(rate);
    expect(input.pitch).toBe(3);
    expect(input.language).toBe(language);
    await c.close();
  });

  it('非法 emotion → zod 拒(枚举取自注册表,不硬编码 → 永不与 tts-models 漂)', async () => {
    const c = await mcp();
    const voices = sc(await c.callTool({ name: 'list_voices', arguments: {} })).voices as { id: string }[];
    const r = await c.callTool({
      name: 'generate_speech',
      arguments: { text: '你好', voice_ref: voices[0]!.id, emotion: '不存在的情绪' },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it('pitch 越界 → zod 拒', async () => {
    const c = await mcp();
    const voices = sc(await c.callTool({ name: 'list_voices', arguments: {} })).voices as { id: string }[];
    const r = await c.callTool({
      name: 'generate_speech',
      arguments: { text: '你好', voice_ref: voices[0]!.id, pitch: 99 },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });
});

// ── 发现工具投影(D13:不泄漏厂商栈)──────────────────────────────────────
describe('发现工具 — 不泄漏内部字段', () => {
  const FORBIDDEN = ['modelId', 'provider', 'priceTier', 'priceTier1080', 'priceTierAudio', 'priceTierAudio1080'];

  for (const kind of ['image', 'video', 'i2v', 'r2v', 'edit'] as const) {
    it(`list_models({kind:"${kind}"}) 不含 modelId / provider / priceTier*`, async () => {
      const c = await mcp();
      const r = await c.callTool({ name: 'list_models', arguments: { kind } });
      const models = sc(r).models as Record<string, unknown>[];
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        for (const f of FORBIDDEN) {
          expect(Object.hasOwn(m, f), `${kind} 模型泄漏了 ${f} —— 与 PRD §0.1 能力网关原则相悖`).toBe(false);
        }
        expect(m.key).toBeTruthy();   // 但 Agent 选模型需要的字段必须在
        expect(m.label).toBeTruthy();
      }
      await c.close();
    });
  }

  // 关键:必须先往库里插一条**真的克隆音色 / 自定义形象**再断言。
  // 只有 DB 行才带 provider_voice_id / source_key / authorization_id —— 平台预置项压根没有这些字段,
  // 所以「只遍历预置项」的断言在构造上不可能失败,是一条假测试(ship 覆盖率审计抓到的)。
  it('list_voices 不泄漏 provider_voice_id / source_key / authorization_id(对真实克隆音色行断言)', async () => {
    const vid = `clone-${Date.now()}`;
    db.prepare(
      `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,provider_voice_id,authorization_id,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(vid, tId, '我的克隆音色', 'clone', 'ready',
      `voice-samples/${tId}/secret-sample.wav`, 'bailian-voice-xyz-789', 'auth-row-id-123',
      uid, Date.now()); // 必须是密钥代表的那个人:listClones 按 created_by 过滤,取错人这行就被过滤掉了

    const c = await mcp();
    const voices = sc(await c.callTool({ name: 'list_voices', arguments: {} })).voices as Record<string, unknown>[];
    const mine = voices.find((v) => v.id === vid);
    expect(mine, '克隆音色应出现在列表里 —— 否则本测试又变回只看预置项').toBeTruthy();
    for (const f of ['provider_voice_id', 'source_key', 'authorization_id', 'tenant_id', 'created_by']) {
      expect(Object.hasOwn(mine!, f), `音色泄漏了 ${f}(厂商栈/存储路径不该出 API)`).toBe(false);
    }
    // 反向确认:泄漏的字段在库里**确实存在**,证明投影真的把它们挡掉了,不是「本来就没有」
    const raw = db.prepare(`SELECT * FROM voice WHERE id=?`).get(vid) as Record<string, unknown>;
    expect(raw.provider_voice_id).toBe('bailian-voice-xyz-789');
    expect(raw.source_key).toBeTruthy();
    // Agent 真正需要的字段必须留下
    expect(mine!.id).toBe(vid);
    expect(mine!.name).toBe('我的克隆音色');
    expect(mine!.status).toBe('ready');
    await c.close();
  });

  it('list_avatars 不泄漏 source_key / authorization_id / thumb_url(对真实自定义形象行断言)', async () => {
    const aid = `custom-${Date.now()}`;
    db.prepare(
      `INSERT INTO avatar (id,tenant_id,name,kind,status,source_key,thumb_url,authorization_id,orientation,is_default,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(aid, tId, '我的形象', 'photo', 'ready',
      `avatars/${tId}/secret-source.png`, `avatars/${tId}/secret-thumb.png`, 'auth-row-id-456',
      'portrait', 0, uid, Date.now()); // 必须是密钥代表的那个人:listClones 按 created_by 过滤,取错人这行就被过滤掉了

    const c = await mcp();
    const avatars = sc(await c.callTool({ name: 'list_avatars', arguments: {} })).avatars as Record<string, unknown>[];
    const mine = avatars.find((a) => a.id === aid);
    expect(mine, '自定义形象应出现在列表里').toBeTruthy();
    for (const f of ['source_key', 'thumb_url', 'authorization_id', 'tenant_id', 'created_by', 'is_default']) {
      expect(Object.hasOwn(mine!, f), `形象泄漏了 ${f}`).toBe(false);
    }
    const raw = db.prepare(`SELECT * FROM avatar WHERE id=?`).get(aid) as Record<string, unknown>;
    expect(raw.source_key).toBeTruthy(); // 库里有,响应里没有 = 投影生效
    expect(mine!.name).toBe('我的形象');
    expect(mine!.status).toBe('ready');
    await c.close();
  });

  it('list_models 的 kind 不含 tts(TTS 无模型注册表;情绪/语速/语言写在 generate_speech 参数里)', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'list_models', arguments: { kind: 'tts' } });
    expect(r.isError).toBe(true); // 不是静默返回空数组 —— 那会让 Agent 以为「有但没配」
    await c.close();
  });
});

// ── 余额 / 任务列表 ───────────────────────────────────────────────────────
describe('get_balance / list_jobs — Agent 自查', () => {
  it('get_balance 返回本机构积分', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'get_balance', arguments: {} });
    expect(typeof sc(r).balance).toBe('number');
    expect(sc(r).balance as number).toBeGreaterThan(0);
    await c.close();
  });

  it('list_jobs 能找回之前提交的 job_id,且不含产物 URL(省无用签名)', async () => {
    const c = await mcp();
    const gen = await c.callTool({ name: 'generate_image', arguments: { prompt: '列表用', count: 1 } });
    const jobId = sc(gen).job_id as string;
    const r = await c.callTool({ name: 'list_jobs', arguments: { limit: 50 } });
    const jobs = sc(r).jobs as Record<string, unknown>[];
    expect(jobs.some((j) => j.job_id === jobId)).toBe(true);
    for (const j of jobs) {
      expect(Object.hasOwn(j, 'results')).toBe(false);
      expect(Object.hasOwn(j, 'output_url')).toBe(false);
    }
    await c.close();
  });

  it('list_jobs 账号隔离:看不到同租户其他成员的任务', async () => {
    const otherUid = (await createUser(tId, 'coworker', 'pw123456', 'creator')).id;
    const otherKey = createApiKey(tId, otherUid, 'coworker-key').key;
    // 同事提交一个任务
    const t2 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${otherKey}` } },
    });
    const c2 = new McpSdkClient({ name: 'coworker', version: '1.0.0' });
    await c2.connect(t2);
    const theirs = sc(await c2.callTool({ name: 'generate_image', arguments: { prompt: '同事的图', count: 1 } })).job_id;
    await c2.close();

    const c = await mcp();
    const jobs = sc(await c.callTool({ name: 'list_jobs', arguments: { limit: 100 } })).jobs as { job_id: string }[];
    expect(jobs.some((j) => j.job_id === theirs)).toBe(false);
    // 也不能用 get_job 直接撬
    const peek = await c.callTool({ name: 'get_job', arguments: { job_id: String(theirs) } });
    expect(peek.isError).toBe(true);
    expect(sc(peek).code).toBe('NOT_FOUND');
    await c.close();
  });

  it('list_jobs limit 超上限 → zod 拒并在错误里点明上限(Agent 能自我纠正)', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'list_jobs', arguments: { limit: 10000 } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r), '错误里没写上限,Agent 不知道该改成多少').toMatch(/100/);
    await c.close();
  });
});

// ── 错误码契约 ────────────────────────────────────────────────────────────
describe('错误码 — 每个码都可达且机器可读', () => {
  it('参数错 → INVALID_PARAMS(不该重试)', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'generate_image', arguments: { prompt: '', count: 1 } });
    expect(r.isError).toBe(true);
    expect(sc(r).code).toBe('INVALID_PARAMS');
    await c.close();
  });

  it('任务不存在 → NOT_FOUND', async () => {
    const c = await mcp();
    const r = await c.callTool({ name: 'get_job', arguments: { job_id: 'no-such-job' } });
    expect(sc(r).code).toBe('NOT_FOUND');
    await c.close();
  });

  it('坏文件 → INVALID_INPUT_FILE', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'x.heic', data_base64: PNG.toString('base64') }], consent: true },
    });
    expect(sc(r).code).toBe('INVALID_INPUT_FILE');
    await c.close();
  });

  it('所有错误都带 code —— 没有码的错误 Agent 无法分类', async () => {
    const c = await mcp();
    const cases = [
      { name: 'generate_music', arguments: { mode: 'instrumental' } },              // 缺 prompt
      { name: 'edit_video', arguments: { videoRef: `video-inputs/${tId}/nope.mp4`, prompt: 'x' } },
      { name: 'generate_speech', arguments: { text: 'x', voice_ref: 'nope' } },
    ];
    for (const args of cases) {
      const r = await c.callTool(args as never);
      expect(r.isError, `${args.name} 应报错`).toBe(true);
      expect(sc(r).code, `${args.name} 的错误缺 code`).toBeTruthy();
    }
    await c.close();
  });
});

// ── ship 覆盖率审计补充(v0.9.2)────────────────────────────────────────────
// 下面这批来自 /ship Step 7 的覆盖率审计:被点名为「instructions 里承诺了行为、
// 但一条测试都没有」的路径。Agent 会照着 instructions 处理这些错误码,没测过等于没承诺。
// 角色已精简为 admin/creator(db/index.ts:392 有 viewer→creator 迁移),所以 createUser 造不出
// 非法角色 —— 但 user.role 列没有 CHECK 约束,手工改库或未来新增只读角色时未知角色会出现。
// 这条测试直接写库制造那种状态,证明守卫的默认是**拒绝**而不是放行(删了守卫这条就红)。
describe('角色闸 — 未知角色默认拒绝(防御纵深)', () => {
  it('库里被塞进未知角色的密钥 → 403 ROLE_FORBIDDEN,且在 body parser 之前', async () => {
    const vUid = (await createUser(tId, 'roleguard-user', 'pw123456', 'creator')).id;
    const vKey = createApiKey(tId, vUid, 'roleguard-key').key;
    db.prepare(`UPDATE user SET role='viewer' WHERE id=?`).run(vUid); // 绕过 createUser 的角色校验
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('ROLE_FORBIDDEN'); // instructions 里写了这个码,必须真的可达
  });
});

describe('get_job 终态 — 每条 Agent 流程的最后一步', () => {
  it('done → results 带签名下载 URL', async () => {
    const { markDone } = await import('../src/queue/index.js');
    const c = await mcp();
    const gen = await c.callTool({ name: 'generate_image', arguments: { prompt: '终态测试', count: 1 } });
    const jobId = sc(gen).job_id as string;
    markDone(jobId, JSON.stringify(['outputs/x/a.png']), 'labeled', 'image');
    const r = await c.callTool({ name: 'get_job', arguments: { job_id: jobId } });
    const s = sc(r);
    expect(s.status).toBe('done');
    expect(Array.isArray(s.results), 'done 必须带 results,否则 Agent 拿不到成品').toBe(true);
    await c.close();
  });

  it('failed → error 是中文可读原因(不是原始厂商日志)', async () => {
    const { markFailed } = await import('../src/queue/index.js');
    const c = await mcp();
    const gen = await c.callTool({ name: 'generate_image', arguments: { prompt: '失败态测试', count: 1 } });
    const jobId = sc(gen).job_id as string;
    markFailed(jobId, 'DataInspectionFailed: content policy violation');
    const r = await c.callTool({ name: 'get_job', arguments: { job_id: jobId } });
    const s = sc(r);
    expect(s.status).toBe('failed');
    // 断言「翻译真的跑了」,不是「有个非空字符串」—— 后者在 markFailed 不翻译时照样绿。
    expect(s.error as string, '原始厂商日志漏给了 Agent').not.toContain('DataInspectionFailed');
    expect(s.error as string, 'error 应是中文可读原因').toMatch(/[\u4e00-\u9fa5]/);
    expect(Object.hasOwn(s, 'results'), '失败任务不该有 results').toBe(false);
    await c.close();
  });
});

describe('list_jobs 筛选', () => {
  it('按 status / type 筛都生效', async () => {
    const c = await mcp();
    await c.callTool({ name: 'generate_music', arguments: { mode: 'instrumental', prompt: '筛选用' } });
    const byType = sc(await c.callTool({ name: 'list_jobs', arguments: { type: 'ai_music', limit: 100 } }))
      .jobs as { type: string }[];
    expect(byType.length).toBeGreaterThan(0);
    expect(byType.every((j) => j.type === 'ai_music')).toBe(true);
    const byStatus = sc(await c.callTool({ name: 'list_jobs', arguments: { status: 'failed', limit: 100 } }))
      .jobs as { status: string }[];
    expect(byStatus.every((j) => j.status === 'failed')).toBe(true);
    await c.close();
  });
});

// ── 投影的正面契约(ship 覆盖率审计 GAP-G)────────────────────────────────
// 泄漏测试只证明「不该有的没有」。抽取时**漏掉**一个字段是反方向的错,而
// /api/video-models 与 /api/r2v-models 全仓没有任何测试 —— 漏了两边都发现不了,
// 表现是 Agent 拿不到 durationRange 之类的能力边界,只能猜参数然后撞 400。
describe('list_models 投影 — Agent 选参所需字段必须都在', () => {
  const required: Record<string, string[]> = {
    image: ['key', 'label', 'modes', 'maxImages', 'maxResolution'],
    video: ['key', 'label', 'shape', 'resolutions', 'durationRange', 'defaultDuration', 'maxPromptChars', 'supportsAudio'],
    i2v:   ['key', 'label', 'resolutions', 'durationRange', 'maxPromptChars', 'tasks', 'promptRequired'],
    r2v:   ['key', 'label', 'resolutions', 'durationRange', 'maxPromptChars', 'supportsAudio', 'maxRefImages', 'maxVideoRefs', 'maxAudioRefs', 'supportsAudioOnlyRefs'],
    edit:  ['key', 'label', 'resolutions', 'maxPromptChars', 'promptRequired', 'videoDurRange', 'supportsTruncate'],
  };
  for (const kind of Object.keys(required)) {
    it(`kind=${kind} 的每个模型都带齐能力字段`, async () => {
      const c = await mcp();
      const models = sc(await c.callTool({ name: 'list_models', arguments: { kind } }))
        .models as Record<string, unknown>[];
      expect(models.length, `${kind} 没有可用模型`).toBeGreaterThan(0);
      for (const m of models) {
        for (const f of required[kind]!) {
          expect(Object.hasOwn(m, f), `${kind} 模型 ${String(m.key)} 缺字段 ${f} —— Agent 会因此猜参数`).toBe(true);
        }
      }
      await c.close();
    });
  }

  it('Seedance 2.5 同时出现在 video/i2v/r2v,并向 Agent 暴露纯音频能力', async () => {
    const c = await mcp();
    for (const kind of ['video', 'i2v', 'r2v'] as const) {
      const models = sc(await c.callTool({ name: 'list_models', arguments: { kind } }))
        .models as Record<string, unknown>[];
      expect(models.some((m) => m.key === 'doubao-seedance-2.5')).toBe(true);
      if (kind === 'r2v') {
        const d = models.find((m) => m.key === 'doubao-seedance-2.5')!;
        expect(d.supportsAudioOnlyRefs).toBe(true);
        expect(d.maxRefImages).toBe(30);
        expect(d.maxVideoRefs).toBe(10);
        expect(d.maxAudioRefs).toBe(10);
      }
    }
    await c.close();
  });
});

// ── 评审修复的防回归钉子(ship 覆盖率再审:这些代码删掉后套件依然全绿)──────
// 每一条都对应本轮为响应专家评审而做的修复。修了不钉 = 等着它悄悄回来。
describe('评审修复防回归 — 删掉对应代码这里必须红', () => {
  it('generate_image 的 count 不再有 .max(9):超出模型上限时截断而非拒绝', async () => {
    // v0.9.1 没有这个上限,是我在 v0.9.2 加的 —— 对老调用方是破坏性变更,且 maxImages
    // 是超管在后台可改的,写死任何数字都会与配置漂。加回 .max(9) → 这条红。
    const c = await mcp();
    const r = await c.callTool({ name: 'generate_image', arguments: { prompt: '大数量', count: 25 } });
    expect(r.isError, `count:25 被拒了 —— schema 里又写死上限了:${String(sc(r).error)}`).toBeFalsy();
    const input = JSON.parse(getJob(sc(r).job_id as string)!.input_json) as { count: number };
    expect(input.count, '应被 clampImageCount 截到模型上限,而不是原样入库').toBeLessThanOrEqual(9);
    expect(input.count).toBeGreaterThan(0);
    await c.close();
  });

  it('edit_video 的 dry_run 回传 inputDuration(quoteJob 合并 builder 的 extra)', async () => {
    // quoteJob 若不合并 built.extra,这个既有响应字段就悄悄消失了 ——
    // 调用方无从知道这个价是按几秒算的。video-edit-api 测的是 estimateJob,是另一个函数。
    probeResult = { duration: 8, width: 1920, height: 1080 };
    const c = await mcp();
    const uv = await c.callTool({
      name: 'upload_video',
      arguments: { filename: 'quote-extra.mp4', data_base64: mp4('quote-extra').toString('base64'), consent: true },
    });
    const r = await c.callTool({
      name: 'edit_video',
      arguments: { videoRef: sc(uv).videoRef as string, prompt: '换装', dry_run: true },
    });
    const s = sc(r);
    expect(r.isError, String(s.error)).toBeFalsy();
    expect(s.inputDuration, 'quoteJob 丢掉了 builder 的 extra').toBe(8);
    expect(typeof s.cost).toBe('number');
    expect(typeof s.balance).toBe('number'); // balance 也还在,合并没覆盖掉它
    await c.close();
  });

  it('MCP upload_audio 的 consent 闸与 REST 同口径(consent=false → 拒)', async () => {
    // upload_video 早有这条,audio 此前没有 —— 不对称意味着把 MCP 侧的闸删掉也全绿。
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'noconsent.mp3', data_base64: mp3('mcp-noconsent').toString('base64'), consent: false },
    });
    expect(r.isError).toBe(true);
    expect(String(sc(r).error)).toContain('授权');
    await c.close();
  });

  it('MCP upload_audio 成功时写 audio-ref 存证行(合规链不因入口而异)', async () => {
    const c = await mcp();
    const r = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'ok.mp3', data_base64: mp3('mcp-authrow').toString('base64'), consent: true },
    });
    expect(r.isError).toBeFalsy();
    const row = db.prepare(
      `SELECT consent, subject_type FROM authorization WHERE tenant_id=? AND subject_key=?`,
    ).get(tId, sc(r).audioRef) as { consent: number; subject_type: string } | undefined;
    expect(row?.consent, 'MCP 上传的音频没写存证行 —— 与 REST 口径不一致').toBe(1);
    expect(row?.subject_type).toBe('audio-ref');
    await c.close();
  });

  it('upload_audio 超 20MB → 被 MCP 侧的 decodeUpload 拒(不是被服务函数兜住)', async () => {
    // 钉的是 MCP 这道闸。storeAudioInput 自己也有 20MB 检查,所以只断言「被拒」的话,
    // 把 decodeUpload 的 maxBytes 调大照样绿 —— 靠错误文案区分是谁拒的:
    //   decodeUpload  → 「单个文件不能超过 20MB」
    //   storeAudioInput → 「音频不能超过 20MB」
    const c = await mcp();
    const big = Buffer.alloc(21 * 1024 * 1024, 0x41);
    const r = await c.callTool({
      name: 'upload_audio',
      arguments: { filename: 'big.mp3', data_base64: big.toString('base64'), consent: true },
    });
    expect(r.isError).toBe(true);
    expect(sc(r).code).toBe('INVALID_INPUT_FILE');
    expect(String(sc(r).error), 'MCP 侧的尺寸闸没生效,是被服务函数兜住的').toContain('单个文件不能超过');
    await c.close();
  });
});

describe('审计溯源 — MCP 面也要记 IP', () => {
  it('MCP 提交的任务/上传要记客户端 IP(此前整个 Agent 面的审计行都没有来源)', async () => {
    const c = await mcp();
    await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'ip.png', data_base64: mp3('ip-audit').toString('base64') }], consent: true },
    });
    const row = db.prepare(
      `SELECT ip, via_api_key FROM audit_log WHERE tenant_id=? AND action='upload_image_input'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(tId) as { ip: string | null; via_api_key: string | null } | undefined;
    expect(row?.via_api_key, '没记 key id').toBeTruthy();
    expect(row?.ip, 'MCP 侧审计 IP 仍是 null —— 密钥泄漏后无从溯源').toBeTruthy();
    await c.close();
  });
});
