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

  // 存证粒度按「对象」而非按「次」(eng-review D18)。存储 key 由内容 sha256 决定,所以
  // 「同一份字节」= 同一个对象 = 一条存证覆盖它。审计要回答的是「这个素材有没有授权」,
  // 不是「当时点选了几个文件」—— 后者是 uuid 命名时代的实现细节,不是合规要求。
  // 这里钉的是真正的不变量:**每个落盘的输入对象,都有一条 subject_key 指向它的存证行**。
  it('每个落盘对象都有存证行覆盖(subject_key 关联,subject_type=image-edit)', async () => {
    const c = await mcp();
    const PNG_B = Buffer.concat([PNG, Buffer.from('distinct-bytes')]); // 与 PNG 内容不同 → 不同对象
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [
          { filename: 'e1.png', data_base64: PNG.toString('base64') },
          { filename: 'e2.png', data_base64: PNG_B.toString('base64') },
        ],
        consent: true,
      },
    });
    const refs = (res.structuredContent as { imageRefs: string[] }).imageRefs;
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2); // 内容不同 → 两个对象
    for (const k of refs) {
      expect(mem.has(k)).toBe(true); // 对象真落盘
      const row = db.prepare(
        `SELECT consent FROM authorization
          WHERE tenant_id=? AND subject_key=? AND subject_type='image-edit'`,
      ).get(tId, k) as { consent: number } | undefined;
      expect(row?.consent).toBe(1); // 且每个对象都被一条存证行覆盖
    }
    await c.close();
  });

  it('同一次请求里传两份相同字节 → 塌成一个对象一条存证(imageRefs 长度不变)', async () => {
    const c = await mcp();
    const dup = Buffer.concat([PNG, Buffer.from('dup-case')]);
    const before = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    const res = await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [
          { filename: 'same-a.png', data_base64: dup.toString('base64') },
          { filename: 'same-b.png', data_base64: dup.toString('base64') },
        ],
        consent: true,
      },
    });
    const refs = (res.structuredContent as { imageRefs: string[] }).imageRefs;
    expect(refs).toHaveLength(2);          // 入参几张就回几个 ref(调用方的数组形状不变)
    expect(new Set(refs).size).toBe(1);    // 但指向同一个对象
    const after = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    expect(after - before).toBe(1);        // 一个对象一条存证,不叠加
    await c.close();
  });

  it('重传同一素材 → 不叠加存证行(Agent 超时重试的真实场景)', async () => {
    const c = await mcp();
    const retryImg = Buffer.concat([PNG, Buffer.from('retry-case')]);
    const call = () => c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'r.png', data_base64: retryImg.toString('base64') }], consent: true },
    });
    const first = await call();
    const before = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    const second = await call(); // 模拟客户端库自动重试(Agent 没参与决策,不会传幂等键)
    const k1 = (first.structuredContent as { imageRefs: string[] }).imageRefs[0];
    const k2 = (second.structuredContent as { imageRefs: string[] }).imageRefs[0];
    expect(k2).toBe(k1); // 同字节 → 同 key,不产生孤儿对象
    const after = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    expect(after).toBe(before); // 一次授权事件只留一份证据
    await c.close();
  });

  it('同素材换新凭证再传 → 新增存证行(新的授权事件不能被当成重试吐掉)', async () => {
    const c = await mcp();
    const img = Buffer.concat([PNG, Buffer.from('reconsent-case')]);
    await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'rc.png', data_base64: img.toString('base64') }], consent: true },
    });
    const before = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    await c.callTool({
      name: 'upload_image',
      arguments: {
        images: [{ filename: 'rc.png', data_base64: img.toString('base64') }],
        consent: true,
        proof: { filename: '补充授权书.pdf', data_base64: Buffer.from('%PDF new consent').toString('base64') },
      },
    });
    const after = (db.prepare(
      `SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type='image-edit'`,
    ).get(tId) as { n: number }).n;
    expect(after - before).toBe(1); // 凭证不同 = 新授权事件,必须留痕
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

// ── R1 收尾:折行 base64 的阈值口径(ship 方案完成度审计)────────────────────
// v0.9.2 把「解码前按字符串长度粗筛」去掉了。原因不是性能,是那个判据本身错:
// raw.length*3/4 是解码后字节数的**上界**,上界超限 ≠ 真实值超限。旧实现能用长度判,
// 是因为它先 replace 掉空白量的是净长度;去掉那次复制后,唯一还准的量是 buffer.length。
// 中间那版两道闸并存,会让 PEM 风格折行的 base64 在阈值附近被提前拒 —— 与 R1「行为严格不变」冲突。
describe('R1 收尾 — 折行 base64 不因空白被提前拒', () => {
  it('折行把字符串上界撑过阈值、真实字节没超 → 必须放行', async () => {
    const c = await mcp();
    // 关键在于 fixture 要能区分两种判据:
    //   真实字节 8MB   < 10MB 上限          → 按 buffer.length 判 = 放行
    //   base64 折行后字符串 ≈14MB,×3/4 ≈ 10.6MB > 10MB → 按字符串长度判 = 误拒
    // 用小图做这条测试是没用的(两种判据都远在阈值之下,断言不可能失败)。
    const real = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const folded = real.toString('base64').replace(/(.{4})/g, '$1\n');
    expect(folded.length * 3 / 4, 'fixture 没撑过阈值,这条测试就区分不了两种判据')
      .toBeGreaterThan(10 * 1024 * 1024);
    const r = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'folded-big.png', data_base64: folded }], consent: true },
    });
    expect(r.isError, '折行撑大了字符串就被拒 —— 说明尺寸判据又回到了字符串长度').toBeFalsy();
    await c.close();
  });

  it('折行与不折行解出同一份字节 → 内容寻址下落同一个 key', async () => {
    const c = await mcp();
    const flat = PNG.toString('base64');
    const folded = flat.replace(/(.{4})/g, '$1\n');
    const a = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'folded.png', data_base64: folded }], consent: true },
    });
    const b = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'flat.png', data_base64: flat }], consent: true },
    });
    expect((a.structuredContent as { imageRefs: string[] }).imageRefs[0])
      .toBe((b.structuredContent as { imageRefs: string[] }).imageRefs[0]);
    await c.close();
  });

  it('超限判定落在解码后的真实字节数上(10MB 阈值不因编码方式浮动)', async () => {
    const c = await mcp();
    // 真实 11MB 字节 → base64 约 14.7MB 字符,解码后 11MB > 10MB → 必须拒
    const big = Buffer.alloc(11 * 1024 * 1024, 0x41);
    const r = await c.callTool({
      name: 'upload_image',
      arguments: { images: [{ filename: 'big.png', data_base64: big.toString('base64') }], consent: true },
    });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe('INVALID_INPUT_FILE');
    expect(String((r.structuredContent as { error: string }).error)).toContain('10MB');
    await c.close();
  });
});
