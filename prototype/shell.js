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
      <span class="logo-mark"><svg viewBox="0 0 32 32" fill="none"><path d="M16 3.5C9.1 3.5 3.5 9.1 3.5 16S9.1 28.5 16 28.5" stroke="#0A0A0B" stroke-width="3" stroke-linecap="round"/><path d="M16 6.5C21.2 6.5 25.5 10.8 25.5 16S21.2 25.5 16 25.5" stroke="#0A0A0B" stroke-width="3" stroke-linecap="round" opacity="0.45"/><circle cx="16" cy="13" r="2.6" fill="#0A0A0B"/><path d="M11.2 21.5c0-2.9 2.1-4.6 4.8-4.6s4.8 1.7 4.8 4.6" stroke="#0A0A0B" stroke-width="2.4" stroke-linecap="round"/></svg></span>
      <span class="nm">Lingjing</span><span class="cjk">灵镜</span>
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
      <div class="lj-acc-wrap" style="position:relative">
        <div class="avatar-btn" id="lj-account" title="账号">融</div>
        <div id="lj-menu" style="display:none;position:absolute;right:0;top:46px;width:220px;background:var(--modal,#161618);border:1px solid var(--line,#232327);border-radius:14px;box-shadow:var(--sh-pop);padding:7px;z-index:200">
          <div id="lj-menu-head" style="padding:11px 12px 10px;border-bottom:1px solid var(--line-soft,#1A1A1D);margin-bottom:6px">
            <div id="lj-menu-name" style="font-size:14px;font-weight:600;color:var(--t1)">…</div>
            <div id="lj-menu-role" style="font-size:11.5px;color:var(--t3);margin-top:2px;font-family:var(--f-mono)"></div>
          </div>
          <button class="lj-mi" data-act="profile">个人信息</button>
          <button class="lj-mi" data-act="password">修改密码</button>
          <button class="lj-mi" data-act="logout" style="color:var(--red)">登出</button>
        </div>
      </div>
    </header>`;
  const mc = document.querySelector('.main-col');
  if (mc) mc.insertAdjacentHTML('afterbegin', bar);

  // 账号菜单项样式 + 两个弹窗(个人信息 / 改密码)
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .lj-mi{display:block;width:100%;text-align:left;background:none;border:none;color:var(--t2);font-size:13.5px;font-family:var(--f);padding:9px 12px;border-radius:9px;cursor:pointer;transition:.15s}
    .lj-mi:hover{background:var(--card-hi,#1C1C1F);color:var(--t1)}
    .lj-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:none;place-items:center;z-index:300}
    .lj-ov.on{display:grid}
    .lj-modal{width:360px;max-width:92vw;background:var(--modal,#161618);border:1px solid var(--line,#232327);border-radius:18px;padding:26px;box-shadow:var(--sh-pop)}
    .lj-modal h3{font-size:17px;font-weight:700;margin-bottom:18px;color:var(--t1)}
    .lj-modal label{display:block;font-size:12px;color:var(--t3);margin:0 0 7px}
    .lj-modal input{width:100%;box-sizing:border-box;background:var(--field,#121214);border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--t1);font-size:14px;font-family:var(--f);outline:none;margin-bottom:14px}
    .lj-modal input:focus{border-color:var(--blue)}
    .lj-modal .row{display:flex;gap:10px;margin-top:6px}
    .lj-modal .row button{flex:1;padding:11px;border-radius:999px;font-size:14px;font-weight:600;font-family:var(--f);cursor:pointer;border:1px solid var(--line)}
    .lj-modal .ok{background:var(--t1);color:#0A0A0B;border:none}
    .lj-modal .cancel{background:none;color:var(--t2)}
    .lj-msg{font-size:12.5px;min-height:16px;margin-bottom:4px}`;
  document.head.appendChild(styleEl);
  document.body.insertAdjacentHTML('beforeend', `
    <div class="lj-ov" id="lj-ov-profile"><div class="lj-modal">
      <h3>个人信息</h3>
      <label>昵称(展示名)</label><input id="lj-dn" maxlength="30" placeholder="你的昵称">
      <label>登录用户名(不可改)</label><input id="lj-un" disabled>
      <div class="lj-msg" id="lj-pf-msg"></div>
      <div class="row"><button class="cancel" data-close>取消</button><button class="ok" id="lj-pf-save">保存</button></div>
    </div></div>
    <div class="lj-ov" id="lj-ov-pwd"><div class="lj-modal">
      <h3>修改密码</h3>
      <label>原密码</label><input id="lj-op" type="password" placeholder="当前密码">
      <label>新密码(≥6 位)</label><input id="lj-np" type="password" placeholder="新密码">
      <label>确认新密码</label><input id="lj-np2" type="password" placeholder="再次输入">
      <div class="lj-msg" id="lj-pw-msg"></div>
      <div class="row"><button class="cancel" data-close>取消</button><button class="ok" id="lj-pw-save">确认修改</button></div>
    </div></div>`);

  // 登录态:拉当前用户填充机构名/账号;未登录 api.js 会跳 login。
  // 注意 shell.js 在 api.js 之前注入,这里延迟到 LJ 就绪后执行。
  const ROLE_CN = {admin:'管理员',creator:'创作者',viewer:'查看者'};
  function bindAuth(){
    if (!window.LJ) { setTimeout(bindAuth, 30); return; }
    LJ.me().then(u => {
      const acc = document.getElementById('lj-account');
      const menu = document.getElementById('lj-menu');
      const display = u.displayName || u.username;
      if (acc){
        acc.textContent = display.slice(0,1).toUpperCase();
        acc.title = display;
        acc.style.cursor = 'pointer';
        document.getElementById('lj-menu-name').textContent = display;
        document.getElementById('lj-menu-role').textContent = `@${u.username} · ${ROLE_CN[u.role]||u.role}`;
        // 开关菜单
        acc.onclick = (e)=>{ e.stopPropagation(); menu.style.display = menu.style.display==='none'?'block':'none'; };
        document.addEventListener('click', ()=>{ menu.style.display='none'; });
        menu.onclick = (e)=>e.stopPropagation();
      }
      // 菜单动作
      menu.querySelectorAll('.lj-mi').forEach(mi => mi.onclick = async ()=>{
        menu.style.display='none';
        const act = mi.dataset.act;
        if (act==='logout'){ if(!confirm('确认登出?'))return; try{await LJ.logout();}catch{} location.href='login.html'; }
        else if (act==='profile'){
          document.getElementById('lj-dn').value = u.displayName || '';
          document.getElementById('lj-un').value = u.username;
          document.getElementById('lj-pf-msg').textContent='';
          document.getElementById('lj-ov-profile').classList.add('on');
        }
        else if (act==='password'){
          ['lj-op','lj-np','lj-np2'].forEach(id=>document.getElementById(id).value='');
          document.getElementById('lj-pw-msg').textContent='';
          document.getElementById('lj-ov-pwd').classList.add('on');
        }
      });
      // 弹窗:取消 / 保存
      document.querySelectorAll('.lj-ov [data-close]').forEach(b=>b.onclick=()=>b.closest('.lj-ov').classList.remove('on'));
      document.querySelectorAll('.lj-ov').forEach(ov=>ov.addEventListener('click',e=>{if(e.target===ov)ov.classList.remove('on')}));
      document.getElementById('lj-pf-save').onclick = async ()=>{
        const dn=document.getElementById('lj-dn').value.trim(); const msg=document.getElementById('lj-pf-msg');
        if(!dn){ msg.style.color='var(--red)'; msg.textContent='昵称不能为空'; return; }
        try{ const r=await LJ.put('/me',{displayName:dn}); document.getElementById('lj-account').textContent=dn.slice(0,1).toUpperCase(); document.getElementById('lj-menu-name').textContent=dn; document.getElementById('lj-ov-profile').classList.remove('on'); }
        catch(e){ msg.style.color='var(--red)'; msg.textContent=e.message; }
      };
      document.getElementById('lj-pw-save').onclick = async ()=>{
        const op=document.getElementById('lj-op').value, np=document.getElementById('lj-np').value, np2=document.getElementById('lj-np2').value;
        const msg=document.getElementById('lj-pw-msg'); msg.style.color='var(--red)';
        if(!op||!np){ msg.textContent='请填写原密码和新密码'; return; }
        if(np!==np2){ msg.textContent='两次新密码不一致'; return; }
        if(np.length<6){ msg.textContent='新密码至少 6 位'; return; }
        try{ await LJ.post('/me/password',{oldPassword:op,newPassword:np}); msg.style.color='var(--green)'; msg.textContent='✓ 已修改'; setTimeout(()=>document.getElementById('lj-ov-pwd').classList.remove('on'),900); }
        catch(e){ msg.textContent=e.message; }
      };
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
