// 灵镜 文生视频(text2video)后端测试 —— registry / 计价 / submit 体形 / pollUntilDone / build 校验。
//
// 覆盖 /plan-eng-review 测试覆盖图的 video_t2v GAP:
//   - VIDEO_MODELS registry 自洽性(三模型 shape/modelId/durationRange/maxPromptChars + 可灵 mode→res)
//   - estimateVideoCost / costFor('video_t2v'):秒×档×tier、1080P=2×720P、audio 加价、读快照(reserve==settle)
//   - submitVideoT2V 体形:V_DASH(resolution+ratio)、V_KLING(mode+aspect_ratio+audio, kling/ 前缀)
//   - costFor('video') 不变(回归)

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';

const { VIDEO_MODELS, getVideoModel, isKnownVideoModel, listT2VModels, klingModeToResolution } =
  await import('../src/gateway/video-models.js');
const { estimateVideoCost, costFor } = await import('../src/credits/index.js');

describe('VIDEO_MODELS registry 自洽性', () => {
  it('t2v 模型 shape 合法、modelId 非空、durationRange 合理、maxPromptChars>0、ratios 非空', () => {
    const t2v = listT2VModels();
    expect(t2v.length).toBe(6); // 三个纯 t2v + Seedance 2.5 / 2.0 / 2.0 Fast 跨场景模型
    for (const d of t2v) {
      expect(['V_DASH', 'V_KLING']).toContain(d.shape);
      expect(d.modelId.length).toBeGreaterThan(0);
      const [lo, hi] = d.durationRange;
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeGreaterThanOrEqual(lo);
      expect(d.defaultDuration).toBeGreaterThanOrEqual(lo);
      expect(d.defaultDuration).toBeLessThanOrEqual(hi);
      expect(d.maxPromptChars).toBeGreaterThan(0);
      expect(d.resolutions.every((r) => r === '480P' || r === '720P' || r === '1080P')).toBe(true);
      expect(d.ratios.length).toBeGreaterThan(0); // t2v 都有 ratio(i2v 首帧无)
    }
  });

  it('可灵 modelId 带 kling/ 前缀、shape=V_KLING、supportsAudio', () => {
    const k = VIDEO_MODELS['kling-v3-t2v']!;
    expect(k.modelId.startsWith('kling/')).toBe(true);
    expect(k.shape).toBe('V_KLING');
    expect(k.supportsAudio).toBe(true);
  });

  it('happyhorse / wan2.7 是 V_DASH、不开 audio 开关(R6)', () => {
    expect(VIDEO_MODELS['happyhorse-1.0-t2v']!.shape).toBe('V_DASH');
    expect(VIDEO_MODELS['happyhorse-1.0-t2v']!.supportsAudio).toBe(false);
    expect(VIDEO_MODELS['wan2.7-t2v']!.supportsAudio).toBe(false); // audio_url 上传缓做
    expect(VIDEO_MODELS['wan2.7-t2v']!.supportsNegative).toBe(true);
    expect(VIDEO_MODELS['wan2.7-t2v']!.supportsPromptExtend).toBe(true);
  });

  it('可灵 mode→分辨率档:std→720P、pro→1080P(R3)', () => {
    expect(klingModeToResolution('std')).toBe('720P');
    expect(klingModeToResolution('pro')).toBe('1080P');
    expect(klingModeToResolution(undefined)).toBe('720P'); // 缺省 std
  });

  it('getVideoModel:未知/缺省 → 默认模型(wan2.7)', () => {
    expect(getVideoModel('kling-v3-t2v').key).toBe('kling-v3-t2v');
    expect(getVideoModel('不存在').key).toBe('wan2.7-t2v');
    expect(getVideoModel().key).toBe('wan2.7-t2v');
  });

  it('listT2VModels 含纯 t2v 与同时支持图生的 Seedance 2.x', () => {
    const t2vKeys = listT2VModels().map((d) => d.key).sort();
    expect(t2vKeys).toEqual([
      'doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.5',
      'happyhorse-1.0-t2v', 'kling-v3-t2v', 'wan2.7-t2v',
    ]);
  });

  it('Seedance 2.5 文生能力参数与官方模型 ID', () => {
    const d = VIDEO_MODELS['doubao-seedance-2.5']!;
    expect(d.modelId).toBe('doubao-seedance-2-5-260628');
    expect(d.resolutions).toEqual(['480P', '720P']);
    expect(d.durationRange).toEqual([4, 30]);
    expect(d.ratios[0]).toBe('adaptive');
    expect(d.supportsT2V).toBe(true);
  });

  it('isKnownVideoModel 白名单', () => {
    expect(isKnownVideoModel('wan2.7-t2v')).toBe(true);
    expect(isKnownVideoModel('__proto__')).toBe(false);
    expect(isKnownVideoModel('z-image')).toBe(false); // 图片模型不算视频
  });
});

describe('estimateVideoCost(秒 × 每秒售价积分)', () => {
  // 价格对齐(2026-06):priceTier 已是「该模型该分辨率/有声」的每秒售价积分;
  // resFactor / audioFactor 全取 1(真实比值随模型变,装不下单全局系数,改由 priceTier 编码)。
  it('基础:duration × priceTier(resFactor=1)', () => {
    expect(estimateVideoCost(5, 21, '720P', false)).toBe(105); // 大师720P 5s
    expect(estimateVideoCost(10, 21, '720P', false)).toBe(210);
  });

  it('1080P 不再 ×2:同 priceTier 时与 720P 相等(差价已在 priceTier 里)', () => {
    expect(estimateVideoCost(8, 35, '1080P', false)).toBe(estimateVideoCost(8, 35, '720P', false));
    // 真实 1080P 价靠传入更高的 priceTier 表达(大师 1080P=35 vs 720P=21)
    expect(estimateVideoCost(8, 35, '1080P', false)).toBe(280);
  });

  it('audio 不再乘 1.3:有声差价已并入 priceTier(可灵有声单列)', () => {
    expect(estimateVideoCost(5, 32, '720P', true)).toBe(160); // 可灵有声720P=32,无额外×1.3
    expect(estimateVideoCost(5, 32, '720P', true)).toBe(estimateVideoCost(5, 32, '720P', false));
  });

  it('未知分辨率回落 factor 1', () => {
    expect(estimateVideoCost(5, 21, '4K', false)).toBe(105);
  });
});

describe("costFor('video_t2v') 读快照(reserve==settle)", () => {
  it('读 durationSnapshot/resSnapshot/audioSnapshot/priceTierSnapshot', () => {
    // 快照里 priceTier 已是该组合每秒售价(可灵有声1080P=42)→ 10s × 42 = 420
    const cost = costFor('video_t2v', {
      model: 'kling-v3-t2v',
      durationSnapshot: 10, resSnapshot: '1080P', audioSnapshot: true, priceTierSnapshot: 42,
    });
    expect(cost).toBe(420);
    // 与 estimateVideoCost 直接算一致(同一函数,reserve==settle)
    expect(cost).toBe(estimateVideoCost(10, 42, '1080P', true));
  });

  it('无快照(老 job)回落实时派生:可灵 mode→res、audio 仅可灵', () => {
    // 可灵 pro → 1080P 档、audio=true → 派生 priceTierAudio1080=42(deriveVideoT2VParams)
    const c = costFor('video_t2v', { model: 'kling-v3-t2v', mode: 'pro', duration: 5, audio: true });
    expect(c).toBe(estimateVideoCost(5, 42, '1080P', true)); // 可灵有声1080P 每秒42
  });

  it('V_DASH 模型 audio 派生恒 false(R6:happyhorse 即便传 audio=true 也不计加价)', () => {
    const c = costFor('video_t2v', { model: 'happyhorse-1.0-t2v', resolution: '720P', duration: 5, audio: true });
    expect(c).toBe(estimateVideoCost(5, VIDEO_MODELS['happyhorse-1.0-t2v']!.priceTier, '720P', false));
  });
});

describe("costFor('video') 回归(数字人 s2v 不受影响)", () => {
  it('视频按字数计价仍正常', () => {
    expect(costFor('video', { script: '一二三四五', resolution: '720P' })).toBeGreaterThan(0);
  });
});
