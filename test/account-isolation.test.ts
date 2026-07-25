// 灵镜 — 账号级数据隔离(机构共享 → 账号私有)。
//
// 2026-07 起隐私边界再收一档:**机构管理员也看不到其他成员的生成记录与资产**,
// 管理员改看聚合用量。故本文件按「隐私域 / 经营域」两条线断言:
//
// 隐私域(scopeByOwner —— 任何角色都只看自己,admin 无例外):
//   - 作品(list/get/download/delete/retry):IDOR 拿别人 ID → 404;admin 同样拿不到、删不掉
//   - 形象 / 音色 + isUsable*:自己的不共享;预置全员可用;
//     created_by IS NULL 的部署前老资产 = 机构公共,全员可见可用但谁都改不动删不掉
//   - 无主作品由启动迁移认领给租户首个 active admin(否则连带 ledger 归属一起失联)
//
// 经营域(scopeByActor —— admin 看全机构,维持原状):
//   - 计费 ledger:creator 只看自己消费行 + grant 行(eng-review 1B);参数不错位(eng-review 1A)
//     但**按归属脱敏**:非本人的行抹掉 taskTitle/outputKind(是内容,不是用量)
//   - 审计 listAudit:非 admin 只看自己
//
// 隐私隔离的正面补偿:
//   - usageByMember 聚合口径与 usageSummary.consumed 严格闭合;仅 admin 可读(creator → 403)
//
// 其余既有覆盖:老资产 backfill 正确性;砍 viewer(createUser/changeRole 拒 viewer + 迁移幂等)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser, changeRole } = await import('../src/auth/index.js');
const { enqueueJob, listJobsForTenant, countJobsForTenant, getJobForTenant, deleteJobForTenant, retryJob } =
  await import('../src/queue/index.js');
const { createCustomAvatar, listCustom, getAvatar, isUsableAvatar, renameAvatar, deleteAvatar } =
  await import('../src/avatars/index.js');
const { createDesignVoice, listClones, isUsableVoice, deleteVoice } = await import('../src/voices/index.js');
const { grant, reserve, settle, release, ledger, usageByMember, usageSummary } =
  await import('../src/credits/index.js');
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

describe('作品(job)隐私隔离 —— admin 也看不到他人', () => {
  it('每个人只看自己的生成记录', () => {
    const ja = jobBy(aliceId);
    const jb = jobBy(bobId);
    const aliceList = listJobsForTenant(tId, aliceId).map((j) => j.id);
    expect(aliceList).toContain(ja);
    expect(aliceList).not.toContain(jb); // 看不到 bob 的
  });

  it('机构管理员看不到任何成员的生成记录(本功能的核心断言)', () => {
    const ja = jobBy(aliceId);
    const jb = jobBy(bobId);
    const adminList = listJobsForTenant(tId, adminId).map((j) => j.id);
    expect(adminList).not.toContain(ja);
    expect(adminList).not.toContain(jb);
    // 单条直取同样拿不到(防「列表挡住了但详情页能开」)
    expect(getJobForTenant(ja, tId, adminId)).toBeUndefined();
    // count 与 list 必须同口径,否则分页器会显示「共 N 条」却一条也列不出
    expect(countJobsForTenant(tId, adminId)).toBe(0);
  });

  it('IDOR:creator 拿别人 jobId 取/删 → 取不到/删不掉(返回 undefined/false → 路由 404)', () => {
    const jb = jobBy(bobId);
    expect(getJobForTenant(jb, tId, aliceId)).toBeUndefined(); // alice 取 bob 的 → 看不到
    expect(getJobForTenant(jb, tId, bobId)).toBeTruthy(); // 本人能取
    expect(deleteJobForTenant(jb, tId, aliceId)).toBe(false); // alice 删 bob 的 → 失败
  });

  it('admin 删不掉 / 重试不了 creator 的作品(旧「善后」后门已封)', () => {
    const ja = jobBy(aliceId);
    expect(deleteJobForTenant(ja, tId, adminId)).toBe(false);
    expect(retryJob(ja, tId, adminId)).toBe(false);
    expect(getJobForTenant(ja, tId, aliceId)).toBeTruthy(); // 本人的还在,没被删掉
  });

  it('无主作品(created_by=NULL)对所有人隐身 —— 含 admin', () => {
    // 迁移只在启动时跑一次,之后再产生的 NULL 行不会被认领 → 谁都看不见(设计接受:只有平台超管能处理)
    const orphan = enqueueJob('ai_image', { prompt: 'old' }, tId, null);
    expect(listJobsForTenant(tId, aliceId).map((j) => j.id)).not.toContain(orphan);
    expect(listJobsForTenant(tId, adminId).map((j) => j.id)).not.toContain(orphan);
  });

  it('启动迁移:无主作品认领给租户首个 active admin', async () => {
    // 隔离出一个干净租户,避免与主测试租户的既有数据互相干扰
    const t2 = createTenant('迁移测试台').id;
    const a2 = (await createUser(t2, 'mig-admin', 'pw123456', 'admin')).id;
    const orphan = enqueueJob('ai_image', { prompt: 'legacy' }, t2, null);
    expect(listJobsForTenant(t2, a2).map((j) => j.id)).not.toContain(orphan); // 迁移前:隐身

    // 执行迁移(与 db/index.ts 'job_creator_backfilled' 同句;此处验证 SQL 正确性)
    db.prepare(
      `UPDATE job SET created_by = (
         SELECT u.id FROM user u
         WHERE u.tenant_id = job.tenant_id AND u.role='admin' AND u.status='active'
         ORDER BY u.created_at ASC, u.rowid ASC LIMIT 1)
       WHERE created_by IS NULL AND tenant_id=?`,
    ).run(t2);

    expect(listJobsForTenant(t2, a2).map((j) => j.id)).toContain(orphan); // 迁移后:归首个 admin
  });
});

describe('形象/音色隐私隔离 + isUsable', () => {
  it('形象:只看自己建的;isUsable 自己的可用、别人的不可用、预置全员可用', () => {
    const av = createCustomAvatar({ tenantId: tId, userId: aliceId, name: '主播A', kind: 'photo', sourceKey: 'k.png', consent: true });
    expect(listCustom(tId, aliceId).map((a) => a.id)).toContain(av.id);
    expect(listCustom(tId, bobId).map((a) => a.id)).not.toContain(av.id); // bob 看不到 alice 的
    expect(getAvatar(av.id, tId, aliceId)).toBeTruthy();
    expect(getAvatar(av.id, tId, bobId)).toBeUndefined(); // IDOR
    // isUsable:alice 用自己的 → 可;bob 用 alice 的 → 不可(自定义形象自己的不共享);预置 → 全员可用
    expect(isUsableAvatar(av.id, tId, aliceId)).toBe(true);
    expect(isUsableAvatar(av.id, tId, bobId)).toBe(false);
    expect(isUsableAvatar('preset-1', tId, bobId)).toBe(true); // 预置仍共享
  });

  it('机构管理员看不到、也用不了成员的形象与音色', () => {
    const av = createCustomAvatar({ tenantId: tId, userId: aliceId, name: '主播B', kind: 'photo', sourceKey: 'k2.png', consent: true });
    const v = createDesignVoice({ tenantId: tId, name: '低沉男声', providerVoiceId: 'vd-9', userId: aliceId });
    expect(listCustom(tId, adminId).map((a) => a.id)).not.toContain(av.id);
    expect(getAvatar(av.id, tId, adminId)).toBeUndefined();
    expect(isUsableAvatar(av.id, tId, adminId)).toBe(false); // 不能拿别人的脸去生成
    expect(listClones(tId, adminId).map((x) => x.id)).not.toContain(v.id);
    expect(isUsableVoice(v.id, tId, adminId)).toBe(false);
    // 也删不掉别人的
    expect(deleteAvatar(av.id, tId, adminId)).toBe(false);
    expect(deleteVoice(v.id, tId, adminId)).toBe(false);
  });

  it('音色:只看自己建的;isUsable 同形象', () => {
    const v = createDesignVoice({ tenantId: tId, name: '温柔女声', providerVoiceId: 'vd-1', userId: aliceId });
    expect(listClones(tId, aliceId).map((x) => x.id)).toContain(v.id);
    expect(listClones(tId, bobId).map((x) => x.id)).not.toContain(v.id);
    expect(isUsableVoice(v.id, tId, aliceId)).toBe(true);
    expect(isUsableVoice(v.id, tId, bobId)).toBe(false);
  });

  it('机构公共库(created_by=NULL 老资产):全员可见可用,但谁都改不动删不掉', () => {
    const pubAv = 'org-public-avatar-1';
    db.prepare(
      `INSERT INTO avatar (id,tenant_id,name,kind,status,source_key,thumb_url,authorization_id,orientation,is_default,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(pubAv, tId, '机构公共形象', 'photo', 'ready', 'pub.png', 'pub.png', null, 'portrait', 0, null, Date.now());
    const pubVo = 'org-public-voice-1';
    db.prepare(
      `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,provider_voice_id,authorization_id,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(pubVo, tId, '机构公共音色', 'design', 'ready', null, 'vd-pub', null, null, Date.now());

    // 全员可见可用(alice / bob / admin 三个视角都过)
    for (const uid of [aliceId, bobId, adminId]) {
      expect(listCustom(tId, uid).map((a) => a.id)).toContain(pubAv);
      expect(isUsableAvatar(pubAv, tId, uid)).toBe(true);
      expect(listClones(tId, uid).map((x) => x.id)).toContain(pubVo);
      expect(isUsableVoice(pubVo, tId, uid)).toBe(true);
    }
    // 只读:谁都不能改名/删除(防一个人误删掉全机构在用的共享素材)
    expect(renameAvatar(pubAv, tId, '改个名', aliceId)).toBe(false);
    expect(renameAvatar(pubAv, tId, '改个名', adminId)).toBe(false);
    expect(deleteAvatar(pubAv, tId, adminId)).toBe(false);
    expect(deleteVoice(pubVo, tId, adminId)).toBe(false);
  });
});

describe('计费明细账号隔离(grant 行可见 + 参数不错位)', () => {
  it('creator 只看自己消费行 + grant 发放行(eng-review 1B);admin 看全部', () => {
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
    // admin 看全部(含 bob)—— 经营域保留逐笔对账能力
    const adminLedger = ledger(tId, 100, adminId, true);
    expect(adminLedger.some((r) => r.job_id === jb)).toBe(true);
  });

  it('按归属脱敏:admin 看得到他人行的用量,看不到文案与产物', () => {
    const jb = enqueueJob('ai_image', { prompt: '这是 bob 的机密选题文案' }, tId, bobId);
    reserve(tId, jb, 30);
    const row = ledger(tId, 200, adminId, true).find((r) => r.job_id === jb);
    expect(row).toBeTruthy();
    // 用量字段保留:消费人 / 工具 / 点数 —— 管理员据此做用量归属与对账
    expect(row!.userName).toBe('bob');
    expect(row!.toolType).toBe('ai_image');
    expect(row!.amount).toBe(-30);
    // 内容字段抹掉:文案摘要 + 可预览产物类型
    expect(row!.taskTitle).toBeNull();
    expect(row!.outputKind).toBeNull();
    // 本人看自己的行仍有文案(脱敏判据是归属,不是角色)
    const own = ledger(tId, 200, bobId, false).find((r) => r.job_id === jb);
    expect(own!.taskTitle).toContain('机密选题');
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

describe('按成员用量聚合(隐私隔离的正面补偿)', () => {
  it('口径闭合:各成员净消耗之和 == usageSummary.consumed', async () => {
    // 独立租户,避免主租户既有数据把恒等式算糊
    const t3 = createTenant('用量聚合台').id;
    const u1 = (await createUser(t3, 'usage-a', 'pw123456', 'admin')).id;
    const u2 = (await createUser(t3, 'usage-b', 'pw123456', 'creator')).id;
    grant(t3, 100000);

    const j1 = enqueueJob('ai_image', { prompt: 'x' }, t3, u1);
    reserve(t3, j1, 10);
    settle(t3, j1, 8); // token 模型:预扣 10 实扣 8,退差 2
    const j2 = enqueueJob('tts', { text: 'y' }, t3, u2);
    reserve(t3, j2, 50);
    settle(t3, j2, 50);
    const j3 = enqueueJob('video', { script: 'z' }, t3, u2);
    reserve(t3, j3, 70);
    release(t3, j3); // 失败任务:reserve+release 相抵 = 0

    const members = usageByMember(t3);
    const sum = members.reduce((a, m) => a + m.spend, 0);
    expect(sum).toBe(usageSummary(t3).consumed); // ← 恒等式:数字必须对得上,否则管理员不信
    expect(sum).toBe(58); // 8 + 50 + 0

    const mb = members.find((m) => m.userId === u2)!;
    expect(mb.spend).toBe(50);
    expect(mb.genCount).toBe(1); // 只有 tts 结算成功计一次;video 失败走 release,不算完成
    expect(mb.byTool.map((t) => t.toolType)).toContain('tts');
  }, 30000);

  it('不含任何文案/产物字段(只给数字)', async () => {
    const t4 = createTenant('用量脱敏台').id;
    const u = (await createUser(t4, 'usage-c', 'pw123456', 'creator')).id;
    grant(t4, 10000);
    const j = enqueueJob('ai_image', { prompt: '绝密文案不该出现在用量里' }, t4, u);
    reserve(t4, j, 5);
    settle(t4, j, 5);
    // 整个返回体序列化后不得出现文案原文
    expect(JSON.stringify(usageByMember(t4))).not.toContain('绝密文案');
  }, 30000);

  it('creator 调 /credits/usage-by-member → 403;admin → 200', async () => {
    const t5 = createTenant('用量鉴权台').id;
    await createUser(t5, 'usage-admin', 'pw123456', 'admin');
    await createUser(t5, 'usage-creator', 'pw123456', 'creator');

    const cCreator = new Client(app);
    expect((await cCreator.login('usage-creator', 'pw123456')).status).toBe(200);
    expect((await cCreator.get('/api/credits/usage-by-member')).status).toBe(403);

    const cAdmin = new Client(app);
    expect((await cAdmin.login('usage-admin', 'pw123456')).status).toBe(200);
    const r = await cAdmin.get('/api/credits/usage-by-member?range=month');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.members)).toBe(true);
  }, 30000);
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
