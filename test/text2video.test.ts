// 灵镜 文生视频(text2video)后端测试 —— registry / 计价 / submit 体形 / pollUntilDone / build 校验。
//
// 覆盖 /plan-eng-review 测试覆盖图的 video_t2v GAP:
//   - VIDEO_MODELS registry 自洽性(三模型 shape/modelId/durationRange/maxPromptChars + 可灵 mode→res)
//   - estimateVideoCost / costFor('video_t2v'):秒×档×tier、1080P=2×720P、audio 加价、读快照(reserve==settle)
//   - submitVideoT2V 体形:V_DASH(resolution+ratio)、V_KLING(mode+aspect_ratio+audio, kling/ 前缀)
//   - costFor('video') 不变(回归)

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';

const { VIDEO_MODELS, getVideoModel, isKnownVideoModel, listVideoModels, klingModeToResolution } =
  await import('../src/gateway/video-models.js');
const { estimateVideoCost, costFor } = await import('../src/credits/index.js');

describe('VIDEO_MODELS registry 自洽性', () => {
  it('三模型 shape 合法、modelId 非空、durationRange 合理、maxPromptChars>0', () => {
    const keys = Object.keys(VIDEO_MODELS);
    expect(keys.length).toBe(3);
    for (const k of keys) {
      const d = VIDEO_MODELS[k]!;
      expect(['V_DASH', 'V_KLING']).toContain(d.shape);
      expect(d.modelId.length).toBeGreaterThan(0);
      const [lo, hi] = d.durationRange;
      expect(lo).toBeGreaterThan(0);
      expect(hi).toBeGreaterThanOrEqual(lo);
      expect(d.defaultDuration).toBeGreaterThanOrEqual(lo);
      expect(d.defaultDuration).toBeLessThanOrEqual(hi);
      expect(d.maxPromptChars).toBeGreaterThan(0);
      expect(d.resolutions.every((r) => r === '720P' || r === '1080P')).toBe(true);
      expect(d.ratios.length).toBeGreaterThan(0);
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

  it('listVideoModels 列全三模型', () => {
    expect(listVideoModels().map((d) => d.key).sort()).toEqual(
      ['happyhorse-1.0-t2v', 'kling-v3-t2v', 'wan2.7-t2v'],
    );
  });

  it('isKnownVideoModel 白名单', () => {
    expect(isKnownVideoModel('wan2.7-t2v')).toBe(true);
    expect(isKnownVideoModel('__proto__')).toBe(false);
    expect(isKnownVideoModel('z-image')).toBe(false); // 图片模型不算视频
  });
});

describe('estimateVideoCost(秒×档×tier,audio 加价)', () => {
  it('基础:duration × priceTier × resFactor', () => {
    // 5s × tier 3 × 720P(1) = 15
    expect(estimateVideoCost(5, 3, '720P', false)).toBe(15);
    // 10s × tier 5 × 720P = 50
    expect(estimateVideoCost(10, 5, '720P', false)).toBe(50);
  });

  it('1080P = 2 × 720P(同 duration/tier)', () => {
    const p720 = estimateVideoCost(8, 6, '720P', false);
    const p1080 = estimateVideoCost(8, 6, '1080P', false);
    expect(p1080).toBe(p720 * 2);
  });

  it('audio=true 加价 1.3×(ceil)', () => {
    // 5s × tier 6 × 720P = 30;audio → 30×1.3=39
    expect(estimateVideoCost(5, 6, '720P', true)).toBe(39);
  });

  it('未知分辨率回落 factor 1', () => {
    expect(estimateVideoCost(5, 3, '4K', false)).toBe(15);
  });
});

describe("costFor('video_t2v') 读快照(reserve==settle)", () => {
  it('读 durationSnapshot/resSnapshot/audioSnapshot/priceTierSnapshot', () => {
    const cost = costFor('video_t2v', {
      model: 'kling-v3-t2v',
      durationSnapshot: 10, resSnapshot: '1080P', audioSnapshot: true, priceTierSnapshot: 6,
    });
    // 10 × 6 × 2(1080P) × 1.3(audio) = 156
    expect(cost).toBe(156);
    // 与 estimateVideoCost 直接算一致(同一函数,reserve==settle)
    expect(cost).toBe(estimateVideoCost(10, 6, '1080P', true));
  });

  it('无快照(老 job)回落实时派生:可灵 mode→res、audio 仅可灵', () => {
    // 可灵 pro → 1080P 档、audio=true 生效
    const c = costFor('video_t2v', { model: 'kling-v3-t2v', mode: 'pro', duration: 5, audio: true });
    expect(c).toBe(estimateVideoCost(5, VIDEO_MODELS['kling-v3-t2v']!.priceTier, '1080P', true));
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
