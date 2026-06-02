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
      throw err;
    }
    return data;
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    del: (p) => call('DELETE', p),

    // 便捷方法
    login: (username, password) =>
      call('POST', '/login', { username, password }),
    logout: () => call('POST', '/logout'),
    me: () => call('GET', '/me'),

    // 任务
    createJob: (input) => call('POST', '/jobs', input),
    getJob: (id) => call('GET', '/jobs/' + id),
    retryJob: (id) => call('POST', '/jobs/' + id + '/retry'),
    listJobs: () => call('GET', '/jobs'),

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
