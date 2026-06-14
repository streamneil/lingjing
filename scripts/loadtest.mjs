// 灵镜 平台并发压测 —— 测平台自身(Express + better-sqlite3 同步单写)的承载上限。
//
// 设计来源:/qa「测试本平台到底能支持多大的并发,不考虑云AI平台的支持」。
//   故只压平台自身可控的路径:登录、鉴权读、纯 DB 写(sales-leads)、入队写(/jobs enqueue)。
//   worker 对百炼的真实调用是异步的、且被显式排除 —— 这里测的是「用户点下去到拿到响应」的延迟。
//
// 用法:
//   node scripts/loadtest.mjs                      # 默认全场景,并发档 1/5/10/25/50/100
//   node scripts/loadtest.mjs --base http://localhost:9372 --duration 6 --levels 1,10,50,200
//   node scripts/loadtest.mjs --scenario read      # 只跑某场景 read|write-lead|enqueue|login|mixed
//
// 不写库、不留数据副作用之外的状态;sales-leads/enqueue 会真实落行(压测后可清理)。

import http from 'node:http';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const BASE = args.base || 'http://localhost:9372';
const DURATION = Number(args.duration || 5); // 每档持续秒数
const LEVELS = (args.levels || '1,5,10,25,50,100').split(',').map(Number);
const ONLY = args.scenario || null;
const { hostname, port } = new URL(BASE);

// ---- 极简 HTTP 客户端(keep-alive,复用连接,贴近真实浏览器/反代)----
const agent = new http.Agent({ keepAlive: true, maxSockets: 1000 });
function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (cookie) headers['Cookie'] = cookie;
    const start = process.hrtime.bigint();
    const r = http.request({ hostname, port, path, method, headers, agent }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const sc = res.headers['set-cookie']?.[0]?.split(';')[0];
        resolve({ status: res.statusCode, ms, body: buf, setCookie: sc });
      });
    });
    r.on('error', (e) => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ status: 0, ms, error: e.code || e.message });
    });
    if (data) r.write(data);
    r.end();
  });
}

// ---- 登录:过滑块(提交 trackW = 拖到末端,服务端按到末端判过)→ POST /api/login ----
async function login(username, password) {
  const ch = await req('GET', '/api/captcha/challenge');
  const { challengeId, trackW } = JSON.parse(ch.body);
  const v = await req('POST', '/api/captcha/verify', { body: { challengeId, x: trackW } });
  const { captchaToken } = JSON.parse(v.body);
  const r = await req('POST', '/api/login', { body: { username, password, captchaToken } });
  if (r.status !== 200) throw new Error(`login failed ${r.status}: ${r.body?.slice(0, 120)}`);
  return r.setCookie; // session cookie
}

// ---- 百分位 ----
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

// ---- 闭环并发:concurrency 个 worker 持续 DURATION 秒不停打,统计吞吐+延迟+错误 ----
async function runLevel(concurrency, makeReq) {
  const lat = [];
  let ok = 0,
    err = 0;
  const errKinds = {};
  const deadline = Date.now() + DURATION * 1000;
  async function worker() {
    while (Date.now() < deadline) {
      const r = await makeReq();
      lat.push(r.ms);
      if (r.status >= 200 && r.status < 400) ok++;
      else {
        err++;
        const k = r.error || `HTTP ${r.status}`;
        errKinds[k] = (errKinds[k] || 0) + 1;
      }
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const total = ok + err;
  return {
    concurrency,
    rps: +(total / elapsed).toFixed(0),
    ok,
    err,
    errPct: +((err / total) * 100).toFixed(1),
    p50: +pct(lat, 50).toFixed(1),
    p95: +pct(lat, 95).toFixed(1),
    p99: +pct(lat, 99).toFixed(1),
    max: +(lat[lat.length - 1] || 0).toFixed(1),
    errKinds,
  };
}

async function main() {
  console.log(`\n灵镜 平台并发压测  base=${BASE}  每档=${DURATION}s  档位=${LEVELS.join('/')}\n`);

  // 预登录两个会话(读/写场景复用,避免把登录开销混进读写延迟)
  const adminCookie = await login('demoadmin', 'pw123456');
  console.log('✓ demoadmin 登录成功,session 就绪\n');

  const scenarios = {
    // 1) 鉴权读:每请求过 requireAuth(resolveSession 读 DB)+ 一次列表读。WAL 下并发读应很高。
    read: () => req('GET', '/api/jobs?limit=20', { cookie: adminCookie }),
    // 2) 纯 DB 写:落一条意向线索(无积分、无云调用)。直接压 SQLite 单写。
    'write-lead': () =>
      req('POST', '/api/sales-leads', { cookie: adminCookie, body: { kind: 'enterprise', note: 'loadtest' } }),
    // 3) 入队写:POST /api/jobs(tts 最轻),走 enqueue 事务 + reserve 预扣。
    //    ⚠️ 这会真实触发 worker 调百炼且扣积分,与「不考虑云AI」相悖,故默认不跑;
    //    只在 --scenario enqueue 显式指定时跑,且会很快耗尽积分变 402 —— 仅供观察入队事务延迟。
    enqueue: () =>
      req('POST', '/api/jobs', {
        cookie: adminCookie,
        body: { type: 'tts', text: '并发压测样例文本', voiceRef: 'preset:zhixiaobai' },
      }),
    // 4) 登录:全链路(captcha 出题+校验+建 session),最重的冷路径。
    login: async () => {
      const t0 = process.hrtime.bigint();
      try {
        await login('demoadmin', 'pw123456');
        return { status: 200, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
      } catch (e) {
        return { status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, error: 'login' };
      }
    },
    // 5) 混合:80% 读 + 20% 写,贴近真实流量。
    mixed: () =>
      Math.random() < 0.2
        ? req('POST', '/api/sales-leads', { cookie: adminCookie, body: { kind: 'enterprise', note: 'lt' } })
        : req('GET', '/api/jobs?limit=20', { cookie: adminCookie }),
  };

  // 默认场景集排除 enqueue(真实云调用+扣费,与「不考虑云AI」相悖);需显式 --scenario enqueue。
  const DEFAULT_SET = ['read', 'write-lead', 'login', 'mixed'];
  const pick = ONLY
    ? { [ONLY]: scenarios[ONLY] }
    : Object.fromEntries(DEFAULT_SET.map((k) => [k, scenarios[k]]));
  for (const [name, fn] of Object.entries(pick)) {
    if (!fn) {
      console.log(`(未知场景 ${name},跳过)`);
      continue;
    }
    console.log(`━━ 场景: ${name} ━━`);
    console.log('  并发    RPS     P50ms   P95ms   P99ms   Max ms   错误%   错误明细');
    for (const c of LEVELS) {
      const r = await runLevel(c, fn);
      const ek = Object.keys(r.errKinds).length ? JSON.stringify(r.errKinds) : '-';
      console.log(
        `  ${String(c).padEnd(6)}${String(r.rps).padEnd(8)}${String(r.p50).padEnd(8)}${String(r.p95).padEnd(8)}${String(r.p99).padEnd(8)}${String(r.max).padEnd(9)}${String(r.errPct).padEnd(8)}${ek}`,
      );
    }
    console.log('');
  }
  agent.destroy();
}

main().catch((e) => {
  console.error('压测失败:', e.message);
  process.exit(1);
});
