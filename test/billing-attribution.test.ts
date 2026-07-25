// 灵镜 — 用量计费归属(谁消费 + 什么工具)。
//
// 覆盖:
//   - enqueueJob(createdBy) → job.created_by 入库;缺省 → NULL(老路径 byte-identical)
//   - ledger() JOIN:有 job 的预扣/结算行返回 toolType + userName;grant 行两者空;
//     老 job(created_by NULL)userName 空
//   - reserve==settle 不受影响(归属只读 JOIN,不碰金额)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { enqueueJob, getJob } = await import('../src/queue/index.js');
const { grant, reserve, settle, ledger, balance } = await import('../src/credits/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');

const T = 'attr-tenant';
let uid = '';

beforeAll(async () => {
  const t = createTenant('归属测试台');
  // 用真实租户 id 覆盖常量 T 不行(createTenant 自生成 id),改用它的 id
  (globalThis as Record<string, unknown>).__T = t.id;
  const u = await createUser(t.id, 'attruser', 'pw123456', 'creator');
  uid = u.id;
  grant(t.id, 100000);
});

function tenant(): string {
  return (globalThis as Record<string, unknown>).__T as string;
}

describe('enqueueJob 记录创建者', () => {
  it('带 createdBy → job.created_by 入库', () => {
    const id = enqueueJob('tts', { text: 'x', voiceRef: 'Cherry' }, tenant(), uid);
    expect(getJob(id)!.created_by).toBe(uid);
  });
  it('不带 createdBy → NULL(老路径)', () => {
    const id = enqueueJob('video', { script: 'x' }, tenant());
    expect(getJob(id)!.created_by).toBeNull();
  });
});

describe('ledger() JOIN 出消费人 + 工具', () => {
  it('有 job 的预扣行 → toolType + userName', () => {
    const id = enqueueJob('ai_image', { prompt: 'p' }, tenant(), uid);
    reserve(tenant(), id, 10);
    const row = ledger(tenant()).find((l) => l.job_id === id && l.kind === 'reserve');
    expect(row).toBeTruthy();
    expect(row!.toolType).toBe('ai_image');
    expect(row!.userName).toBe('attruser'); // display_name 空 → 回落 username
  });

  it('结算行同样带归属', () => {
    const id = enqueueJob('ai_music', { mode: 'song', prompt: 'p' }, tenant(), uid);
    reserve(tenant(), id, 12);
    settle(tenant(), id, 12);
    const row = ledger(tenant()).find((l) => l.job_id === id && l.kind === 'settle');
    expect(row!.toolType).toBe('ai_music');
    expect(row!.userName).toBe('attruser');
  });

  it('grant 发放行 → toolType / userName 均空(无 job)', () => {
    const row = ledger(tenant()).find((l) => l.kind === 'grant');
    expect(row).toBeTruthy();
    expect(row!.toolType ?? null).toBeNull();
    expect(row!.userName ?? null).toBeNull();
  });

  it('老 job(created_by NULL)→ userName 空、toolType 仍有(工具不依赖用户)', () => {
    const id = enqueueJob('video', { script: 'x' }, tenant()); // 不传 createdBy
    reserve(tenant(), id, 5);
    const row = ledger(tenant()).find((l) => l.job_id === id);
    expect(row!.toolType).toBe('video');
    expect(row!.userName ?? null).toBeNull();
  });
});

describe('ledger() 关联作品文案摘要(taskTitle)', () => {
  // 隐私隔离(2026-07):taskTitle/outputKind 按**归属**脱敏 —— 只有本人看自己的行才带文案。
  // 故本块一律以创建者 uid 的视角查;不传 actingUserId 时(内部调用)一律按「非本人」从严处理。
  const led = () => ledger(tenant(), 100, uid, false);
  it('video → 取 script 文案', () => {
    const id = enqueueJob('video', { script: '大家好我是数字人' }, tenant(), uid);
    reserve(tenant(), id, 5);
    const row = led().find((l) => l.job_id === id);
    expect(row!.taskTitle).toBe('大家好我是数字人');
    expect(row!.outputKind ?? null).toBeNull(); // 未完成(无 output_url)→ outputKind 不暴露,前端不可点
  });

  it('已完成(有 output_url)→ outputKind 暴露,前端可点预览', async () => {
    const { markDone } = await import('../src/queue/index.js');
    const id = enqueueJob('ai_image', { prompt: '出图测试' }, tenant(), uid);
    reserve(tenant(), id, 5);
    markDone(id, JSON.stringify(['ai-images/x.png']), 'qwen', 'image');
    const row = led().find((l) => l.job_id === id);
    expect(row!.outputKind).toBe('image'); // 有成品 → 暴露产物类型
    expect(row!.taskTitle).toBe('出图测试');
  });

  it('tts → 取 text 文案', () => {
    const id = enqueueJob('tts', { text: '欢迎收听本期节目', voiceRef: 'Cherry' }, tenant(), uid);
    reserve(tenant(), id, 5);
    const row = led().find((l) => l.job_id === id);
    expect(row!.taskTitle).toBe('欢迎收听本期节目');
  });

  it('ai_image / video_edit → 取 prompt 文案', () => {
    const img = enqueueJob('ai_image', { prompt: '一只赛博朋克猫' }, tenant(), uid);
    reserve(tenant(), img, 5);
    expect(led().find((l) => l.job_id === img)!.taskTitle).toBe('一只赛博朋克猫');
  });

  it('ai_music → prompt 优先,无 prompt 回落 lyrics', () => {
    const a = enqueueJob('ai_music', { prompt: '轻快的电子乐', lyrics: '副歌' }, tenant(), uid);
    reserve(tenant(), a, 5);
    expect(led().find((l) => l.job_id === a)!.taskTitle).toBe('轻快的电子乐');
    const b = enqueueJob('ai_music', { lyrics: '只有歌词' }, tenant(), uid);
    reserve(tenant(), b, 5);
    expect(led().find((l) => l.job_id === b)!.taskTitle).toBe('只有歌词');
  });

  it('长文案截前 24 字 + 省略号', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const id = enqueueJob('tts', { text: long, voiceRef: 'Cherry' }, tenant(), uid);
    reserve(tenant(), id, 5);
    const t = led().find((l) => l.job_id === id)!.taskTitle!;
    expect(t).toBe(long.slice(0, 24) + '…');
    expect([...t].length).toBeLessThanOrEqual(25); // 24 字 + 省略号
  });

  it('grant 发放行 → taskTitle 空(无 job)', () => {
    const row = led().find((l) => l.kind === 'grant');
    expect(row!.taskTitle ?? null).toBeNull();
  });

  it('空文案 → taskTitle 空(前端回退工具名/「—」)', () => {
    const id = enqueueJob('tts', { text: '   ', voiceRef: 'Cherry' }, tenant(), uid);
    reserve(tenant(), id, 5);
    expect(led().find((l) => l.job_id === id)!.taskTitle ?? null).toBeNull();
  });

  it('坏 input_json 不让计费查询崩(安全回退空)', () => {
    const id = enqueueJob('video', { script: 'x' }, tenant(), uid);
    reserve(tenant(), id, 5);
    // 直接把 input_json 写坏,模拟脏数据
    db.prepare(`UPDATE job SET input_json='{not valid json' WHERE id=?`).run(id);
    expect(() => led()).not.toThrow();
    expect(led().find((l) => l.job_id === id)!.taskTitle ?? null).toBeNull();
  });
});

describe('reserve==settle 不受归属影响', () => {
  it('短结算退差额,余额正确(归属只读 JOIN,不碰金额)', () => {
    const bal0 = balance(tenant());
    const id = enqueueJob('tts', { text: 'x', voiceRef: 'Cherry' }, tenant(), uid);
    reserve(tenant(), id, 20);
    settle(tenant(), id, 8); // 实扣 8,退 12
    expect(balance(tenant())).toBe(bal0 - 8);
  });
});
