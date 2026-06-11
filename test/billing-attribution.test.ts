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

beforeAll(() => {
  const t = createTenant('归属测试台');
  // 用真实租户 id 覆盖常量 T 不行(createTenant 自生成 id),改用它的 id
  (globalThis as Record<string, unknown>).__T = t.id;
  const u = createUser(t.id, 'attruser', 'pw123456', 'creator');
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

describe('reserve==settle 不受归属影响', () => {
  it('短结算退差额,余额正确(归属只读 JOIN,不碰金额)', () => {
    const bal0 = balance(tenant());
    const id = enqueueJob('tts', { text: 'x', voiceRef: 'Cherry' }, tenant(), uid);
    reserve(tenant(), id, 20);
    settle(tenant(), id, 8); // 实扣 8,退 12
    expect(balance(tenant())).toBe(bal0 - 8);
  });
});
