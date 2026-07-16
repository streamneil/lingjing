import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/gateway/ark-assets.js', () => ({
  resolveImageToAsset: vi.fn(async () => 'asset://asset-1'),
}));

import * as resolver from '../src/gateway/ark-assets.js';
import { config } from '../src/config.js';
import { isPrivacyBlockError, shouldAssetRetry, assetifyImageRefs } from '../src/queue/worker.js';

// config 是 `as const`(类型只读),运行时仍是普通可变对象 → 测试经可变视图改配置。
const ark = config.arkAssets as unknown as { enabled: boolean; retryOnCodes: string[] };

const privacyErr = () => Object.assign(
  new Error('火山视频提交失败 HTTP 400: {"code":"InputImageSensitiveContentDetected.PrivacyInformation"}'),
  { arkCode: 'InputImageSensitiveContentDetected.PrivacyInformation' },
);

beforeEach(() => {
  vi.clearAllMocks();
  ark.enabled = true;
  ark.retryOnCodes = ['InputImageSensitiveContentDetected'];
});

describe('isPrivacyBlockError', () => {
  it('识别 arkCode 属性', () => {
    expect(isPrivacyBlockError(privacyErr())).toBe(true);
  });
  it('回退 message 子串识别(无 arkCode 也认)', () => {
    expect(isPrivacyBlockError(new Error('... InputImageSensitiveContentDetected.PrivacyInformation ...'))).toBe(true);
  });
  it('无关错误 → false', () => {
    expect(isPrivacyBlockError(new Error('厂商成功但未返回成品 URL'))).toBe(false);
  });
});

describe('shouldAssetRetry 门控', () => {
  it('开关关 → false', () => {
    ark.enabled = false;
    expect(shouldAssetRetry(privacyErr(), 'doubao-seedance-2.0', 1)).toBe(false);
  });
  it('非 Seedance → false', () => {
    expect(shouldAssetRetry(privacyErr(), 'wan2.7-i2v', 1)).toBe(false);
  });
  it('无参考图 → false', () => {
    expect(shouldAssetRetry(privacyErr(), 'doubao-seedance-2.0', 0)).toBe(false);
  });
  it('非拦截错误 → false', () => {
    expect(shouldAssetRetry(new Error('别的错'), 'doubao-seedance-2.0', 1)).toBe(false);
  });
  it('全条件满足 → true', () => {
    expect(shouldAssetRetry(privacyErr(), 'doubao-seedance-2.0', 1)).toBe(true);
  });
});

describe('assetifyImageRefs', () => {
  it('全部换成 asset://', async () => {
    const out = await assetifyImageRefs('t1', ['k1', 'k2'], ['https://oss/1.jpg', 'https://oss/2.jpg']);
    expect(out).toEqual(['asset://asset-1', 'asset://asset-1']);
    expect(resolver.resolveImageToAsset).toHaveBeenCalledTimes(2);
  });
  it('解析 null 的图回退原 URL', async () => {
    (resolver.resolveImageToAsset as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const out = await assetifyImageRefs('t1', ['k1', 'k2'], ['https://oss/1.jpg', 'https://oss/2.jpg']);
    expect(out).toEqual(['https://oss/1.jpg', 'asset://asset-1']);
  });
});
