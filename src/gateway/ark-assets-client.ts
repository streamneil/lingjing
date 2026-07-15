// 灵镜 — 火山方舟 私域素材库 签名客户端(AK/SK,顶层 OpenAPI)。
//
// 与 ark.ts 的区别:ark.ts 用 Bearer key 调 ark.cn-beijing.volces.com/api/v3(模型生成);
// 本文件用 AK/SK 签名调 open.volcengineapi.com(素材资产管理)。两套鉴权、两个端点,互不相干。
// 文档:https://www.volcengine.com/docs/82379/2333565
//
// 火山顶层响应形如 { ResponseMetadata: {..., Error?}, Result: {...} };本文件统一解包 Result,
// 错误抛出(调用方 resolveImageToAsset 捕获后回退原图 URL,绝不炸 job)。

import { Signer } from '@volcengine/openapi';
import { config } from '../config.js';

const HOST = 'open.volcengineapi.com';
const SERVICE = 'ark';
const REGION = 'cn-beijing';
const VERSION = '2024-01-01';

export interface ArkAssetInfo {
  id: string;
  status: 'Processing' | 'Active' | 'Failed';
  url?: string;
}

interface ArkRequestData {
  region: string;
  method: string;
  params: Record<string, string>;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}

/** 签名并 POST 一个火山素材库 Action;返回解包后的 Result。失败抛错。 */
export async function signedArkCall<T = unknown>(action: string, version: string, body: unknown): Promise<T> {
  const { accessKeyId, secretAccessKey } = config.arkAssets;
  if (!accessKeyId || !secretAccessKey) throw new Error('ARK_ASSET_AK/SK 未配置');
  const bodyStr = JSON.stringify(body ?? {});
  const requestData: ArkRequestData = {
    region: REGION,
    method: 'POST',
    params: { Action: action, Version: version },
    pathname: '/',
    headers: { 'Content-Type': 'application/json', Host: HOST },
    body: bodyStr,
  };
  // Signer 就地往 requestData.headers 写 Authorization / X-Date / X-Content-Sha256 等签名头。
  const signer = new Signer(requestData, SERVICE);
  signer.addAuthorization({ accessKeyId, secretKey: secretAccessKey, sessionToken: '' });

  // 查询串按 key 排序,与 Signer 的 canonical query 对齐(否则签名不符 → 403)。
  const qs = Object.keys(requestData.params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(requestData.params[k]!)}`)
    .join('&');
  const res = await fetch(`https://${HOST}${requestData.pathname}?${qs}`, {
    method: 'POST',
    headers: requestData.headers,
    body: bodyStr,
  });
  const text = await res.text();
  let json: { ResponseMetadata?: { Error?: { Code?: string; Message?: string } }; Result?: T };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`火山素材库 ${action} 返回非 JSON HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const apiErr = json?.ResponseMetadata?.Error;
  if (!res.ok || apiErr) {
    throw new Error(`火山素材库 ${action} 失败 HTTP ${res.status}: ${apiErr?.Code ?? ''} ${apiErr?.Message ?? text.slice(0, 200)}`);
  }
  return json.Result as T;
}

/** 创建素材组,返回 group id。projectName 空则不传(落 default)。 */
export async function createAssetGroup(name: string, projectName: string): Promise<string> {
  const body: Record<string, unknown> = { Name: name, Description: name };
  if (projectName) body.ProjectName = projectName;
  const r = await signedArkCall<{ Id: string }>('CreateAssetGroup', VERSION, body);
  return r.Id;
}

/** 上传一张图片素材,返回 asset id(异步,需再 getAsset 轮询到 Active 才可用)。 */
export async function createAsset(groupId: string, url: string, projectName: string): Promise<string> {
  const body: Record<string, unknown> = { GroupId: groupId, URL: url, AssetType: 'Image' };
  if (projectName) body.ProjectName = projectName;
  const r = await signedArkCall<{ Id: string }>('CreateAsset', VERSION, body);
  return r.Id;
}

/** 查素材状态。 */
export async function getAsset(assetId: string, projectName: string): Promise<ArkAssetInfo> {
  const body: Record<string, unknown> = { Id: assetId };
  if (projectName) body.ProjectName = projectName;
  const r = await signedArkCall<{ Id: string; Status: string; URL?: string }>('GetAsset', VERSION, body);
  return { id: r.Id, status: r.Status as ArkAssetInfo['status'], url: r.URL };
}
