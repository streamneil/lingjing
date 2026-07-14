// 灵镜 在线支付 — 通道注册表 + 商户配置(设计:docs/designs/online-payments.md)。
//
// ┌─ 配置/降级链(决策3/7/17/26)────────────────────────────────────────────────┐
// │ payment_channel_setting(超管后台填)                                          │
// │   ├─ 非敏感 config_json(appid/mchid/公钥…)明文                               │
// │   └─ 敏感包(APIv3密钥/商户私钥/应用私钥)JSON → key-crypto AES-256-GCM,      │
// │      AAD='payment:'+channel,复用 MASTER_KEY(不新增主密钥 ENV)               │
// │ getProvider(channel):                                                          │
// │   未配置 / enabled_scenes 空 / MASTER_KEY 缺失或解密失败 / PUBLIC_BASE_URL 未配 │
// │   → null → 收银台该通道「敬请期待」占位;绝不抛错崩进程                        │
// └───────────────────────────────────────────────────────────────────────────────┘
// 测试注入:setProviderForTest(镜 image-models 注册表范式,fake provider 全隔离零外呼)。

import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import {
  db,
  type PaymentChannel,
  type PaymentChannelSettingRow,
  type PaymentScene,
  type ReconDiffKind,
} from '../db/index.js';
import { encryptKey, decryptKey, masterKey } from '../gateway/key-crypto.js';
import { WechatProvider, type WechatConfig } from './wechat.js';
import { AlipayProvider, type AlipayConfig } from './alipay.js';
import { PaymentError, type PaymentProvider } from './types.js';

export { yuanToFen, fenToYuan } from './money.js';
export * from './types.js';

export const CHANNELS: PaymentChannel[] = ['wechat', 'alipay'];
/** 每通道合法场景(微信:PC 扫码 native + 手机浏览器 h5;支付宝:电脑网站 page + 手机网站 wap)。 */
export const CHANNEL_SCENES: Record<PaymentChannel, PaymentScene[]> = {
  wechat: ['native', 'h5'],
  alipay: ['page', 'wap'],
};

// ── 公网基址(决策26):回调/返回 URL 的来源。未配置 → 在线通道整体占位。 ──
export function publicBaseUrl(): string | null {
  const raw = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (!/^https?:\/\//.test(raw)) return null;
  return raw;
}

export function notifyUrl(channel: PaymentChannel): string {
  const base = publicBaseUrl();
  // 显式护栏:退款路径不经 availableScenes 检查,基址被清空后会拼出 'null/api/...' 发给通道,
  // 换回一个看不懂的 PARAM_ERROR。这里当场给出可执行错误。
  if (!base) throw new PaymentError('BASE_URL_MISSING', 'PUBLIC_BASE_URL 未配置,无法生成支付回调地址');
  return `${base}/api/payments/notify/${channel}`;
}

// ── 配置存取 ──

function getSettingRow(channel: PaymentChannel): PaymentChannelSettingRow | undefined {
  return db.prepare(`SELECT * FROM payment_channel_setting WHERE channel=?`).get(channel) as
    | PaymentChannelSettingRow
    | undefined;
}

function parseScenes(row: PaymentChannelSettingRow | undefined, channel: PaymentChannel): PaymentScene[] {
  if (!row) return [];
  try {
    const arr = JSON.parse(row.enabled_scenes) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is PaymentScene => CHANNEL_SCENES[channel].includes(s as PaymentScene));
  } catch {
    return [];
  }
}

const SECRET_AAD = (channel: PaymentChannel) => `payment:${channel}`;

/** 解密敏感包(JSON)。未配置/无主密钥/GCM 认证失败 → null(降级占位,决策17)。 */
function decryptSecrets(row: PaymentChannelSettingRow): Record<string, string> | null {
  if (!row.secret_cipher || !row.secret_iv || !row.secret_tag) return null;
  try {
    const plain = decryptKey(
      {
        cipher: row.secret_cipher,
        iv: row.secret_iv,
        tag: row.secret_tag,
        keyVersion: row.secret_key_version ?? 1,
      },
      SECRET_AAD(row.channel),
    );
    return JSON.parse(plain) as Record<string, string>;
  } catch (e) {
    console.error(
      `[支付] ${row.channel} 商户密钥解密失败(MASTER_KEY 缺失/变更?)→ 通道降级占位:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export interface ChannelSettingInput {
  enabledScenes: PaymentScene[];
  config: Record<string, string>; // 非敏感
  secrets?: Record<string, string>; // 敏感;省略 = 保留原值(编辑表单不回传密钥)
}

/** 保存通道配置(超管后台)。保存时即校验私钥可解析,坏 PEM 当场拒(而非首次支付才暴雷)。 */
export function saveChannelSetting(channel: PaymentChannel, input: ChannelSettingInput): void {
  const scenes = input.enabledScenes.filter((s) => CHANNEL_SCENES[channel].includes(s));
  const existing = getSettingRow(channel);

  let cipherCols: {
    cipher: Buffer | null;
    iv: Buffer | null;
    tag: Buffer | null;
    version: number | null;
  };
  if (input.secrets && Object.keys(input.secrets).length > 0) {
    if (!masterKey()) throw new Error('MASTER_KEY 未配置,无法保存商户密钥(见 .env.example)');
    validateSecrets(channel, input.secrets);
    const bundle = encryptKey(JSON.stringify(input.secrets), SECRET_AAD(channel));
    cipherCols = { cipher: bundle.cipher, iv: bundle.iv, tag: bundle.tag, version: bundle.keyVersion };
  } else {
    cipherCols = {
      cipher: existing?.secret_cipher ?? null,
      iv: existing?.secret_iv ?? null,
      tag: existing?.secret_tag ?? null,
      version: existing?.secret_key_version ?? null,
    };
  }

  db.prepare(
    `INSERT INTO payment_channel_setting
       (channel, enabled_scenes, config_json, secret_cipher, secret_iv, secret_tag, secret_key_version, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(channel) DO UPDATE SET enabled_scenes=excluded.enabled_scenes,
       config_json=excluded.config_json, secret_cipher=excluded.secret_cipher,
       secret_iv=excluded.secret_iv, secret_tag=excluded.secret_tag,
       secret_key_version=excluded.secret_key_version, updated_at=excluded.updated_at`,
  ).run(
    channel,
    JSON.stringify(scenes),
    JSON.stringify(input.config ?? {}),
    cipherCols.cipher,
    cipherCols.iv,
    cipherCols.tag,
    cipherCols.version,
    Date.now(),
  );
  cache.delete(channel); // 配置变更即失效缓存
}

/** 保存时校验:私钥 PEM 可解析、支付宝公钥可解析 —— 坏配置当场 4xx,不留到首次支付。 */
function validateSecrets(channel: PaymentChannel, secrets: Record<string, string>): void {
  const pk = secrets.privateKeyPem;
  if (!pk?.trim()) throw new Error('缺少商户私钥(privateKeyPem)');
  try {
    createPrivateKey(pk);
  } catch {
    throw new Error('商户私钥 PEM 无法解析,请检查格式(-----BEGIN PRIVATE KEY-----)');
  }
  if (channel === 'wechat' && !secrets.apiV3Key?.trim()) throw new Error('缺少微信 APIv3 密钥');
}

/** 超管回显(密钥永不回读明文,只报已配置;镜 provider key last4 范式)。 */
export function channelSettingForAdmin(channel: PaymentChannel): {
  channel: PaymentChannel;
  enabledScenes: PaymentScene[];
  config: Record<string, string>;
  secretsConfigured: boolean;
  updatedAt: number | null;
} {
  const row = getSettingRow(channel);
  let config: Record<string, string> = {};
  try {
    config = row ? (JSON.parse(row.config_json) as Record<string, string>) : {};
  } catch {
    config = {};
  }
  return {
    channel,
    enabledScenes: parseScenes(row, channel),
    config,
    secretsConfigured: !!row?.secret_cipher,
    updatedAt: row?.updated_at ?? null,
  };
}

// ── Provider 构建 + 缓存(按 updated_at 失效)+ 测试注入 ──

const cache = new Map<PaymentChannel, { at: number | null; provider: PaymentProvider | null }>();
const testOverride = new Map<PaymentChannel, PaymentProvider | null>();

export function setProviderForTest(channel: PaymentChannel, p: PaymentProvider | null): void {
  if (p === null) testOverride.delete(channel);
  else testOverride.set(channel, p);
  cache.delete(channel);
}

function buildProvider(channel: PaymentChannel): PaymentProvider | null {
  const row = getSettingRow(channel);
  if (!row) return null;
  const secrets = decryptSecrets(row);
  if (!secrets) return null;
  let cfg: Record<string, string>;
  try {
    cfg = JSON.parse(row.config_json) as Record<string, string>;
  } catch {
    return null;
  }
  try {
    if (channel === 'wechat') {
      const c: WechatConfig = {
        appid: cfg.appid ?? '',
        mchid: cfg.mchid ?? '',
        merchantSerial: cfg.merchantSerial ?? '',
        publicKeyId: cfg.publicKeyId ?? '',
        publicKeyPem: cfg.publicKeyPem ?? '',
        apiV3Key: secrets.apiV3Key ?? '',
        privateKeyPem: secrets.privateKeyPem ?? '',
      };
      if (!c.appid || !c.mchid || !c.merchantSerial || !c.publicKeyId || !c.publicKeyPem) return null;
      createPublicKey(c.publicKeyPem); // 坏公钥当场暴露 → catch 降级
      return new WechatProvider(c);
    }
    const c: AlipayConfig = {
      appId: cfg.appId ?? '',
      alipayPublicKeyPem: cfg.alipayPublicKeyPem ?? '',
      gateway: cfg.gateway || 'https://openapi.alipay.com/gateway.do',
      privateKeyPem: secrets.privateKeyPem ?? '',
    };
    if (!c.appId || !c.alipayPublicKeyPem) return null;
    createPublicKey(c.alipayPublicKeyPem);
    return new AlipayProvider(c);
  } catch (e) {
    console.error(`[支付] ${channel} 配置无法构建通道(公钥/私钥格式?)→ 占位:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 取通道实现。未配置/降级 → null(调用方按「未开通」处理)。 */
export function getProvider(channel: PaymentChannel): PaymentProvider | null {
  if (testOverride.has(channel)) return testOverride.get(channel)!;
  const row = getSettingRow(channel);
  const at = row?.updated_at ?? null;
  const hit = cache.get(channel);
  if (hit && hit.at === at) return hit.provider;
  const provider = buildProvider(channel);
  cache.set(channel, { at, provider });
  return provider;
}

/** 收银台可用场景 = 已启用 ∩ provider 可构建 ∩ PUBLIC_BASE_URL 已配(决策7/26)。
 *  测试注入 override 时视为「全部启用场景可用」(fake provider 不依赖配置行)。 */
export function availableScenes(channel: PaymentChannel): PaymentScene[] {
  if (!publicBaseUrl()) return [];
  if (testOverride.has(channel)) {
    const row = getSettingRow(channel);
    const scenes = parseScenes(row, channel);
    return scenes.length ? scenes : CHANNEL_SCENES[channel];
  }
  if (!getProvider(channel)) return [];
  return parseScenes(getSettingRow(channel), channel);
}

/** 任一在线通道可用?(建单守卫「至少一种可付方式」的一半,决策6) */
export function anyOnlineChannelAvailable(): boolean {
  return CHANNELS.some((c) => availableScenes(c).length > 0);
}

// ── 对账差异记录(零静默失败落点;orders 实时差异 + recon 账单差异共用)──
// INSERT OR IGNORE + 唯一索引(channel,out_trade_no,txn_id,kind):微信重试/对账重跑不刷屏(决策25)。
// billDate='-' 表示实时差异(回调/查单发现),非账单来源。
export function recordReconDiff(p: {
  channel: PaymentChannel;
  kind: ReconDiffKind;
  outTradeNo?: string | null;
  txnId?: string | null;
  detail: Record<string, unknown>;
  billDate?: string;
}): void {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO recon_diff (id, bill_date, channel, kind, out_trade_no, txn_id, detail_json, resolved, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
    )
    .run(
      randomUUID(),
      p.billDate ?? '-',
      p.channel,
      p.kind,
      p.outTradeNo ?? null,
      p.txnId ?? null,
      JSON.stringify(p.detail),
      Date.now(),
    );
  if (res.changes === 1) {
    // error 级:可被日志监控拾取(v1 告警面 = 差异面板 + 此日志,设计定稿)。
    console.error(
      `[支付][对账差异] channel=${p.channel} kind=${p.kind} out_trade_no=${p.outTradeNo ?? '-'} txn=${p.txnId ?? '-'} detail=${JSON.stringify(p.detail)}`,
    );
  }
}
