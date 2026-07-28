// 上传服务函数抽取 — REST 回归基线 + 抽取后行为对照(v0.9.2)。
//
// 为什么必须先有这个文件:/api/video-uploads 与 /api/audio-uploads 的校验/存证/落库逻辑原本
// **内联在路由处理器里**,MCP 侧的 upload_video / upload_audio 没法复用。抽成 storeVideoInput() /
// storeAudioInput() 是本轮的前置重构 —— 而抽取前 `grep -rln audio-uploads test/` **零命中**,
// video-edit-api.test.ts 也只是预置 sidecar、从不走上传路由。也就是说这两条路在重构时没有任何安全网。
//
// 本文件就是那张网:先钉死抽取前的行为,抽取后同一批断言必须原样通过。
// 覆盖 R2(video-uploads 逐字不变)/ R3(audio-uploads 逐字不变)/ R5(内容哈希命名与存证不叠加)。
//
// ffprobe 走 mock:CI 容器不保证有 ffmpeg,而时长是计费真相 —— 要测的是「路由怎么用探测结果」,
// 不是 ffmpeg 本身。probeVideoMeta 用 importOriginal 保留其余导出(worker/avatars 也从这里拿函数)。

import { describe, it, expect, beforeAll, vi } from 'vitest';

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

// 可切换的探测结果:默认 8s/1080p 正常片;置 null 模拟 ffprobe 失败(严格模式必须拒)。
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
const { Client } = await import('./helpers.js');

const app = createApp();
const rest = new Client(app);

let key = '';
let tId = '';

// 假素材字节(格式判定只看 mimetype/扩展名;探测结果来自上面的 mock)
const MP4 = Buffer.from('ftypisom-fake-mp4-bytes-for-routing-only');
const MP3 = Buffer.from('ID3-fake-mp3-bytes-for-routing-only');
// 每个用例要不同字节 —— 内容寻址下相同字节会落同一个 key,断言就互相干扰了。
const mp3ish = (salt: string) => Buffer.concat([MP3, Buffer.from(salt)]);
const mp4ish = (salt: string) => Buffer.concat([MP4, Buffer.from(salt)]);

const authCount = (subjectType: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM authorization WHERE tenant_id=? AND subject_type=?`)
    .get(tId, subjectType) as { n: number }).n;

beforeAll(async () => {
  tId = createTenant('上传抽取台').id;
  const uid = (await createUser(tId, 'upextract', 'pw123456', 'creator')).id;
  grant(tId, 1_000_000);
  key = createApiKey(tId, uid, 'extract-key').key;
}, 30000);

// ── R2:POST /api/video-uploads ────────────────────────────────────────────
// 抽取前后逐字相同的六条闸。任何一条变了都说明重构改了行为,不是纯搬运。
describe('R2 回归 — POST /api/video-uploads 行为基线', () => {
  it('happy:返回 videoRef + 时长尺寸,视频与 sidecar 都真落存储', async () => {
    probeResult = { duration: 8, width: 1920, height: 1080 };
    const before = authCount('video-edit');
    const r = await rest.postMultipart(
      '/api/video-uploads',
      { consent: 'true' },
      // 必须用**本用例专属**的字节:内容寻址下,任何别处用过同一份 MP4 的用例都会让
      // insertAuthOnce 命中去重,这里的「存证行 +1」就随执行顺序时对时错(实测 shuffle seed 7/11 会红)。
      { video: { filename: 'clip.mp4', content: mp4ish('r2-happy'), type: 'video/mp4' } },
      key,
    );
    expect(r.status).toBe(200);
    expect(r.body.videoRef).toMatch(new RegExp(`^video-inputs/${tId}/.+\\.mp4$`));
    expect(r.body.duration).toBe(8);
    expect(r.body.width).toBe(1920);
    expect(r.body.height).toBe(1080);
    // 视频本体 + sidecar 两个对象
    expect(mem.has(r.body.videoRef)).toBe(true);
    const sidecarKey = `${r.body.videoRef}.meta.json`;
    expect(mem.has(sidecarKey)).toBe(true);
    expect(JSON.parse(mem.get(sidecarKey)!.toString()).duration).toBe(8);
    // 授权存证行 +1(subject_type='video-edit')
    expect(authCount('video-edit')).toBe(before + 1);
  });

  it('缺 consent → 400 且不落任何对象、不写存证行(合规闸)', async () => {
    const beforeObjs = mem.size;
    const before = authCount('video-edit');
    const r = await rest.postMultipart(
      '/api/video-uploads',
      {},
      { video: { filename: 'clip.mp4', content: MP4, type: 'video/mp4' } },
      key,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('授权');
    expect(mem.size).toBe(beforeObjs);
    expect(authCount('video-edit')).toBe(before);
  });

  it('非 MP4/MOV → 400 列出支持格式', async () => {
    const r = await rest.postMultipart(
      '/api/video-uploads',
      { consent: 'true' },
      { video: { filename: 'clip.avi', content: MP4, type: 'video/x-msvideo' } },
      key,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('MP4/MOV');
  });

  it('ffprobe 失败 → 400 严格拒(时长是计费真相,不可优雅放行)', async () => {
    probeResult = null;
    const r = await rest.postMultipart(
      '/api/video-uploads',
      { consent: 'true' },
      { video: { filename: 'broken.mp4', content: MP4, type: 'video/mp4' } },
      key,
    );
    probeResult = { duration: 8, width: 1920, height: 1080 };
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('无法解析视频');
  });

  it('时长 <2s → 400(通用下限)', async () => {
    probeResult = { duration: 1.2, width: 1920, height: 1080 };
    const r = await rest.postMultipart(
      '/api/video-uploads',
      { consent: 'true' },
      { video: { filename: 'tiny.mp4', content: MP4, type: 'video/mp4' } },
      key,
    );
    probeResult = { duration: 8, width: 1920, height: 1080 };
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('2-60 秒');
  });

  it('时长 >60s → 400(通用上限)', async () => {
    probeResult = { duration: 75, width: 1920, height: 1080 };
    const r = await rest.postMultipart(
      '/api/video-uploads',
      { consent: 'true' },
      { video: { filename: 'long.mp4', content: MP4, type: 'video/mp4' } },
      key,
    );
    probeResult = { duration: 8, width: 1920, height: 1080 };
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('2-60 秒');
  });

  it('.mov 扩展名 → key 后缀为 .mov(不是恒 .mp4)', async () => {
    const r = await rest.postMultipart(
      '/api/video-uploads',
      { consent: 'true' },
      { video: { filename: 'clip.mov', content: MP4, type: 'video/quicktime' } },
      key,
    );
    expect(r.status).toBe(200);
    expect(r.body.videoRef).toMatch(/\.mov$/);
  });
});

// ── R3:POST /api/audio-uploads ────────────────────────────────────────────
// 抽取前这条路**零测试覆盖**。这里补的就是那张缺失的网。
describe('R3 回归 — POST /api/audio-uploads 行为基线(抽取前零覆盖)', () => {
  it('happy:返回 audioRef 且字节真落存储', async () => {
    const r = await rest.postMultipart(
      '/api/audio-uploads',
      { consent: 'true' },
      { audio: { filename: 'bgm.mp3', content: MP3, type: 'audio/mpeg' } },
      key,
    );
    expect(r.status).toBe(200);
    expect(r.body.audioRef).toMatch(new RegExp(`^audio-inputs/${tId}/.+\\.mp3$`));
    expect(mem.get(r.body.audioRef)!.equals(MP3)).toBe(true);
  });

  // v0.9.2 起口径变了:参考音频与图片/视频同样要 consent 且写存证行(见下方 D5 组)。
  // 旧口径「参考素材语义 ≠ 深度伪造,不写 authorization 行」是 Agent 接入之前的结论 ——
  // 现在 audioRef 能直接驱动 generate_video_from_refs 出片,一段真人录音零授权就能变成视频。
  it('参考音频写 audio-ref 存证行(v0.9.2 起与图片/视频同口径)', async () => {
    const before = authCount('audio-ref');
    const r = await rest.postMultipart(
      '/api/audio-uploads',
      { consent: 'true' },
      { audio: { filename: 'ref.wav', content: mp3ish('r3-authrow'), type: 'audio/wav' } },
      key,
    );
    expect(r.status).toBe(200);
    expect(authCount('audio-ref')).toBe(before + 1);
  });

  it('缺文件 → 400', async () => {
    const r = await rest.postMultipart('/api/audio-uploads', {}, {}, key);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('缺少音频文件');
  });

  it('非 MP3/WAV/M4A/AAC → 400 列出支持格式', async () => {
    const r = await rest.postMultipart(
      '/api/audio-uploads',
      { consent: 'true' },
      { audio: { filename: 'x.ogg', content: MP3, type: 'audio/ogg' } },
      key,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('MP3/WAV/M4A');
  });

  it('扩展名合法但 mimetype 未知 → 仍放行(防御纵深是「或」不是「与」)', async () => {
    const r = await rest.postMultipart(
      '/api/audio-uploads',
      { consent: 'true' },
      { audio: { filename: 'ok.m4a', content: MP3, type: 'application/octet-stream' } },
      key,
    );
    expect(r.status).toBe(200);
    // mimetype 认不出(octet-stream)时才回落文件名扩展名 —— 保住可读性
    expect(r.body.audioRef).toMatch(/\.m4a$/);
  });
});

// ── R5:内容寻址命名 + 存证去重(D14/D18)──────────────────────────────
// 抽取时把 key 从 randomUUID 换成内容 sha256。动机是 Agent 重试:upload_video 是开放面最慢的
// 调用,最容易撞客户端超时被自动重试(**客户端库自己做的,模型没参与决策,不会传幂等键**)。
// uuid 命名下一次重试 = 第二个对象 + 第二份 sidecar + 第二条存证行(一次授权两份证据)。
describe('R5 — 内容寻址:重传不产生孤儿对象、不叠加存证行', () => {
  it('视频重传 → 同一个 videoRef,存证行不增加,sidecar 也不重复', async () => {
    const clip = Buffer.concat([MP4, Buffer.from('r5-video')]);
    const up = () => rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 'retry.mp4', content: clip, type: 'video/mp4' } }, key,
    );
    const first = await up();
    expect(first.status).toBe(200);
    const before = authCount('video-edit');
    const objsBefore = mem.size;
    const second = await up(); // 模拟超时重试
    expect(second.status).toBe(200);
    expect(second.body.videoRef).toBe(first.body.videoRef); // 同字节 → 同 key
    expect(authCount('video-edit')).toBe(before);           // 一次授权事件一份证据
    expect(mem.size).toBe(objsBefore);                      // 无孤儿对象(视频 + sidecar 都不新增)
  });

  it('内容不同的视频 → 不同 videoRef(去重不能误伤)', async () => {
    const a = await rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 'a.mp4', content: Buffer.concat([MP4, Buffer.from('AAA')]), type: 'video/mp4' } }, key,
    );
    const b = await rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 'b.mp4', content: Buffer.concat([MP4, Buffer.from('BBB')]), type: 'video/mp4' } }, key,
    );
    expect(a.body.videoRef).not.toBe(b.body.videoRef);
  });

  it('音频重传 → 同一个 audioRef(音频无存证行,只验对象不重复)', async () => {
    const clip = Buffer.concat([MP3, Buffer.from('r5-audio')]);
    const up = () => rest.postMultipart(
      '/api/audio-uploads', { consent: 'true' },
      { audio: { filename: 'retry.mp3', content: clip, type: 'audio/mpeg' } }, key,
    );
    const first = await up();
    const objsBefore = mem.size;
    const second = await up();
    expect(second.body.audioRef).toBe(first.body.audioRef);
    expect(mem.size).toBe(objsBefore);
  });

  it('每个落盘视频对象都有 subject_key 指向它的存证行(合规不变量)', async () => {
    const r = await rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 'inv.mp4', content: Buffer.concat([MP4, Buffer.from('invariant')]), type: 'video/mp4' } }, key,
    );
    expect(r.status).toBe(200);
    const row = db.prepare(
      `SELECT consent, subject_type FROM authorization WHERE tenant_id=? AND subject_key=?`,
    ).get(tId, r.body.videoRef) as { consent: number; subject_type: string } | undefined;
    expect(row?.consent).toBe(1);
    expect(row?.subject_type).toBe('video-edit');
  });

  it('跨租户同一份文件各存一份(前缀隔离 —— 归属与授权各自独立,不能跨租户去重)', async () => {
    const other = createTenant('另一家机构').id;
    const otherUid = (await createUser(other, 'otheruser', 'pw123456', 'creator')).id;
    grant(other, 1_000_000);
    const otherKey = createApiKey(other, otherUid, 'other-key').key;
    const same = Buffer.concat([MP4, Buffer.from('cross-tenant')]);
    const a = await rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 's.mp4', content: same, type: 'video/mp4' } }, key,
    );
    const b = await rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 's.mp4', content: same, type: 'video/mp4' } }, otherKey,
    );
    expect(a.body.videoRef).not.toBe(b.body.videoRef);
    expect(a.body.videoRef).toContain(`/${tId}/`);
    expect(b.body.videoRef).toContain(`/${other}/`);
  });
});

// ── 服务函数直测:MCP 侧走的是 buffer(无 path)那条分支 ────────────────────
describe('storeVideoInput — buffer 分支(MCP 入口)与 path 旁路(REST 入口)等价', () => {
  it('不给 path → 自建临时文件跑 ffprobe,结果与 REST 路径一致', async () => {
    const { storeVideoInput } = await import('../src/api/jobs.js');
    const buf = Buffer.concat([MP4, Buffer.from('buffer-branch')]);
    const r = await storeVideoInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'video/mp4', originalname: 'b.mp4', size: buf.length },
      true,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.videoRef).toMatch(new RegExp(`^video-inputs/${tId}/`));
      expect(r.duration).toBe(8);
      expect(mem.has(`${r.videoRef}.meta.json`)).toBe(true);
    }
  });

  it('给了 path → 不重复落盘,行为与 buffer 分支同一个 key(同字节)', async () => {
    const { storeVideoInput } = await import('../src/api/jobs.js');
    const buf = Buffer.concat([MP4, Buffer.from('path-branch')]);
    const { writeFile, unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const p = join(tmpdir(), `lj-test-${Date.now()}.mp4`);
    await writeFile(p, buf);
    const viaPath = await storeVideoInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'video/mp4', originalname: 'p.mp4', size: buf.length, path: p },
      true,
    );
    const viaBuffer = await storeVideoInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'video/mp4', originalname: 'p.mp4', size: buf.length },
      true,
    );
    expect(viaPath.ok && viaBuffer.ok).toBe(true);
    if (viaPath.ok && viaBuffer.ok) expect(viaPath.videoRef).toBe(viaBuffer.videoRef);
    // 所有权语义:调用方给的 path 不该被函数删掉(REST 侧还要自己 cleanup)
    await expect(unlink(p)).resolves.toBeUndefined();
  });

  it('consent=false → 拒,且在 ffprobe 之前就拒(不白跑探测)', async () => {
    const { storeVideoInput } = await import('../src/api/jobs.js');
    const buf = Buffer.concat([MP4, Buffer.from('no-consent')]);
    const r = await storeVideoInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'video/mp4', originalname: 'n.mp4', size: buf.length },
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(400); expect(r.error).toContain('授权'); }
  });
});

// ── 作用域回归:两条上传路由一直在 API key 白名单内 ──────────────────────
describe('作用域回归 — 两条上传端点对 API key 一直是放行的', () => {
  it('video-uploads / audio-uploads 都不返 SCOPE_FORBIDDEN', async () => {
    const v = await rest.postMultipart(
      '/api/video-uploads', { consent: 'true' },
      { video: { filename: 'a.mp4', content: mp4ish('scope-check'), type: 'video/mp4' } }, key,
    );
    const a = await rest.postMultipart(
      '/api/audio-uploads', { consent: 'true' },
      { audio: { filename: 'a.mp3', content: MP3, type: 'audio/mpeg' } }, key,
    );
    expect(v.status).not.toBe(403);
    expect(a.status).not.toBe(403);
  });
});

// ── 抽取带来的扩展名行为变化(ship 覆盖率审计 REG-1)──────────────────────
// 音频 key 的扩展名过去用 /\.(\w+)$/ 取,现在统一走 safeExt()(与图片/视频同一套)。
// 两处可观察的差异,都无害(扩展名只用于可读性,MIME 由格式闸单独把关),但必须钉住:
//   无点文件名   旧 → .mp3        新 → 用文件名本身(若 ≤8 位字母数字)
//   超长扩展名   旧 → 原样带上    新 → 回落 .mp3(防畸形 key 撞存储 key 长度上限)
describe('REG-1 — 音频存储 key 的扩展名口径(抽取后统一走 safeExt)', () => {
  it('正常扩展名不变', async () => {
    const r = await rest.postMultipart(
      '/api/audio-uploads', { consent: 'true' },
      { audio: { filename: 'song.mp3', content: mp3ish('reg1-normal'), type: 'audio/mpeg' } }, key,
    );
    expect(r.status).toBe(200);
    expect(r.body.audioRef).toMatch(/\.mp3$/);
  });

  it('扩展名由已校验的 mimetype 决定,不看客户端文件名(去重的前提)', async () => {
    // 同一份字节,文件名写什么都必须落同一个 key —— 否则客户端库重试时重算文件名
    // (audio / track.weird / 无扩展名)就会产生多个对象 + 多条存证行,去重承诺作废。
    const bytes = mp3ish('reg1-name-irrelevant');
    const keys: string[] = [];
    for (const filename of ['audio', 'track.verylongextension', 'x.WAV', 'bgm.mp3']) {
      const r = await rest.postMultipart(
        '/api/audio-uploads', { consent: 'true' },
        { audio: { filename, content: bytes, type: 'audio/mpeg' } }, key,
      );
      expect(r.status).toBe(200);
      expect(r.body.audioRef, `${filename} 的扩展名应由 audio/mpeg 决定`).toMatch(/\.mp3$/);
      keys.push(r.body.audioRef);
    }
    expect(new Set(keys).size, '同字节不同文件名产生了多个 key —— 去重被文件名破坏').toBe(1);
  });

  it('路径分隔符等畸形文件名 → 净化,key 仍规整', async () => {
    const r = await rest.postMultipart(
      '/api/audio-uploads', { consent: 'true' },
      { audio: { filename: '../../etc/passwd', content: mp3ish('reg1-evil'), type: 'audio/mpeg' } }, key,
    );
    expect(r.status).toBe(200);
    expect(r.body.audioRef).toMatch(new RegExp(`^audio-inputs/${tId}/[a-f0-9]{32}\\.[a-z0-9]{1,8}$`));
  });
});

// ── 存储写失败 → UPLOAD_FAILED(可重试码)────────────────────────────────
// storeImageInputs 早有等价测试,视频/音频抽取时没跟上。区别很实在:
// UPLOAD_FAILED 在错误码表里标的是「可重试」,而格式/合规类错误标的是「不可重试」——
// 分类错了,Agent 要么该退避时放弃、要么该改参数时死磕到限速。
describe('存储写失败 — 视频/音频都要映射成 UPLOAD_FAILED,不是静默 500', () => {
  it('storeVideoInput:putObject 抛 → status 500 且不留半截存证行', async () => {
    const { storeVideoInput } = await import('../src/api/jobs.js');
    const storage = await import('../src/storage/index.js');
    const before = authCount('video-edit');
    const spy = vi.spyOn(storage, 'putObject').mockRejectedValueOnce(new Error('MinIO 挂了'));
    const buf = Buffer.concat([MP4, Buffer.from('put-fail')]);
    const r = await storeVideoInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'video/mp4', originalname: 'f.mp4', size: buf.length },
      true,
    );
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      // 反过来断言:**不能**把厂商原文回给调用方。MinIO/OSS 的报错里带 endpoint、bucket、
      // region、requestId,回给持密钥方等于送出内部拓扑。细节进日志,调用方只拿到可执行结论。
      expect(r.error).not.toContain('MinIO');
      expect(r.error).toContain('存储写入失败');
    }
    // 落盘失败就不该写存证 —— 存证必须对应真实存在的素材
    expect(authCount('video-edit')).toBe(before);
  });

  it('storeAudioInput:putObject 抛 → status 500', async () => {
    const { storeAudioInput } = await import('../src/api/jobs.js');
    const storage = await import('../src/storage/index.js');
    const spy = vi.spyOn(storage, 'putObject').mockRejectedValueOnce(new Error('OSS 超时'));
    const buf = mp3ish('put-fail-audio');
    const r = await storeAudioInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'audio/mpeg', originalname: 'f.mp3', size: buf.length },
      true,
    );
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.error).not.toContain('OSS'); // 同上:不泄漏存储后端信息
      expect(r.error).toContain('存储写入失败');
    }
  });

  it('REST /video-uploads 缺文件 → 400(与 audio 端点同口径)', async () => {
    const r = await rest.postMultipart('/api/video-uploads', { consent: 'true' }, {}, key);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('缺少视频文件');
  });
});

// ── D5:参考音频与图片/视频同一条合规口径(v0.9.2 起)──────────────────────
// 改动动因:audioRef 现在能直接驱动 generate_video_from_refs 出片,一段真人录音
// 零授权声明就能变成视频。声纹是个人信息,不能因为它叫「参考素材」就免检。
describe('D5 — 参考音频的 consent 闸(两个入口同口径)', () => {
  it('REST 缺 consent → 400,且不落对象', async () => {
    const before = mem.size;
    const r = await rest.postMultipart(
      '/api/audio-uploads', {},
      { audio: { filename: 'noconsent.mp3', content: mp3ish('d5-rest'), type: 'audio/mpeg' } }, key,
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('授权');
    expect(mem.size).toBe(before);
  });

  it('consent=true → 写 audio-ref 存证行,subject_key 指向该对象', async () => {
    const r = await rest.postMultipart(
      '/api/audio-uploads', { consent: 'true' },
      { audio: { filename: 'ok.mp3', content: mp3ish('d5-consented'), type: 'audio/mpeg' } }, key,
    );
    expect(r.status).toBe(200);
    const row = db.prepare(
      `SELECT consent, subject_type FROM authorization WHERE tenant_id=? AND subject_key=?`,
    ).get(tId, r.body.audioRef) as { consent: number; subject_type: string } | undefined;
    expect(row?.consent).toBe(1);
    expect(row?.subject_type).toBe('audio-ref');
  });

  it('服务函数 consent=false → 400(不因入口而异)', async () => {
    const { storeAudioInput } = await import('../src/api/jobs.js');
    const buf = mp3ish('d5-svc');
    const r = await storeAudioInput(
      { tenantId: tId, userId: 'u1', ip: null, apiKeyId: null },
      { buffer: buf, mimetype: 'audio/mpeg', originalname: 'x.mp3', size: buf.length },
      false,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('授权');
  });
});
