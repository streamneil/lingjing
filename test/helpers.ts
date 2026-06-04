// 测试用 HTTP 助手 — 启动 app、保持 cookie(支持登录后复用 session)。
// 不引 supertest,直接用 node:http,少一个依赖。

import http from 'node:http';
import type { Express } from 'express';

export interface Res {
  status: number;
  body: any;
  setCookie?: string;
}

export class Client {
  private cookie: string | undefined;
  constructor(private app: Express) {}

  private request(method: string, path: string, body?: unknown): Promise<Res> {
    return new Promise((resolveP, reject) => {
      const server = this.app.listen(0, () => {
        const port = (server.address() as any).port;
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
            server.close();
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
            resolveP({ status: res.statusCode!, body: json, setCookie: sc });
          });
        });
        req.on('error', (e) => {
          server.close();
          reject(e);
        });
        if (data) req.write(data);
        req.end();
      });
    });
  }

  /** multipart/form-data 上传:fields 普通字段,files 文件(name → {filename, content, type})。 */
  postMultipart(
    path: string,
    fields: Record<string, string>,
    files: Record<string, { filename: string; content: Buffer; type: string }>,
  ): Promise<Res> {
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

      const server = this.app.listen(0, async () => {
        const port = (server.address() as any).port;
        const http = (await import('node:http')).default;
        const headers: Record<string, string> = {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        };
        if (this.cookie) headers['Cookie'] = this.cookie;
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            server.close();
            let json: any;
            try { json = JSON.parse(buf); } catch { json = buf; }
            resolveP({ status: res.statusCode!, body: json });
          });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(body);
        req.end();
      });
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
  /** 丢弃当前 cookie(模拟未登录 / 新客户端)。 */
  clearCookie() {
    this.cookie = undefined;
  }
}
