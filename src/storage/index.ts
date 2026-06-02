// 灵镜 存储层 — MinIO(S3 兼容)。托管/私有化同构:同一套代码,
// 托管接云上 MinIO、私有化接客户内网 MinIO,docker-compose 内置。
//
// 决策来源:/plan-eng-review D3 —— 统一用 MinIO,不做 OSS/MinIO 双适配器,
// 因为 MinIO 兼容 S3 API,以后托管想换阿里 OSS 也只是改 endpoint 配置。

import { Client as MinioClient } from 'minio';
import { config } from '../config.js';

const client = new MinioClient({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

const BUCKET = config.minio.bucket;

let ensured = false;
/** 确保 bucket 存在(幂等)。首次写入前调用。 */
export async function ensureBucket(): Promise<void> {
  if (ensured) return;
  const exists = await client.bucketExists(BUCKET).catch(() => false);
  if (!exists) await client.makeBucket(BUCKET);
  ensured = true;
}

/** 上传一个对象(Buffer 或字符串),返回 object key。 */
export async function putObject(
  key: string,
  data: Buffer | string,
  contentType = 'application/octet-stream',
): Promise<string> {
  await ensureBucket();
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': contentType });
  return key;
}

/** 从一个外部 URL(如百炼返回的视频地址)抓取并落库,返回 object key。 */
export async function putObjectFromUrl(key: string, url: string): Promise<string> {
  await ensureBucket();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`抓取远程对象失败 ${res.status}: ${url}`);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const buf = Buffer.from(await res.arrayBuffer());
  await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': contentType });
  return key;
}

/** 生成临时签名 URL(默认 1 小时),供前端播放/下载,不暴露存储凭证。 */
export async function getSignedUrl(key: string, expirySeconds = 3600): Promise<string> {
  await ensureBucket();
  return client.presignedGetObject(BUCKET, key, expirySeconds);
}

/** 读取对象为 Buffer(测试 / 后处理用)。 */
export async function getObject(key: string): Promise<Buffer> {
  await ensureBucket();
  const stream = await client.getObject(BUCKET, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export const storage = { putObject, putObjectFromUrl, getSignedUrl, getObject, ensureBucket };
