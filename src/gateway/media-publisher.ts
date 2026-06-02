// 灵镜 — 媒体发布策略(解决 wan2.2-s2v 要求素材公网可访问的问题)。
//
// 背景(查证发现,见 TODOS T-PUBLIC-URL):wan2.2-s2v 的 image_url/audio_url 必须
// 公网可访问。托管模式 MinIO 在公网,签名 URL 直接可用;私有化模式素材在客户内网,
// 百炼云端访问不到 —— 这会卡住护城河(私有化交付)。
//
// 这里把"如何让百炼拿到一个可访问的素材 URL"抽象成可切换策略:
//   - hosted:  MinIO 签名 URL(已公网可达)直接返回。
//   - private: 需把素材中转到百炼可达处(DashScope 上传接口 / 客户出网白名单代理)。
//              本期给出接口与默认实现(直接用签名 URL),私有化交付时按客户网络替换。
//
// 决策来源:/plan-eng-review 能力网关抽象 + T-PUBLIC-URL。

import { getSignedUrl } from '../storage/index.js';
import { db } from '../db/index.js';

export interface MediaPublisher {
  /** 把一个 MinIO object key 转成"百炼可访问"的 URL。 */
  publish(objectKey: string): Promise<string>;
}

/** 托管模式:MinIO 签名 URL 已公网可达,直接用。 */
class HostedPublisher implements MediaPublisher {
  async publish(objectKey: string): Promise<string> {
    return getSignedUrl(objectKey);
  }
}

/**
 * 私有化模式:素材在客户内网,百炼访问不到。
 * 落地方案(交付时按客户网络三选一,见 DEPLOY-PRIVATE.md):
 *   A. 客户侧给 MinIO 配一个"仅出网到百炼"的反代/白名单,签名 URL 即可达 → 退化成 Hosted。
 *   B. 把素材临时上传到 DashScope 的文件接口,用其返回的临时 URL。
 *   C. 客户提供一个临时公网中转桶(OSS),素材推过去再给 URL。
 * 默认实现先用签名 URL(等价方案 A 已配好的情形);未配好时由部署文档指引。
 */
class PrivatePublisher implements MediaPublisher {
  async publish(objectKey: string): Promise<string> {
    // TODO(私有化交付): 按客户网络接入方案 B/C。默认假设方案 A(MinIO 出网已放通)。
    return getSignedUrl(objectKey);
  }
}

/** 按租户交付模式返回发布策略(护城河:一套代码两种交付)。 */
export function getMediaPublisher(delivery: 'hosted' | 'private' = 'hosted'): MediaPublisher {
  return delivery === 'private' ? new PrivatePublisher() : new HostedPublisher();
}

/** 读租户交付模式(tenant_setting 优先,其次 tenant.delivery,默认 hosted)。 */
export function tenantDelivery(tenantId: string): 'hosted' | 'private' {
  const row = db
    .prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key='delivery'`)
    .get(tenantId) as { value: string } | undefined;
  if (row?.value) return row.value === 'private' ? 'private' : 'hosted';
  const t = db.prepare(`SELECT delivery FROM tenant WHERE id=?`).get(tenantId) as
    | { delivery: string }
    | undefined;
  return t?.delivery === 'private' ? 'private' : 'hosted';
}
