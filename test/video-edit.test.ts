// 灵镜 视频编辑(video_edit)单元测试 —— registry 三向互斥 / 计价 / submit media 组装。
//
// 覆盖 /plan-eng-review 测试矩阵:
//   - edit 两模型自洽 + t2v/i2v/edit 三列表零交集(A1 回归关键:edit 不泄进图转影片页)
//   - costFor('video_edit') 读 billableSecondsSnapshot(贴厂商 in+out;HH 截 15 / wan 截断)
//   - submitVideoT2V:media 首元素 {type:'video'};edit 不发 duration(防误截);
//     watermark 显式 false;truncate/audio_setting 仅有值才下发

import { describe, it, expect, afterEach, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { VIDEO_MODELS, listEditModels, getEditModel, listI2VModels, listVideoModels } =
  await import('../src/gateway/video-models.js');
const { estimateVideoCost, costFor } = await import('../src/credits/index.js');
const { BaichuanGateway } = await import('../src/gateway/baichuan.js');

afterEach(() => vi.restoreAllMocks());

describe('edit registry 自洽 + 三向互斥', () => {
  it('两编辑模型:tasks=[edit]、videoDurRange、refMax、tier(HH 720P=32、wan 720P=21)', () => {
    const edits = listEditModels();
    expect(edits.map((d) => d.key).sort()).toEqual(['happyhorse-1.0-video-edit', 'wan2.7-videoedit']);
    const hh = VIDEO_MODELS['happyhorse-1.0-video-edit']!;
    expect(hh.videoDurRange).toEqual([3, 60]);
    expect(hh.maxOutSeconds).toBe(15);
    expect(hh.maxRefImages).toBe(5);
    expect(hh.promptRequired).toBe(true);
    expect(hh.priceTier).toBe(32); expect(hh.priceTier1080).toBe(56); // 0.9/1.6 元/秒 × 35
    expect(hh.supportsTruncate).toBe(false);
    const wan = VIDEO_MODELS['wan2.7-videoedit']!;
    expect(wan.videoDurRange).toEqual([2, 10]);
    expect(wan.maxOutSeconds).toBeUndefined();
    expect(wan.maxRefImages).toBe(4);
    expect(wan.promptRequired).toBe(false);
    expect(wan.priceTier).toBe(21); expect(wan.priceTier1080).toBe(35); // 0.6/1.0 元/秒 × 35
    expect(wan.supportsTruncate).toBe(true);
    for (const d of edits) {
      expect(d.shape).toBe('V_DASH');
      expect(d.supportsAudioOrigin).toBe(true);
      expect(d.videoMaxMB).toBe(100);
    }
  });

  it('三向互斥:t2v / i2v / edit 列表零交集(A1:edit 不泄进图转影片页)', () => {
    const t2v = listVideoModels().filter((d) => d.tasks.length === 0).map((d) => d.key);
    const i2v = listI2VModels().map((d) => d.key);
    const edit = listEditModels().map((d) => d.key);
    expect(t2v.length).toBe(3);
    expect(i2v.length).toBe(6); // 万相2.7 i2v/r2v + HappyHorse i2v/r2v + 豆包 seedance 2.0 / 2.0-fast(PR-2a);不含 edit
    expect(edit.length).toBe(2);
    const inter = (a: string[], b: string[]) => a.filter((k) => b.includes(k));
    expect(inter(t2v, i2v)).toEqual([]);
    expect(inter(t2v, edit)).toEqual([]);
    expect(inter(i2v, edit)).toEqual([]);
  });

  it('getEditModel:未知/i2v key → 默认编辑模型(不回落 t2v/i2v)', () => {
    expect(getEditModel('happyhorse-1.0-video-edit').key).toBe('happyhorse-1.0-video-edit');
    expect(getEditModel('wan2.7-i2v').key).toBe('wan2.7-videoedit');
    expect(getEditModel('不存在').key).toBe('wan2.7-videoedit');
  });
});

describe("costFor('video_edit') 读 billable 快照(reserve==settle)", () => {
  it('HH 输入 20s → billable=20+15=35;读快照与 estimateVideoCost 一致', () => {
    const cost = costFor('video_edit', {
      model: 'happyhorse-1.0-video-edit', billableSecondsSnapshot: 35, resSnapshot: '720P', priceTierSnapshot: 32,
    });
    expect(cost).toBe(estimateVideoCost(35, 32, '720P', false)); // 35 × 32 = 1120
  });

  it('wan 截断 5s(输入 8s)→ billable=8+5=13;1080P 价由快照表达(不再 ×2)', () => {
    // 快照 priceTier 已是该分辨率每秒售价(万相2.7 编辑 720P=21 / 1080P=35)。
    const p720 = costFor('video_edit', { model: 'wan2.7-videoedit', billableSecondsSnapshot: 13, resSnapshot: '720P', priceTierSnapshot: 21 });
    const p1080 = costFor('video_edit', { model: 'wan2.7-videoedit', billableSecondsSnapshot: 13, resSnapshot: '1080P', priceTierSnapshot: 35 });
    expect(p720).toBe(13 * 21); // 273
    expect(p1080).toBe(13 * 35); // 455
  });

  it('无快照(坏数据)→ 按 0 秒兜底 + 按分辨率派生每秒价(reserve==settle 同函数)', () => {
    // billable 无快照=0;priceTier 无快照→videoPriceTier(wan2.7-videoedit,720P,false)=21。
    expect(costFor('video_edit', { model: 'wan2.7-videoedit' }))
      .toBe(estimateVideoCost(0, 21, '720P', false));
  });
});

describe('submitVideoT2V media 组装(edit)', () => {
  function spyCapture() {
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, opts) => {
      body = JSON.parse((opts as RequestInit).body as string);
      return Promise.resolve(new Response(JSON.stringify({ output: { task_id: 't-1', task_status: 'PENDING' } }), { status: 200 }));
    });
    return () => body;
  }

  it('media 首元素 {type:video} + 参考图尾随;不发 duration;watermark 显式 false', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({
      model: 'happyhorse-1.0-video-edit', task: 'edit', videoRef: 'https://x/in.mp4',
      imageRefs: ['https://x/ref1.png', 'https://x/ref2.png'], prompt: '换上图中的毛衣', resolution: '720P',
    });
    const b = get();
    expect((b.input as any).media).toEqual([
      { type: 'video', url: 'https://x/in.mp4' },
      { type: 'reference_image', url: 'https://x/ref1.png' },
      { type: 'reference_image', url: 'https://x/ref2.png' },
    ]);
    const p = b.parameters as any;
    expect(p.watermark).toBe(false); // HH 厂商默认 true,必须显式 false
    expect(p.duration).toBeUndefined(); // 编辑不发 duration(发了会误截输入视频)
    expect(p.audio_setting).toBeUndefined(); // auto 缺省不发
    expect(b.model).toBe('happyhorse-1.0-video-edit');
  });

  it('wan 截断 + 保留原声 + 指定 ratio:三参数显式下发', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({
      model: 'wan2.7-videoedit', task: 'edit', videoRef: 'https://x/in.mp4', imageRefs: [],
      prompt: '黏土风格', resolution: '1080P', ratio: '9:16', truncateDuration: 5, audioSetting: 'origin',
    });
    const p = get().parameters as any;
    expect(p.duration).toBe(5);
    expect(p.audio_setting).toBe('origin');
    expect(p.ratio).toBe('9:16');
  });

  it('纯指令编辑(无参考图):media 仅 1 个 video;不传 ratio 则不发(跟原视频)', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({
      model: 'wan2.7-videoedit', task: 'edit', videoRef: 'https://x/in.mp4', imageRefs: [],
      prompt: '转黑白默片风', resolution: '720P',
    });
    expect((get().input as any).media).toEqual([{ type: 'video', url: 'https://x/in.mp4' }]);
    expect((get().parameters as any).ratio).toBeUndefined();
  });

  it('t2v 回归:无 task 时仍发 duration,无 media', async () => {
    const gw = new BaichuanGateway();
    const get = spyCapture();
    await gw.submitVideoT2V({ model: 'wan2.7-t2v', prompt: '海边日出', resolution: '720P', ratio: '16:9', duration: 5 });
    expect((get().parameters as any).duration).toBe(5);
    expect((get().input as any).media).toBeUndefined();
  });
});
