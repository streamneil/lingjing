// 灵镜 存储层 — 双后端:阿里云 OSS(公网可达,生产用)或 MinIO(本地/私有化)。
//
// 决策(2026-06 查证):wan2.2-s2v 必须能从公网下载素材(图片/音频)URL。
// 本地 MinIO 是 127.0.0.1,百炼云端访问不到 → 生成任务卡 pending 直到超时。
// 因此配了 OSS(region+bucket+AccessKey)就走 OSS(签名 URL 公网可达);
// 否则回退 MinIO(本地开发/私有化内网,但需自行保证百炼可达)。
//
// 两后端实现同一组函数(putObject/putObjectFromUrl/getSignedUrl/getObject/ensureBucket),
// 上层(worker/api)无感知。

import { Client as MinioClient } from 'minio';
import OSS from 'ali-oss';
import { config } from '../config.js';

// ── 后端接口 ──
interface StorageBackend {
  ensureBucket(): Promise<void>;
  putObject(key: string, data: Buffer | string, contentType?: string): Promise<string>;
  putObjectFromUrl(key: string, url: string): Promise<string>;
  getSignedUrl(key: string, expirySeconds?: number): Promise<string>;
  getObject(key: string): Promise<Buffer>;
}

// ── MinIO 后端(本地 / 私有化)──
function makeMinioBackend(): StorageBackend {
  const client = new MinioClient({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
  const BUCKET = config.minio.bucket;
  let ensured = false;
  return {
    async ensureBucket() {
      if (ensured) return;
      const exists = await client.bucketExists(BUCKET).catch(() => false);
      if (!exists) await client.makeBucket(BUCKET);
      ensured = true;
    },
    async putObject(key, data, contentType = 'application/octet-stream') {
      await this.ensureBucket();
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': contentType });
      return key;
    },
    async putObjectFromUrl(key, url) {
      await this.ensureBucket();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`抓取远程对象失败 ${res.status}: ${url}`);
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const buf = Buffer.from(await res.arrayBuffer());
      await client.putObject(BUCKET, key, buf, buf.length, { 'Content-Type': contentType });
      return key;
    },
    async getSignedUrl(key, expirySeconds = 3600) {
      await this.ensureBucket();
      return client.presignedGetObject(BUCKET, key, expirySeconds);
    },
    async getObject(key) {
      await this.ensureBucket();
      const stream = await client.getObject(BUCKET, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    },
  };
}

// ── OSS 后端(阿里云,公网可达;与百炼同生态)──
function makeOssBackend(): StorageBackend {
  // 懒初始化:OSS 配置错误(如 region 不合规)不应让整个服务启动即崩 + 白屏。
  // 改为首次用到时才建客户端,出错只让该次存储操作失败(任务标 failed),Web 仍可访问。
  let client: OSS | null = null;
  const getClient = (): OSS => {
    if (!client) {
      client = new OSS({
        region: config.oss.region,
        bucket: config.oss.bucket,
        accessKeyId: config.oss.accessKeyId,
        accessKeySecret: config.oss.accessKeySecret,
        secure: true,
      });
    }
    return client;
  };
  return {
    // OSS bucket 由用户在控制台预建;此处不自动建桶(避免越权/区域错配)。
    async ensureBucket() {
      /* no-op:OSS bucket 预建 */
    },
    async putObject(key, data, contentType = 'application/octet-stream') {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      await getClient().put(key, buf, { mime: contentType });
      return key;
    },
    async putObjectFromUrl(key, url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`抓取远程对象失败 ${res.status}: ${url}`);
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const buf = Buffer.from(await res.arrayBuffer());
      await getClient().put(key, buf, { mime: contentType });
      return key;
    },
    async getSignedUrl(key, expirySeconds = 3600) {
      // OSS 签名 URL:公网可达,带过期。百炼能直接下载。
      return getClient().signatureUrl(key, { expires: expirySeconds });
    },
    async getObject(key) {
      const r = await getClient().get(key);
      return Buffer.isBuffer(r.content) ? r.content : Buffer.from(r.content);
    },
  };
}

// ── 后端选择:配了 OSS 用 OSS,否则 MinIO ──
const backend: StorageBackend = config.oss.enabled ? makeOssBackend() : makeMinioBackend();

export const storageBackendName = config.oss.enabled ? 'oss' : 'minio';

export const ensureBucket = () => backend.ensureBucket();
export const putObject = (key: string, data: Buffer | string, contentType?: string) =>
  backend.putObject(key, data, contentType);
export const putObjectFromUrl = (key: string, url: string) => backend.putObjectFromUrl(key, url);
export const getSignedUrl = (key: string, expirySeconds?: number) =>
  backend.getSignedUrl(key, expirySeconds);
export const getObject = (key: string) => backend.getObject(key);

export const storage = { putObject, putObjectFromUrl, getSignedUrl, getObject, ensureBucket };
