// 灵镜 在线支付 — 商户配置(决策3/7/14/17/26):加密落库/掩码回显/降级链/admin API。

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-payments';
process.env.PUBLIC_BASE_URL = 'https://pay-test.example.com';

const { db } = await import('../src/db/index.js');
const {
  saveChannelSetting, channelSettingForAdmin, getProvider, availableScenes,
  anyOnlineChannelAvailable, setProviderForTest, publicBaseUrl,
} = await import('../src/payments/index.js');

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

afterEach(() => {
  setProviderForTest('wechat', null);
  setProviderForTest('alipay', null);
  process.env.MASTER_KEY = 'test-master-key-for-payments';
  process.env.PUBLIC_BASE_URL = 'https://pay-test.example.com';
});

describe('配置保存与回显', () => {
  it('完整微信配置:加密落库,DB 无明文,provider 可构建', () => {
    saveChannelSetting('wechat', {
      enabledScenes: ['native', 'h5'],
      config: { appid: 'wx_app', mchid: '190001', merchantSerial: 'SER01', publicKeyId: 'PUB_KEY_ID_1', publicKeyPem: PUB },
      secrets: { apiV3Key: 'k'.repeat(32), privateKeyPem: PRIV },
    });
    const row = db.prepare(`SELECT * FROM payment_channel_setting WHERE channel='wechat'`).get() as any;
    expect(row.secret_cipher).toBeInstanceOf(Buffer);
    expect(row.secret_cipher.toString('utf8')).not.toContain('PRIVATE KEY'); // 密文,无明文私钥
    expect(row.config_json).not.toContain('PRIVATE KEY'); // 非敏感区也无私钥
    const view = channelSettingForAdmin('wechat');
    expect(view.secretsConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('PRIVATE KEY'); // 回显永不带明文密钥
    expect(getProvider('wechat')).toBeTruthy();
    expect(availableScenes('wechat')).toEqual(['native', 'h5']);
    expect(anyOnlineChannelAvailable()).toBe(true);
  });
  it('编辑保存省略 secrets → 保留原密钥(表单不回传)', () => {
    // 自包含:先自己写一次密钥,不依赖上一个用例的残留(否则 it.only / shuffle 就挂)
    saveChannelSetting('wechat', {
      enabledScenes: ['native'],
      config: { appid: 'wx_app', mchid: '190001', merchantSerial: 'SER01', publicKeyId: 'PUB_KEY_ID_1', publicKeyPem: PUB },
      secrets: { apiV3Key: 'k'.repeat(32), privateKeyPem: PRIV },
    });
    saveChannelSetting('wechat', {
      enabledScenes: ['native'],
      config: { appid: 'wx_app2', mchid: '190001', merchantSerial: 'SER01', publicKeyId: 'PUB_KEY_ID_1', publicKeyPem: PUB },
    });
    expect(channelSettingForAdmin('wechat').secretsConfigured).toBe(true); // 原密钥仍在
    expect(channelSettingForAdmin('wechat').config.appid).toBe('wx_app2');
    expect(getProvider('wechat')).toBeTruthy();
  });
  it('坏私钥 PEM 保存时即拒(不留到首次支付暴雷)', () => {
    expect(() =>
      saveChannelSetting('alipay', {
        enabledScenes: ['page'],
        config: { appId: 'ali1', alipayPublicKeyPem: PUB },
        secrets: { privateKeyPem: 'not-a-pem' },
      }),
    ).toThrow(/PEM/);
  });
  it('微信缺 APIv3 密钥 → 保存拒', () => {
    expect(() =>
      saveChannelSetting('wechat', {
        enabledScenes: ['native'],
        config: {},
        secrets: { privateKeyPem: PRIV },
      }),
    ).toThrow(/APIv3/);
  });
});

describe('降级链(决策7/17/26)', () => {
  it('场景开关:关 h5 只剩 native(H5 审批未过的部署形态)', () => {
    saveChannelSetting('wechat', {
      enabledScenes: ['native'],
      config: { appid: 'wx_app', mchid: '190001', merchantSerial: 'SER01', publicKeyId: 'PUB_KEY_ID_1', publicKeyPem: PUB },
      secrets: { apiV3Key: 'k'.repeat(32), privateKeyPem: PRIV },
    });
    expect(availableScenes('wechat')).toEqual(['native']);
  });
  it('PUBLIC_BASE_URL 未配 → 全通道占位(决策26)', () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(publicBaseUrl()).toBe(null);
    expect(availableScenes('wechat')).toEqual([]);
    expect(anyOnlineChannelAvailable()).toBe(false);
  });
  it('MASTER_KEY 变更(密文解不开)→ provider 降级 null 不崩(决策17)', () => {
    saveChannelSetting('alipay', {
      enabledScenes: ['page'],
      config: { appId: 'ali1', alipayPublicKeyPem: PUB },
      secrets: { privateKeyPem: PRIV },
    });
    expect(getProvider('alipay')).toBeTruthy();
    process.env.MASTER_KEY = 'rotated-away'; // 密文与主密钥不再匹配
    // 缓存按 updated_at 失效:触发一次配置更新使缓存失效
    db.prepare(`UPDATE payment_channel_setting SET updated_at=updated_at+1 WHERE channel='alipay'`).run();
    expect(getProvider('alipay')).toBe(null);
    expect(availableScenes('alipay')).toEqual([]);
  });
  it('MASTER_KEY 缺失时保存密钥 → 拒并提示', () => {
    delete process.env.MASTER_KEY;
    expect(() =>
      saveChannelSetting('wechat', {
        enabledScenes: ['native'],
        config: {},
        secrets: { apiV3Key: 'k'.repeat(32), privateKeyPem: PRIV },
      }),
    ).toThrow(/MASTER_KEY/);
  });
});
