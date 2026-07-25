// 灵镜 — 账号级数据隔离(机构共享 → 账号私有)。
//
// 2026-07-25 产品决策:生成内容彻底私有,**租户管理员也不例外**。本文件此前断言的
// 「admin 看全机构 / admin 能删 creator 的作品 / admin 可用任意形象」已全部反转为负向断言。
//
// 覆盖:
//   - 所有角色(含 admin)只看自己的:作品(list/get/download/delete 四端点)+ 形象 + 音色;IDOR → 404
//   - admin 越权负向:看不到、取不到、删不掉、重试不了他人作品
//   - NULL 老数据:对所有人不可见(含 admin)——老数据不迁移,已确认可接受
//   - isUsable* 账号隔离(自己的不共享,admin 亦然;预置仍全员可用)
//   - 计费 ledger「只看账不看内容」:admin 见他人行(谁/工具/积分)但 taskTitle/outputKind 被屏蔽
//   - 审计 listAudit:非 admin 只看自己(合规口径,**未随资产隔离改动**)
//   - 老资产 backfill(从 audit_log 回填 created_by)正确性
//   - 砍 viewer:createUser/changeRole 拒 viewer;viewer→creator 迁移幂等

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser, changeRole } = await import('../src/auth/index.js');
const { enqueueJob, listJobsForTenant, getJobForTenant, deleteJobForTenant, retryJob } = await import('../src/queue/index.js');
const { createCustomAvatar, listCustom, getAvatar, isUsableAvatar, setDefaultAvatar, getDefaultAvatar } =
  await import('../src/avatars/index.js');
const { createDesignVoice, listClones, isUsableVoice } = await import('../src/voices/index.js');
const { grant, reserve, ledger } = await import('../src/credits/index.js');
const { writeAudit, listAudit } = await import('../src/audit/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tId = '';
let adminId = '';
let aliceId = ''; // creator A
let bobId = ''; // creator B

beforeAll(async () => {
  tId = createTenant('隔离测试台').id;
  adminId = (await createUser(tId, 'isoadmin', 'pw123456', 'admin')).id;
  aliceId = (await createUser(tId, 'alice', 'pw123456', 'creator')).id;
  bobId = (await createUser(tId, 'bob', 'pw123456', 'creator')).id;
  grant(tId, 100000);
});

// 便捷:为某用户造一个 job,返回 jobId
function jobBy(userId: string): string {
  return enqueueJob('ai_image', { prompt: 'p' }, tId, userId);
}

describe('作品(job)账号隔离', () => {
  it('每个人只看自己的 —— 管理员也一样', () => {
    const ja = jobBy(aliceId);
    const jb = jobBy(bobId);
    const aliceList = listJobsForTenant(tId, aliceId).map((j) => j.id);
    expect(aliceList).toContain(ja);
    expect(aliceList).not.toContain(jb); // 看不到 bob 的
    const adminList = listJobsForTenant(tId, adminId).map((j) => j.id);
    expect(adminList).not.toContain(ja); // admin 看不到 alice 的
    expect(adminList).not.toContain(jb); // 也看不到 bob 的
  });

  it('IDOR:creator 拿别人 jobId 取/删 → 取不到/删不掉(返回 undefined/false → 路由 404)', () => {
    const jb = jobBy(bobId);
    expect(getJobForTenant(jb, tId, aliceId)).toBeUndefined(); // alice 取 bob 的 → 看不到
    expect(getJobForTenant(jb, tId, bobId)).toBeTruthy(); // 本人能取
    expect(deleteJobForTenant(jb, tId, aliceId)).toBe(false); // alice 删 bob 的 → 失败
  });

  it('admin 越权负向:他人作品取不到、删不掉、重试不了', () => {
    const ja = jobBy(aliceId);
    expect(getJobForTenant(ja, tId, adminId)).toBeUndefined(); // 取不到
    expect(deleteJobForTenant(ja, tId, adminId)).toBe(false); // 删不掉(不再有善后权)
    db.prepare(`UPDATE job SET status='failed' WHERE id=?`).run(ja);
    expect(retryJob(ja, tId, adminId)).toBe(false); // 重试不了
    expect(retryJob(ja, tId, aliceId)).toBe(true); // 本人可以
  });

  it('NULL 老数据:对所有人不可见,含 admin(老数据不迁移)', () => {
    const orphan = enqueueJob('ai_image', { prompt: 'old' }, tId, null); // created_by=NULL(老数据)
    expect(listJobsForTenant(tId, aliceId).map((j) => j.id)).not.toContain(orphan);
    expect(listJobsForTenant(tId, adminId).map((j) => j.id)).not.toContain(orphan);
  });
});

describe('形象/音色账号隔离 + isUsable', () => {
  it('形象:只看自己建的;isUsable 自己的可用、别人的不可用(admin 亦然)、预置全员可用', () => {
    const av = createCustomAvatar({ tenantId: tId, userId: aliceId, name: '主播A', kind: 'photo', sourceKey: 'k.png', consent: true });
    expect(listCustom(tId, aliceId).map((a) => a.id)).toContain(av.id);
    expect(listCustom(tId, bobId).map((a) => a.id)).not.toContain(av.id); // bob 看不到 alice 的
    expect(listCustom(tId, adminId).map((a) => a.id)).not.toContain(av.id); // admin 也看不到
    expect(getAvatar(av.id, tId, aliceId)).toBeTruthy();
    expect(getAvatar(av.id, tId, bobId)).toBeUndefined(); // IDOR
    expect(getAvatar(av.id, tId, adminId)).toBeUndefined(); // admin IDOR 同样挡住
    // isUsable:alice 用自己的 → 可;bob / admin 用 alice 的 → 不可;预置 → 全员可用
    expect(isUsableAvatar(av.id, tId, aliceId)).toBe(true);
    expect(isUsableAvatar(av.id, tId, bobId)).toBe(false);
    expect(isUsableAvatar('preset-1', tId, bobId)).toBe(true); // 预置仍共享
    expect(isUsableAvatar(av.id, tId, adminId)).toBe(false); // admin 不能拿他人形象去生成
  });

  it('形象默认标记按人互斥:甲设默认不影响乙的默认', () => {
    const a1 = createCustomAvatar({ tenantId: tId, userId: aliceId, name: 'A默认', kind: 'photo', sourceKey: 'a.png', consent: true });
    const b1 = createCustomAvatar({ tenantId: tId, userId: bobId, name: 'B默认', kind: 'photo', sourceKey: 'b.png', consent: true });
    expect(setDefaultAvatar(a1.id, tId, aliceId)).toBe(true);
    expect(setDefaultAvatar(b1.id, tId, bobId)).toBe(true); // bob 设自己的
    expect(getDefaultAvatar(tId, aliceId)?.id).toBe(a1.id); // alice 的默认没被 bob 清掉
    expect(getDefaultAvatar(tId, bobId)?.id).toBe(b1.id);
    expect(setDefaultAvatar(a1.id, tId, bobId)).toBe(false); // bob 设 alice 的形象为默认 → 拒
  });

  it('音色:只看自己建的;isUsable 同形象', () => {
    const v = createDesignVoice({ tenantId: tId, name: '温柔女声', providerVoiceId: 'vd-1', userId: aliceId });
    expect(listClones(tId, aliceId).map((x) => x.id)).toContain(v.id);
    expect(listClones(tId, bobId).map((x) => x.id)).not.toContain(v.id);
    expect(listClones(tId, adminId).map((x) => x.id)).not.toContain(v.id); // admin 也看不到
    expect(isUsableVoice(v.id, tId, aliceId)).toBe(true);
    expect(isUsableVoice(v.id, tId, bobId)).toBe(false);
    expect(isUsableVoice(v.id, tId, adminId)).toBe(false); // admin 不能拿他人音色去合成
  });
});

describe('计费明细:行可见性 + 内容闸门(「只看账不看内容」)', () => {
  it('creator 只看自己消费行 + grant 发放行(eng-review 1B);admin 看全部行', () => {
    const ja = jobBy(aliceId);
    const jb = jobBy(bobId);
    reserve(tId, ja, 10);
    reserve(tId, jb, 20);
    const aliceLedger = ledger(tId, 100, aliceId, false);
    // alice 看到自己的预扣行
    expect(aliceLedger.some((r) => r.job_id === ja)).toBe(true);
    // 看不到 bob 的预扣行
    expect(aliceLedger.some((r) => r.job_id === jb)).toBe(false);
    // grant 发放行(job_id=NULL)仍可见(机构钱包入账)
    expect(aliceLedger.some((r) => r.kind === 'grant')).toBe(true);
    // admin 看全部行(机构要管预算 → 保留「谁花了多少」)
    const adminLedger = ledger(tId, 100, adminId, true);
    expect(adminLedger.some((r) => r.job_id === jb)).toBe(true);
  });

  it('admin 看得到他人的账,但看不到内容:taskTitle / outputKind 被屏蔽', () => {
    const ja = enqueueJob('ai_image', { prompt: '这是 alice 的私密提示词' }, tId, aliceId);
    reserve(tId, ja, 10);
    // 造一个已完成、有产物的行(否则 outputKind 本来就是 null,测不出闸门)
    db.prepare(`UPDATE job SET status='done', output_url=?, output_kind='image' WHERE id=?`)
      .run(JSON.stringify(['out/a.png']), ja);

    // 本人:拿得到文案摘要 + 产物入口(可点开预览)
    const own = ledger(tId, 200, aliceId, false).find((r) => r.job_id === ja);
    expect(own?.taskTitle).toContain('私密提示词');
    expect(own?.outputKind).toBe('image');

    // admin:看得到这一行(谁 / 什么工具 / 多少积分),但拿不到内容
    const seen = ledger(tId, 200, adminId, true).find((r) => r.job_id === ja);
    expect(seen).toBeTruthy(); // 行在
    expect(seen?.userName).toBe('alice'); // 知道是谁花的
    expect(seen?.toolType).toBe('ai_image'); // 知道用了什么工具
    expect(seen?.taskTitle).toBeNull(); // 但看不到提示词
    expect(seen?.outputKind).toBeNull(); // 也点不开产物

    // bob(creator)连这一行都看不到
    expect(ledger(tId, 200, bobId, false).some((r) => r.job_id === ja)).toBe(false);
  });

  it('[eng-review 1A] 参数不错位:带 created_by 过滤 + limit 同时,返回自己的前 N 条而非错位', () => {
    // alice 多造几条
    for (let i = 0; i < 5; i++) { const j = jobBy(aliceId); reserve(tId, j, 1); }
    const limited = ledger(tId, 3, aliceId, false);
    expect(limited.length).toBeLessThanOrEqual(3); // limit 生效(没被 created_by 参数挤掉)
    // 全是 alice 的消费行或 grant 行(没串入 bob 的)
    expect(limited.every((r) => r.kind === 'grant' || r.userName === 'alice')).toBe(true);
  });
});

describe('审计日志账号隔离', () => {
  it('非 admin 只看自己的操作;admin 看全机构', () => {
    writeAudit(tId, aliceId, 'login', null, '1.2.3.4', 'user');
    writeAudit(tId, bobId, 'login', null, '1.2.3.4', 'user');
    const aliceAudit = listAudit(tId, 200, aliceId, false);
    expect(aliceAudit.every((a) => a.user_id === aliceId)).toBe(true); // 全是自己的
    expect(aliceAudit.some((a) => a.user_id === bobId)).toBe(false); // 看不到 bob 的
    const adminAudit = listAudit(tId, 200, adminId, true);
    expect(adminAudit.some((a) => a.user_id === bobId)).toBe(true); // admin 看得到
  });

  it('信任边界:平台超管操作(target=本租户)绝不进租户审计,连 admin 也看不到', () => {
    // 模拟平台超管对本租户充值/确认订单(actor_type=platform_admin,落本租户 audit_log)
    writeAudit(tId, 'padmin-x', 'grant_credit', '+55000', '1.2.3.4', 'platform_admin');
    writeAudit(tId, 'padmin-x', 'order_confirm', 'LJ-1/+55000', '1.2.3.4', 'platform_admin');
    // 租户 admin 视角:看不到任何平台操作(只显 actor_type='user')
    const adminAudit = listAudit(tId, 500, adminId, true);
    expect(adminAudit.some((a) => a.actor_type === 'platform_admin')).toBe(false);
    expect(adminAudit.some((a) => a.action === 'grant_credit')).toBe(false);
    expect(adminAudit.some((a) => a.action === 'order_confirm')).toBe(false);
    // creator 视角同样看不到
    const aliceAudit = listAudit(tId, 500, aliceId, false);
    expect(aliceAudit.some((a) => a.actor_type === 'platform_admin')).toBe(false);
  });
});

describe('老资产 backfill(部署前建的资产迁移后原创作者仍可见)', () => {
  it('audit_log 有 create_avatar 记录 → 回填 created_by → 原创作者可见', () => {
    // 模拟部署前:avatar 行 created_by=NULL,但 audit_log 有归属记录
    const avId = 'legacy-avatar-1';
    db.prepare(
      `INSERT INTO avatar (id,tenant_id,name,kind,status,source_key,thumb_url,authorization_id,orientation,is_default,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(avId, tId, '老形象', 'photo', 'ready', 'k.png', 'k.png', null, 'portrait', 0, null, Date.now());
    db.prepare(
      `INSERT INTO audit_log (id,tenant_id,user_id,actor_type,action,target,ip,detail,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('audit-legacy-1', tId, aliceId, 'user', 'create_avatar', avId, null, null, Date.now());
    // 执行回填(与 db/index.ts 迁移同句;此处验证 SQL 正确性)
    db.prepare(
      `UPDATE avatar SET created_by = (
         SELECT a.user_id FROM audit_log a
         WHERE a.action='create_avatar' AND a.target=avatar.id AND a.user_id IS NOT NULL
         ORDER BY a.created_at ASC LIMIT 1)
       WHERE created_by IS NULL AND id=?`,
    ).run(avId);
    // 回填后 alice(creator)能看到
    expect(listCustom(tId, aliceId).map((a) => a.id)).toContain(avId);
    expect(listCustom(tId, bobId).map((a) => a.id)).not.toContain(avId);
  });
});

// ── 输入素材引用跨租户 IDOR(T-IMGREF-IDOR,PR0 修复)──
// 攻击面:POST /jobs 与 /jobs/estimate 的 imageRefs/videoRefs/audioRefs/videoRef
// 直接透传存储 key,worker 会签名送厂商。修复:路由入口校验 key 必须带本租户上传前缀
// (image-inputs/<tid>/ 等),builder 执行前拦截(estimate 的 sidecar 读也一并挡住)。
// 自造数据,不依赖本文件其他 describe 的状态(T-TEST-ORDER-DEPENDENCE 规范)。
describe('输入素材引用跨租户 IDOR(POST /jobs 前缀校验)', () => {
  const idorClient = new Client(app);
  let tA = ''; // 攻击者租户
  let tB = ''; // 受害者租户

  beforeAll(async () => {
    tA = createTenant('IDOR 攻击方').id;
    tB = createTenant('IDOR 受害方').id;
    await createUser(tA, 'idorattacker', 'pw123456', 'creator');
    grant(tA, 100000);
    const r = await idorClient.login('idorattacker', 'pw123456');
    expect(r.status).toBe(200);
  }, 30000);

  it('图生图带他租户 imageRef → 400,不入队', async () => {
    const r = await idorClient.post('/api/jobs', {
      type: 'ai_image', mode: 'img2img', prompt: 'p',
      imageRefs: [`image-inputs/${tB}/steal.png`],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('素材');
  });

  it('图生图无前缀裸 key → 400(伪造/枚举探测)', async () => {
    const r = await idorClient.post('/api/jobs', {
      type: 'ai_image', mode: 'img2img', prompt: 'p', imageRefs: ['k1'],
    });
    expect(r.status).toBe(400);
  });

  it('i2v 首帧带他租户 imageRef → 400', async () => {
    const r = await idorClient.post('/api/jobs', {
      type: 'video_i2v', model: 'happyhorse-1.0-i2v', task: 'first_frame',
      imageRefs: [`image-inputs/${tB}/face.png`],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('素材');
  });

  it('r2v 的 videoRefs/audioRefs 带他租户 key → 400', async () => {
    const r = await idorClient.post('/api/jobs', {
      type: 'video_r2v', prompt: '按[视频1]生成',
      imageRefs: [`image-inputs/${tA}/mine.png`],
      videoRefs: [`video-inputs/${tB}/steal.mp4`],
    });
    expect(r.status).toBe(400);
    const r2 = await idorClient.post('/api/jobs', {
      type: 'video_r2v', prompt: '按[图1]生成',
      imageRefs: [`image-inputs/${tA}/mine.png`],
      audioRefs: [`audio-inputs/${tB}/steal.mp3`],
    });
    expect(r2.status).toBe(400);
  });

  it('video_edit 带他租户 videoRef → 400,且不泄漏 sidecar 元数据("元数据丢失"也不该出现)', async () => {
    const r = await idorClient.post('/api/jobs', {
      type: 'video_edit', model: 'wan2.7-videoedit', prompt: 'x',
      videoRef: `video-inputs/${tB}/private.mp4`,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('素材'); // 是前缀拦截,不是走到 sidecar 读取后的报错
  });

  it('estimate 同样拦截(不能借报价接口探测他租户 sidecar)', async () => {
    const r = await idorClient.post('/api/jobs/estimate', {
      type: 'video_edit', model: 'wan2.7-videoedit',
      videoRef: `video-inputs/${tB}/private.mp4`,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('素材');
  });

  it('本租户前缀的 imageRef → 通过校验正常入队(202)', async () => {
    const r = await idorClient.post('/api/jobs', {
      type: 'ai_image', mode: 'img2img', prompt: 'p',
      imageRefs: [`image-inputs/${tA}/mine.png`],
    });
    expect(r.status).toBe(202);
    expect(r.body.id).toBeTruthy();
  });
});

describe('砍 viewer 角色', () => {
  it('createUser(viewer) → INVALID_ROLE', async () => {
    await expect(createUser(tId, 'whoviewer', 'pw123456', 'viewer' as never)).rejects.toThrow();
  });
  it('changeRole → viewer → 拒', () => {
    expect(() => changeRole(tId, bobId, 'viewer' as never, adminId)).toThrow();
  });
  it('viewer→creator 迁移幂等(零 viewer 也安全)', () => {
    expect(() => db.prepare(`UPDATE user SET role='creator' WHERE role='viewer'`).run()).not.toThrow();
  });
});
