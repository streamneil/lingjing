// 共享左侧导航 — 各页 <body data-page="..."> 决定高亮
(function(){
  // 确保 api.js 已加载(系统页只需引 shell.js 即自带登录态/登出)
  if (!window.LJ && !document.querySelector('script[src="api.js"]')) {
    const s = document.createElement('script');
    s.src = 'api.js';
    document.head.appendChild(s);
  }
  const I = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    studio: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    avatars: '<circle cx="12" cy="8" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>',
    voices: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
    assets: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 15 5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="8.5" r="1.5"/>',
    works: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    billing: '<path d="M3 3v18h18"/><path d="m7 14 3-4 4 3 4-6"/>',
    members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  };
  const ic = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[p]}</svg>`;
  const NAV = [
    {p:'dashboard', t:'概览', h:'dashboard.html'},
    {g:'创作'},
    {p:'studio', t:'创作台', h:'create.html'},
    {p:'avatars', t:'形象库', h:'avatars.html'},
    {p:'voices', t:'音色库', h:'voices.html'},
    {p:'assets', t:'素材库', h:'assets.html'},
    {p:'works', t:'作品库', h:'works.html'},
    {g:'经营管理'},
    {p:'billing', t:'用量计费', h:'billing.html'},
    {p:'members', t:'成员与权限', h:'members.html'},
    {p:'settings', t:'系统设置', h:'settings.html'},
  ];
  const cur = document.body.dataset.page;
  const items = NAV.map(n => n.g
    ? `<div class="sb-group">${n.g}</div>`
    : `<a class="sb-item ${n.p===cur?'active':''}" href="${n.h}">${ic(n.p)}<span>${n.t}</span></a>`
  ).join('');

  const sb = `
  <aside class="sidebar">
    <div class="sb-brand">
      <span class="logo-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#0A0A0B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.3"/><path d="M5 20c0-3.7 3.1-5.6 7-5.6s7 1.9 7 5.6"/></svg></span>
      <span class="nm">Lingjing</span><span class="cjk">灵镜</span>
    </div>
    <div class="org-static">
      <div class="org-ic">融</div>
      <div class="org-meta"><div class="l">机构</div><div class="n">融媒体中心</div></div>
    </div>
    <nav class="sb-nav">${items}</nav>
    <div class="sb-foot"><div class="deploy-tag"><span class="d"></span><span>云端服务 · 运行中</span></div></div>
  </aside>`;

  document.getElementById('shell-mount').insertAdjacentHTML('afterbegin', sb);

  // 顶栏(面包屑 + 点数 + 账号)— 页面用 data-crumb 提供路径
  const crumb = (document.body.dataset.crumb || '').split('>').map((s,i,a)=>
    i===a.length-1 ? `<b>${s.trim()}</b>` : `${s.trim()}<span class="s">/</span>`
  ).join(' ');
  const bar = `
    <header class="app-bar">
      <div class="crumb">${crumb}</div>
      <div class="sp"></div>
      <div class="credits">
        <span class="gem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6 3h12l4 6-10 12L2 9l4-6Z"/><path d="M2 9h20M9 3 6.5 9 12 21M15 3l2.5 6L12 21"/></svg></span>
        剩余 <b class="num" id="lj-balance">—</b><a href="billing.html" class="topup">充值</a>
      </div>
      <div class="avatar-btn" id="lj-account" title="点击登出">融</div>
    </header>`;
  const mc = document.querySelector('.main-col');
  if (mc) mc.insertAdjacentHTML('afterbegin', bar);

  // 登录态:拉当前用户填充机构名/账号;未登录 api.js 会跳 login。
  // 注意 shell.js 在 api.js 之前注入,这里延迟到 LJ 就绪后执行。
  function bindAuth(){
    if (!window.LJ) { setTimeout(bindAuth, 30); return; }
    LJ.me().then(u => {
      const acc = document.getElementById('lj-account');
      if (acc){
        acc.textContent = (u.username || '用户').slice(0,1).toUpperCase();
        acc.title = `${u.username}(${({admin:'管理员',creator:'创作者',viewer:'查看者'})[u.role]||u.role}) · 点击登出`;
        acc.style.cursor = 'pointer';
        acc.onclick = async () => {
          if (!confirm('确认登出?')) return;
          try { await LJ.logout(); } catch {}
          location.href = 'login.html';
        };
      }
      // viewer 隐藏“创建/发起生成”入口(前端兜底,后端已有 403 硬拦)
      if (u.role === 'viewer') {
        document.querySelectorAll('[data-requires-create]').forEach(el => el.style.display='none');
      }
    }).catch(()=>{ /* 未登录已被 api.js 跳转 */ });

    // 顶栏真实余额
    LJ.get('/credits/balance').then(r => {
      const el = document.getElementById('lj-balance');
      if (el) el.textContent = (r.balance ?? 0).toLocaleString('en-US');
    }).catch(()=>{});
  }
  bindAuth();
})();
