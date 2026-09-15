import { afterEach, describe, expect, it, vi } from 'vitest';

const timeoutKeys = ['IMAGE_TIMEOUT_MS', 'VIDEO_TIMEOUT_MS', 'OSS_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'VIDEO_T2V_TIMEOUT_MS'];

async function readConfig(values: Record<string, string> = {}) {
  vi.resetModules();
  // 显式空值防止开发者 .env 影响默认配置断言。
  for (const key of timeoutKeys) vi.stubEnv(key, values[key] ?? '');
  return (await import('../src/config.js')).config;
}

afterEach(() => vi.unstubAllEnvs());

describe('生成与存储超时配置', () => {
  it('默认图片 15 分钟、所有视频 30 分钟、OSS 30 分钟', async () => {
    const config = await readConfig();
    expect(config.baichuan.imageTimeoutMs).toBe(15 * 60_000);
    expect(config.baichuan.videoTimeoutMs).toBe(30 * 60_000);
    expect(config.oss.timeoutMs).toBe(30 * 60_000);
  });

  it('独立配置优先于旧配置,互不串用', async () => {
    const config = await readConfig({ IMAGE_TIMEOUT_MS: '910000', VIDEO_TIMEOUT_MS: '1810000', OSS_TIMEOUT_MS: '1200000', POLL_TIMEOUT_MS: '600000', VIDEO_T2V_TIMEOUT_MS: '900000' });
    expect(config.baichuan.imageTimeoutMs).toBe(910000);
    expect(config.baichuan.videoTimeoutMs).toBe(1810000);
    expect(config.oss.timeoutMs).toBe(1200000);
    expect(config.baichuan.jobTimeoutMs).toBe(600000);
  });

  it('兼容旧图片/视频环境变量', async () => {
    const config = await readConfig({ POLL_TIMEOUT_MS: '700000', VIDEO_T2V_TIMEOUT_MS: '1100000' });
    expect(config.baichuan.imageTimeoutMs).toBe(700000);
    expect(config.baichuan.videoTimeoutMs).toBe(1100000);
  });
});
