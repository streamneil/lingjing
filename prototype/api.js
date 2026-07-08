// 灵镜 前端 API 封装 — 统一 fetch /api,自动带 cookie,未登录跳登录页。
// 不依赖任何框架,原生 fetch。被各页面 <script src="api.js"> 引入。

window.LJ = (function () {
  async function call(method, path, body) {
    const opts = {
      method,
      headers: {},
      credentials: 'same-origin', // 带上 session cookie
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, opts);

    // 未登录:除登录接口本身外,统一跳登录页
    if (res.status === 401 && path !== '/login') {
      location.href = 'login.html';
      throw new Error('未登录');
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 无 body */
    }
    if (!res.ok) {
      const msg = (data && data.error) || `请求失败 (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      if (data && data.code) err.code = data.code; // 业务错误码(SEATS_FULL/LAST_ADMIN/…),前端按 code 分支
      throw err;
    }
    return data;
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),

    // 便捷方法
    login: (username, password, captchaToken) =>
      call('POST', '/login', { username, password, captchaToken }),
    // 短信验证码:发码(需滑块 token)+ 登录/注册(统一入口,后端按手机号是否存在分支)
    smsSend: (phone, captchaToken) => call('POST', '/sms/send', { phone, captchaToken }),
    smsLogin: (phone, code) => call('POST', '/sms/login', { phone, code }),
    logout: () => call('POST', '/logout'),
    me: () => call('GET', '/me'),

    // 任务
    createJob: (input) => call('POST', '/jobs', input),
    getJob: (id) => call('GET', '/jobs/' + id),
    retryJob: (id) => call('POST', '/jobs/' + id + '/retry'),
    // 任务列表(服务端分页 + 按类型/来源/状态筛)。opts: {type|[types], source, status, page, pageSize}。
    // 返回 {jobs, total, page, pageSize}。无 opts 即最新一页(默认 pageSize 50),向后兼容旧口径。
    listJobs: (opts) => {
      const o = opts || {};
      const q = new URLSearchParams();
      if (o.type) q.set('type', Array.isArray(o.type) ? o.type.join(',') : o.type);
      if (o.source) q.set('source', o.source);
      if (o.status) q.set('status', o.status);
      if (o.page) q.set('page', String(o.page));
      if (o.pageSize) q.set('pageSize', String(o.pageSize));
      const qs = q.toString();
      return call('GET', '/jobs' + (qs ? '?' + qs : ''));
    },

    /**
     * 轮询任务直到终态(done/failed)。
     * onUpdate(job) 每次轮询回调,用于刷新对话流 UI。
     * 决策来源:/plan-eng-review D4 —— DB 为真相,前端轮询拉快照(无 SSE)。
     */
    async pollJob(id, onUpdate, intervalMs = 3000) {
      for (;;) {
        const job = await call('GET', '/jobs/' + id);
        if (onUpdate) onUpdate(job);
        if (job.status === 'done' || job.status === 'failed') return job;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
})();
