// 灵镜 队列单元测试 —— 原子领取(无重复领取)+ 状态流转。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { enqueueVideo, claimNextJob, getJob, markDone, markFailed, retryJob } = await import(
  '../src/queue/index.js'
);
const { db } = await import('../src/db/index.js');

const input = { avatarRef: 'a', voiceRef: 'v', script: '文案' };

describe('DB 队列', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM job').run(); // 每个用例干净起步,避免跨用例残留任务干扰
  });

  it('入队后状态为 queued', () => {
    const id = enqueueVideo(input);
    expect(getJob(id)!.status).toBe('queued');
  });

  it('claim 把 queued 置为 running 并返回该 job', () => {
    const id = enqueueVideo(input);
    const claimed = claimNextJob();
    expect(claimed).toBeTruthy();
    expect(getJob(claimed!.id)!.status).toBe('running');
  });

  it('claim 按 created_at 先进先出', () => {
    const first = enqueueVideo({ ...input, script: '第一条' });
    const second = enqueueVideo({ ...input, script: '第二条' });
    const c1 = claimNextJob()!;
    const c2 = claimNextJob()!;
    expect(c1.id).toBe(first);
    expect(c2.id).toBe(second);
  });

  it('队列空时 claim 返回 null', () => {
    // 先清空:把所有 queued 领走
    while (claimNextJob()) {
      /* drain */
    }
    expect(claimNextJob()).toBeNull();
  });

  it('markDone / markFailed / retry 流转正确', () => {
    const id = enqueueVideo(input);
    claimNextJob();
    markDone(id, 'videos/x.mp4', 'none');
    expect(getJob(id)!.status).toBe('done');
    expect(getJob(id)!.output_url).toBe('videos/x.mp4');

    const id2 = enqueueVideo(input);
    claimNextJob();
    markFailed(id2, '出错了');
    expect(getJob(id2)!.status).toBe('failed');
    expect(retryJob(id2)).toBe(true);
    expect(getJob(id2)!.status).toBe('queued');
  });

  it('非 failed 状态不可重试', () => {
    const id = enqueueVideo(input);
    expect(retryJob(id)).toBe(false); // queued 不可重试
  });
});
