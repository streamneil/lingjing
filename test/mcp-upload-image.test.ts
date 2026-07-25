// 灵镜 Open API — MCP upload_image 工具 + 图生图闭环(v0.8.0.7)。
//
// 修的事故:MCP 只暴露了 generate_image 的 imageRefs 参数,却没有任何工具能**产出** imageRef。
// 接 connect.sh 的 Agent(Claude Code / Codex)工具箱里找不到上传口 → 瞎猜路径 → 撞作用域 403
// → 误判成「密钥权限不足」,回头找人要 scope。本文件锁死闭环:upload_image → generate_image(img2img)。
//
// 同时回归两件事:
//   - REST /api/image-uploads 用 API key 一直是放行的(白名单内),别被误判成权限问题
//   - 合规不因入口而异:MCP 与 REST 共用 storeImageInputs,consent / 格式 / 10MB 三道闸逐字一致
//
// storage 模块 mock 成内存 map:不碰真实 MinIO。

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Client as McpSdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

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

const { db } = await import('../src/db/index.js');
const storageMod = await import('../src/storage/index.js');
const { storeImageInputs } = await import('../src/api/jobs.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');
const { Client, serverPort } = await import('./helpers.js');

seedPlatformDefaults(); // 种默认模型(img2img 需可用模型,与生产一致)
const app = createApp();
const rest = new Client(app); // 纯 API key 客户端(从不登录)

let port = 0;
let key = '';
let tId = '';
let creatorId = '';

// 1×1 PNG(真实字节;校验只看扩展名+大小,但用真图更贴近现场)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  tId = createTenant('MCP 上传台').id;
  creatorId = (await createUser(tId, 'upcreator', 'pw123456', 'creator')).id;
  grant(tId, 1_000_000);
  key = createApiKey(tId, creatorId, 'upload-key').key;
  port = await serverPort(app);
}, 30000);

async function mcp() {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new McpSdkClient({ name: 'test-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP upload_image — 图生图闭环', () => {
  it('tools/list 暴露 upload_image(Agent 能发现上传口)', async () => {
    const c = await mcp();
    const { tools } = await c.listTools();
    const t = tools.find((x) => x.name === 'upload_image');
    expect(t).toBeTruthy();
    // 描述必须点名 generate_image 的 imageRefs —— Agent 靠这句把两个工具串起来
    expect(t!.description).toContain('imageRefs');
    await c.close();
  });

  it('upload_image → 返回本租户前缀的 imageRefs,字节真落存储', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'ref.png', data_base64: PNG.toString('base64') }], consent: true },
    });
    const sc = res.structuredContent as { imageRefs: string[] };
    expect(sc.imageRefs).toHaveLength(1);
    expect(sc.imageRefs[0]).toMatch(new RegExp(`^image-inputs/${tId}/[0-9a-f-]+\\.png$`));
    expect(mem.get(sc.imageRefs[0]!)!.equals(PNG)).toBe(true);
    await c.close();
  });

  it('★ 闭环:upload_image 的 ref 直接喂 generate_image(img2img)→ 真入队', async () => {
    const c = await mcp();
    const up = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'a.png', data_base64: PNG.toString('base64') }], consent: true },
    });
    const refs = (up.structuredContent as { imageRefs: string[] }).imageRefs;

    const gen = await c.callTool({
      name: 'generate_image',
      arguments: { prompt: '照这张图的风格重画', mode: 'img2img', imageRefs: refs, count: 1 },
    });
    const sc = gen.structuredContent as { job_id?: string; error?: string };
    expect(sc.error).toBeUndefined(); // 闭环断点会在这里现形
    expect(sc.job_id).toBeTruthy();

    const job = getJob(sc.job_id!)!;
    expect(job.tenant_id).toBe(tId);
    const input = JSON.parse(job.input_json) as { mode: string; imageRefs: string[] };
    expect(input.mode).toBe('img2img');
    expect(input.imageRefs).toEqual(refs); // 归属校验(checkRefsOwned)放行且原样落库
    await c.close();
  });

  it('data URL 形式的 base64 也吃(Agent 常直接贴 data:image/png;base64,…)', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [{ filename: 'b.png', data_base64: `data:image/png;base64,${PNG.toString('base64')}` }],
        consent: true,
      },
    });
    const sc = res.structuredContent as { imageRefs?: string[]; error?: string };
    expect(sc.error).toBeUndefined();
    expect(sc.imageRefs).toHaveLength(1);
    await c.close();
  });

  it('多张一次传 → 各自独立 key,顺序与入参一致', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [
          { filename: 'p1.png', data_base64: PNG.toString('base64') },
          { filename: 'p2.jpg', data_base64: PNG.toString('base64') },
        ],
        consent: true,
      },
    });
    const sc = res.structuredContent as { imageRefs: string[] };
    expect(sc.imageRefs).toHaveLength(2);
    expect(sc.imageRefs[0]).toMatch(/\.png$/);
    expect(sc.imageRefs[1]).toMatch(/\.jpg$/);
    expect(new Set(sc.imageRefs).size).toBe(2);
    await c.close();
  });
});

describe('MCP upload_image — 合规闸不因入口而异(与 REST 同口径)', () => {
  it('consent 缺省 → 拒(深度合成授权门票,Agent 也绕不过)', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'x.png', data_base64: PNG.toString('base64') }], consent: false },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain('授权');
    await c.close();
  });

  it('HEIC / 未知扩展名 → 拒(不猜 MIME)', async () => {
    const c = await mcp();
    for (const fn of ['x.heic', 'x.bin', 'noext']) {
      const res = await c.callTool({
        name: 'upload_image',
        arguments: { images: [{ filename: fn, data_base64: PNG.toString('base64') }], consent: true },
      });
      expect(res.isError, fn).toBe(true);
    }
    await c.close();
  });

  it('空内容 → 拒(不落 0 字节垃圾对象)', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'x.png', data_base64: '' }], consent: true },
    });
    expect(res.isError).toBe(true);
    await c.close();
  });

  // 10MB 闸走单测而非端到端:端到端要把 ~15MB base64 推过 HTTP,在 16 路 fork 并行下是实打实的
  // 内存+IO 压力(会喂大仓库已知的资源竞争 flake,见 TODOS T-TEST-ORDER-DEPENDENCE)。
  // 这里用 size 字段直接打闸,零分配、同断言。decodeUpload 侧那道 base64 长度预判是同一条规则的
  // 前置优化(避免为超大图先解出 buffer),不再单独端到端覆盖 —— 明写在此,不当作隐形缩水。
  it('单张超 10MB → 拒(与 REST 同阈值)', async () => {
    const r = await storeImageInputs(
      { tenantId: tId, userId: creatorId, ip: null, apiKeyId: null },
      [{ buffer: PNG, mimetype: 'image/png', originalname: 'big.png', size: 11 * 1024 * 1024 }],
      true,
    );
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toContain('10MB');
  });

  it('每张写 authorization 存证行(subject_type=image-edit)', async () => {
    const before = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    const c = await mcp();
    await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [
          { filename: 'e1.png', data_base64: PNG.toString('base64') },
          { filename: 'e2.png', data_base64: PNG.toString('base64') },
        ],
        consent: true,
      },
    });
    const after = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    expect(after - before).toBe(2);
    await c.close();
  });

  it('审计记 via_api_key(区分 Agent 传的 vs 本人网页传的)', async () => {
    const c = await mcp();
    await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'aud.png', data_base64: PNG.toString('base64') }], consent: true },
    });
    const row = db.prepare(
      `SELECT via_api_key FROM audit_log WHERE tenant_id=? AND action='upload_image_input'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(tId) as { via_api_key: string | null } | undefined;
    expect(row?.via_api_key).toBeTruthy();
    await c.close();
  });
});

describe('授权凭证(proof)— 合规存证链', () => {
  it('图片格式凭证 → 落 authorizations/ 且写进 authorization.proof_key', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [{ filename: 'pi.png', data_base64: PNG.toString('base64') }],
        consent: true,
        proof: { filename: 'auth.png', data_base64: PNG.toString('base64') },
      },
    });
    const sc = res.structuredContent as { imageRefs?: string[]; error?: string };
    expect(sc.error).toBeUndefined();
    const row = db.prepare(
      `SELECT proof_key FROM authorization WHERE tenant_id=? AND subject_type='image-edit'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(tId) as { proof_key: string | null };
    expect(row.proof_key).toMatch(new RegExp(`^authorizations/${tId}/`));
    expect(mem.has(row.proof_key!)).toBe(true); // 凭证字节真落存储,不是只写了个 key
    await c.close();
  });

  it('非图片凭证(PDF 扫描件)→ 兜底 octet-stream 存下,不被图片白名单误杀', async () => {
    const c = await mcp();
    const pdf = Buffer.from('%PDF-1.4 fake scan');
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [{ filename: 'pp.png', data_base64: PNG.toString('base64') }],
        consent: true,
        proof: { filename: '授权书.pdf', data_base64: pdf.toString('base64') },
      },
    });
    const sc = res.structuredContent as { imageRefs?: string[]; error?: string };
    expect(sc.error).toBeUndefined(); // 凭证不限图片格式 —— 误杀会把合规上传整条挡死
    const row = db.prepare(
      `SELECT proof_key FROM authorization WHERE tenant_id=? AND subject_type='image-edit'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(tId) as { proof_key: string | null };
    expect(row.proof_key).toMatch(/\.pdf$/);
    expect(mem.get(row.proof_key!)!.equals(pdf)).toBe(true);
    await c.close();
  });

  it('凭证解码不出字节 → 拒(不静默丢掉存证)', async () => {
    const c = await mcp();
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [{ filename: 'pq.png', data_base64: PNG.toString('base64') }],
        consent: true,
        proof: { filename: 'empty.pdf', data_base64: '' },
      },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent)).toContain('凭证');
    await c.close();
  });
});

describe('storeImageInputs 守卫(单测:REST/MCP 入口各自被 multer/zod 挡在前面的分支)', () => {
  const actor = () => ({ tenantId: tId, userId: creatorId, ip: null, apiKeyId: null });
  const file = (name: string) => ({ buffer: PNG, mimetype: 'image/png', originalname: name, size: PNG.length });

  it('空数组 → 400 缺少图片', async () => {
    const r = await storeImageInputs(actor(), [], true);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toContain('缺少图片');
  });

  it('超 9 张 → 400(与 multer maxCount / zod max 同阈值,防第三个入口绕过)', async () => {
    const r = await storeImageInputs(actor(), Array.from({ length: 10 }, (_, i) => file(`x${i}.png`)), true);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toContain('9 张');
  });

  // 落地前审查发现:originalname 完全由调用方控制,不过滤则 split('.').pop() 能把 '/'、'..'、
  // 超长片段拼进对象 key。非跨租户逃逸(存储不解析 '..',checkRefsOwned 仍校验前缀),但会写出
  // 畸形 key、超长时撞 MinIO 1024 字节上限 → 500。safeExt 只收 [a-z0-9]{1,8}。
  it('恶意/畸形文件名 → 扩展名净化,key 仍规整', async () => {
    const cases = ['evil.png/../../etc/passwd', 'no-dot', `x.${'a'.repeat(200)}`, 'trailing.', 'x.PNG'];
    for (const name of cases) {
      const r = await storeImageInputs(actor(), [file(name)], true);
      expect(r, name).toMatchObject({ ok: true });
      const key = (r as { imageRefs: string[] }).imageRefs[0]!;
      expect(key, name).toMatch(new RegExp(`^image-inputs/${tId}/[0-9a-f-]+\\.[a-z0-9]{1,8}$`));
    }
  });

  it('畸形凭证文件名 → authorizations/ key 同样规整', async () => {
    const r = await storeImageInputs(actor(), [file('ok.png')], true, {
      buffer: Buffer.from('proof'), mimetype: 'application/octet-stream',
      originalname: '../../../etc/shadow', size: 5,
    });
    expect(r).toMatchObject({ ok: true });
    const row = db.prepare(
      `SELECT proof_key FROM authorization WHERE tenant_id=? AND subject_type='image-edit'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(tId) as { proof_key: string | null };
    expect(row.proof_key).toMatch(new RegExp(`^authorizations/${tId}/[0-9a-f-]+\\.bin$`));
  });

  it('存储写失败 → 500 且不留半截存证行', async () => {
    const before = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    (storageMod.putObject as unknown as { mockRejectedValueOnce: (e: Error) => void })
      .mockRejectedValueOnce(new Error('MinIO 连接失败'));
    const r = await storeImageInputs(actor(), [file('fail.png')], true);
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect((r as { error: string }).error).toContain('MinIO');
    const after = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    expect(after).toBe(before); // 落盘失败就不该写授权行(存证必须对应真实存在的素材)
  });
});

describe('REST /api/image-uploads 回归 — API key 一直是放行的(不是权限问题)', () => {
  it('creator key multipart 上传 → 201 + imageRefs(证明白名单一直放行,非 403)', async () => {
    const r = await rest.postMultipart(
      '/api/image-uploads',
      { consent: 'true' },
      { images: { filename: 'r.png', content: PNG, type: 'image/png' } },
      key,
    );
    expect(r.status).toBe(201);
    expect(r.body.imageRefs[0]).toMatch(new RegExp(`^image-inputs/${tId}/`));
  });

  it('REST 与 MCP 同一把闸:consent 缺省 → 400(不因入口而异)', async () => {
    const r = await rest.postMultipart(
      '/api/image-uploads',
      {},
      { images: { filename: 'r.png', content: PNG, type: 'image/png' } },
      key,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('授权');
  });

  it('作用域 403 必须带 allowed 清单 + 说明「路径不存在也返 403」', async () => {
    const r = await rest.postKey('/api/does-not-exist', key, {});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_FORBIDDEN');
    // 事故根因:Agent 拿不存在的路径做对照,发现同样 403 → 误判「是权限不是路由」。
    // 文案必须点破这一点,并把可用端点直接给它。
    expect(r.body.error).toContain('不存在的路径');
    expect(Array.isArray(r.body.allowed)).toBe(true);
    expect(r.body.allowed.join('\n')).toContain('/api/image-uploads');
  });
});
