// 测试用 HTTP 助手 — 启动 app、保持 cookie(支持登录后复用 session)。
// 不引 supertest,直接用 node:http,少一个依赖。
//
// 并发隔离(2026-06-25):早期实现每个请求都 app.listen(0) + server.close(),
// 全套 727 用例 × 每例多次请求 = 上千次临时端口 listen/close。并行 16 个 fork 跑时
// 临时端口压力下偶发 listen/connect 失败(ECONNRESET / 端口竞争)→ 链路中某请求挂掉 →
// 级联成随机用例的 401 / 断言失败(每轮换一个用例,典型资源竞争 flake)。
// 改为「每个 app 复用一个常驻 server」:整文件只 listen 一次,所有请求复用该端口,从不 close;
// server.unref() 保证进程仍能正常退出。端口 churn 从上千降到 1 → flake 消失。

import http from 'node:http';
import type { Server } from 'node:http';
import type { Express } from 'express';

export interface Res {
  status: number;
  body: any;
  setCookie?: string;
  headers?: http.IncomingHttpHeaders;
}

export interface RawRes {
  status: number;
  headers: http.IncomingHttpHeaders;
  buf: Buffer;
}

// 每个 app 一个常驻监听 server(listen 一次,所有 Client / 请求复用)。
// unref:不阻塞进程退出;从不 close:省掉每请求的 listen/close 端口 churn(flake 根因)。
const _servers = new WeakMap<Express, Promise<number>>();
function portFor(app: Express): Promise<number> {
  let p = _servers.get(app);
  if (!p) {
    p = new Promise<number>((resolve, reject) => {
      const server: Server = app.listen(0, () => resolve((server.address() as any).port));
      server.once('error', reject);
      server.unref();
    });
    _servers.set(app, p);
  }
  return p;
}

export class Client {
  private cookie: string | undefined;
  constructor(private app: Express) {}

  private async request(method: string, path: string, body?: unknown): Promise<Res> {
    const port = await portFor(this.app);
    return new Promise((resolveP, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {};
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(data));
      }
      if (this.cookie) headers['Cookie'] = this.cookie;

      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          const sc = res.headers['set-cookie']?.[0];
          // 保存 session cookie(取 name=value 部分)供后续请求复用
          if (sc) {
            const nv = sc.split(';')[0]!;
            this.cookie = nv;
          }
          let json: any;
          try {
            json = JSON.parse(buf);
          } catch {
            json = buf;
          }
          resolveP({ status: res.statusCode!, body: json, setCookie: sc, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /** multipart/form-data 上传:fields 普通字段,files 文件(name → {filename, content, type})。 */
  async postMultipart(
    path: string,
    fields: Record<string, string>,
    files: Record<string, { filename: string; content: Buffer; type: string }>,
  ): Promise<Res> {
    const port = await portFor(this.app);
    return new Promise((resolveP, reject) => {
      const boundary = '----ljtest' + Math.random().toString(36).slice(2);
      const parts: Buffer[] = [];
      for (const [k, v] of Object.entries(fields)) {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
          ),
        );
      }
      for (const [k, f] of Object.entries(files)) {
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`,
          ),
        );
        parts.push(f.content);
        parts.push(Buffer.from('\r\n'));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const headers: Record<string, string> = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      };
      if (this.cookie) headers['Cookie'] = this.cookie;
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json: any;
          try { json = JSON.parse(buf); } catch { json = buf; }
          resolveP({ status: res.statusCode!, body: json });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** 测试登录助手:自动走滑块(challenge → verify 拿 token)再 POST /login。
   *  防暴破上线后 /login 必携 captcha_token,测试登录统一走这里,免每处手动过滑块。
   *  loginPath 默认租户登录 /api/login;超管登录传 /admin/login。 */
  async login(username: string, password: string, loginPath = '/api/login'): Promise<Res> {
    const ch = await this.request('GET', '/api/captcha/challenge');
    // 拖到底式:提交末端 x(trackW),服务端按"到末端"判过(测试不模拟真人拖拽)
    const v = await this.request('POST', '/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW });
    return this.request('POST', loginPath, { username, password, captchaToken: v.body.captchaToken });
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown) {
    return this.request('POST', path, body);
  }
  put(path: string, body?: unknown) {
    return this.request('PUT', path, body);
  }
  del(path: string) {
    return this.request('DELETE', path);
  }
  /** 原始 GET:拿 status + headers + 二进制 body(下载端点测 Content-Disposition / 字节)。 */
  async getRaw(path: string): Promise<RawRes> {
    const port = await portFor(this.app);
    return new Promise((resolveP, reject) => {
      const headers: Record<string, string> = {};
      if (this.cookie) headers['Cookie'] = this.cookie;
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          resolveP({ status: res.statusCode!, headers: res.headers, buf: Buffer.concat(chunks) });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
  /** 丢弃当前 cookie(模拟未登录 / 新客户端)。 */
  clearCookie() {
    this.cookie = undefined;
  }
}
