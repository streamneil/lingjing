// 共享左侧导航 — 各页 <body data-page="..."> 决定高亮(工具页用 tools.js 的 key 当 data-page)
(function(){
  // 全局 popover 关闭:点击 .pop-anchor 之外的任意区域 → 关闭所有打开的 modelPill/setPill/seed 弹框。
  // 不依赖每页的 .pop-ov 透明遮罩(z-index 边界 case 下遮罩可能被更高层元素挡住吞掉点击)。
  // 用 mousedown 捕获,比 click 更早、更稳;点击弹框内部(.pop)或锚点(.pop-anchor)不关闭。
  document.addEventListener('mousedown', (e)=>{
    if (!document.querySelector('.pop.show')) return; // 无打开的弹框,快速返回
    if (e.target.closest('.pop-anchor')) return;      // 点在 pill / 弹框内部 → 不关
    if (typeof window.closePops === 'function') window.closePops();
    else {
      document.querySelectorAll('.pop.show').forEach(p=>p.classList.remove('show'));
      document.querySelectorAll('.cpill.open').forEach(p=>p.classList.remove('open'));
      document.querySelectorAll('.pop-ov.show').forEach(o=>o.classList.remove('show'));
    }
  });
  // 确保依赖已加载(系统页只引 shell.js 即自带登录态/登出 + 工具注册表)
  if (!window.LJ && !document.querySelector('script[src="api.js"]')) {
    const s = document.createElement('script'); s.src = 'api.js'; document.head.appendChild(s);
  }
  if (!window.LJTools && !document.querySelector('script[src="tools.js"]')) {
    const s = document.createElement('script'); s.src = 'tools.js'; document.head.appendChild(s);
  }
  const I = {
    explore: '<circle cx="12" cy="12" r="9"/><path d="m15 9-3.5 1.5L10 14l3.5-1.5L15 9Z"/>',
    assets: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    more: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="16" cy="12" r="1"/>',
    billing: '<path d="M3 3v18h18"/><path d="m7 14 3-4 4 3 4-6"/>',
    members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  };
  const svg = inner => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ic = p => svg(I[p]);
  const cur = document.body.dataset.page;
  // data-label:折叠态(≤1000px)hover 飞出标签用(span 此时被隐藏)。
  const link = (p, label, href, extra) =>
    `<a class="sb-item ${p===cur?'active':''}" href="${href}" data-label="${label}"${extra||''}>${ic(p)}<span>${label}</span></a>`;

  // 创作工具组:从 tools.js 注册表渲染(唯一真源)。徽章/即将上线角标随描述符。
  // 全部工具是"发起生成"入口,viewer 无权 → data-requires-create 兜底隐藏。
  // ⚠️ shell.js 在 tools.js 之前注入(异步),首渲时 LJTools 可能未就绪 →
  //    先渲占位容器 #sb-tools,挂载后由 fillTools() 轮询 LJTools 就绪再填(否则创作工具组为空)。
  function buildToolItems(){
    const tools = (window.LJTools ? LJTools.list : []);
    return tools.map(t => {
      const on = t.key===cur ? ' active' : '';
      let suffix = '';
      if (t.badge) suffix = `<span class="${t.badge.kind==='nano'?'nano':'nbadge'}">${t.badge.text}</span>`;
      else if (!t.enabled) suffix = `<span class="soon">即将上线</span>`;
      return `<a class="sb-item sb-tool${on}" href="${LJTools.href(t)}" data-label="${t.label}" data-requires-create>${svg(t.icon)}<span>${t.label}</span>${suffix}</a>`;
    }).join('');
  }

  const items =
    link('explore','探索','explore.html') +
    link('assets','我的资产','assets.html') +
    `<div class="sb-group">创作工具</div>` +
    `<div id="sb-tools">${buildToolItems()}</div>` +
    `<div class="sb-group">经营管理</div>` +
    link('billing','用量计费','billing.html') +
    link('members','成员与权限','members.html') +
    link('settings','系统设置','settings.html');

  const sb = `
  <aside class="sidebar">
    <a class="sb-brand" href="explore.html" title="灵镜 · 探索">
      <span class="logo-mark" id="lj-brand-mark"><svg viewBox="0 0 100 100" fill="none"><circle cx="37" cy="50" r="29" stroke="#0E0E0E" stroke-width="5"/><circle cx="63" cy="50" r="29" stroke="#0E0E0E" stroke-width="5"/><path d="M50 24.08 A29 29 0 0 1 50 75.92 A29 29 0 0 1 50 24.08 Z" fill="#0E0E0E"/></svg></span>
      <span class="nm">Lingjing</span><span class="cjk">灵镜</span>
    </a>
    <nav class="sb-nav">${items}</nav>
    <div class="sb-foot"><div class="deploy-tag"><span class="d"></span><span>云端服务 · 运行中</span></div></div>
  </aside>`;

  document.getElementById('shell-mount').insertAdjacentHTML('afterbegin', sb);

  // 创作工具组延迟填充:tools.js 异步注入,就绪后再渲(首渲为空时兜底)。
  function fillTools(){
    if (!window.LJTools) { setTimeout(fillTools, 30); return; }
    const host = document.getElementById('sb-tools');
    if (!host) return;
    if (!host.children.length) host.innerHTML = buildToolItems(); // 首渲已填则不重复
    // 若用户已知是 viewer(bindAuth 已跑),补隐藏新填的创作入口
    if (window.__ljRole === 'viewer') host.querySelectorAll('[data-requires-create]').forEach(el => el.style.display='none');
  }
  fillTools();

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
    .lj-modal .ok.lj-danger{background:var(--red);color:#fff;border:none}
    .lj-modal .cancel{background:none;color:var(--t2)}
    .lj-modal .lj-body{font-size:13.5px;color:var(--t2);line-height:1.6;margin-bottom:18px}
    .lj-msg{font-size:12.5px;min-height:16px;margin-bottom:4px}
    #lj-toast-host{position:fixed;top:22px;right:22px;z-index:600;display:flex;flex-direction:column;gap:8px;pointer-events:none}
    .lj-toast{background:var(--modal,#161618);border:1px solid var(--line,#232327);border-left:3px solid var(--green);border-radius:11px;padding:12px 16px;font-size:13px;color:var(--t1);box-shadow:var(--sh-pop);opacity:0;transform:translateY(-8px);transition:.28s}
    .lj-toast.on{opacity:1;transform:translateY(0)}
    .lj-toast.err{border-left-color:var(--red)}`;
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
      <label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--t3);cursor:pointer;margin-bottom:8px"><input type="checkbox" id="lj-pw-show" style="width:auto;margin:0">显示密码</label>
      <div style="font-size:11.5px;color:var(--t4);margin-bottom:10px;line-height:1.5">修改后,你在其它设备的登录将被登出,需用新密码重新登录。</div>
      <div class="lj-msg" id="lj-pw-msg"></div>
      <div class="row"><button class="cancel" data-close>取消</button><button class="ok" id="lj-pw-save">确认修改</button></div>
    </div></div>`);

  // 登录态:拉当前用户填充机构名/账号;未登录 api.js 会跳 login。
  // 注意 shell.js 在 api.js 之前注入,这里延迟到 LJ 就绪后执行。
  const ROLE_CN = {admin:'管理员',creator:'创作者',viewer:'查看者'};
  function bindAuth(){
    if (!window.LJ) { setTimeout(bindAuth, 30); return; }
    LJ.me().then(u => {
      window.__ljRole = u.role; // 供 fillTools 在 bindAuth 后补隐藏 viewer 创作入口
      const acc = document.getElementById('lj-account');
      const menu = document.getElementById('lj-menu');
      const display = u.displayName || u.username;
      // 机构 Logo:有则替换默认品牌图标(公开读路径,onerror 回退默认 SVG)。
      if (u.orgLogoKey) {
        const mark = document.getElementById('lj-brand-mark');
        if (mark) {
          const img = new Image();
          img.src = '/api/org-logo/' + u.tenantId;
          img.alt = u.tenantName || '机构';
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:7px';
          img.onload = () => { mark.innerHTML = ''; mark.appendChild(img); };
          // onerror:不替换,保留默认 SVG 图标
        }
      }
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
        if (act==='logout'){ if(!(await window.LJConfirm({title:'登出',body:'确认要退出当前账号吗?',confirmText:'登出',danger:true})))return; try{await LJ.logout();}catch{} location.href='login.html'; }
        else if (act==='profile'){
          document.getElementById('lj-dn').value = u.displayName || '';
          document.getElementById('lj-un').value = u.username;
          document.getElementById('lj-pf-msg').textContent='';
          document.getElementById('lj-ov-profile').classList.add('on');
        }
        else if (act==='password'){
          ['lj-op','lj-np','lj-np2'].forEach(id=>{const e=document.getElementById(id);e.value='';e.type='password';});
          document.getElementById('lj-pw-show').checked=false;
          document.getElementById('lj-pw-msg').textContent='';
          document.getElementById('lj-ov-pwd').classList.add('on');
        }
      });
      // 改密码:显示密码切换 + 即时一致性反馈
      const pwShow=document.getElementById('lj-pw-show');
      if(pwShow) pwShow.onchange=()=>['lj-op','lj-np','lj-np2'].forEach(id=>document.getElementById(id).type=pwShow.checked?'text':'password');
      const np=document.getElementById('lj-np'), np2=document.getElementById('lj-np2'), pwMsg=document.getElementById('lj-pw-msg');
      function pwLiveCheck(){
        if(np2.value && np.value!==np2.value){ pwMsg.style.color='var(--amber)'; pwMsg.textContent='两次新密码不一致'; }
        else if(np.value && np.value.length<6){ pwMsg.style.color='var(--amber)'; pwMsg.textContent='新密码至少 6 位'; }
        else pwMsg.textContent='';
      }
      if(np){ np.addEventListener('input',pwLiveCheck); np2.addEventListener('input',pwLiveCheck); }
      // 弹窗:取消 / 保存
      document.querySelectorAll('.lj-ov [data-close]').forEach(b=>b.onclick=()=>b.closest('.lj-ov').classList.remove('on'));
      document.querySelectorAll('.lj-ov').forEach(ov=>ov.addEventListener('click',e=>{if(e.target===ov)ov.classList.remove('on')}));
      document.getElementById('lj-pf-save').onclick = async ()=>{
        const dn=document.getElementById('lj-dn').value.trim(); const msg=document.getElementById('lj-pf-msg');
        if(!dn){ msg.style.color='var(--red)'; msg.textContent='昵称不能为空'; return; }
        try{ await LJ.put('/me',{displayName:dn}); document.getElementById('lj-account').textContent=dn.slice(0,1).toUpperCase(); document.getElementById('lj-menu-name').textContent=dn; document.getElementById('lj-ov-profile').classList.remove('on'); window.LJToast&&window.LJToast('✓ 个人信息已保存'); }
        catch(e){ msg.style.color='var(--red)'; msg.textContent=e.message; }
      };
      document.getElementById('lj-pw-save').onclick = async ()=>{
        const op=document.getElementById('lj-op').value, np=document.getElementById('lj-np').value, np2=document.getElementById('lj-np2').value;
        const msg=document.getElementById('lj-pw-msg'); msg.style.color='var(--red)';
        if(!op||!np){ msg.textContent='请填写原密码和新密码'; return; }
        if(np!==np2){ msg.textContent='两次新密码不一致'; return; }
        if(np.length<6){ msg.textContent='新密码至少 6 位'; return; }
        const save=document.getElementById('lj-pw-save'); save.disabled=true; save.textContent='修改中…';
        try{ await LJ.post('/me/password',{oldPassword:op,newPassword:np}); msg.style.color='var(--green)'; msg.textContent='✓ 密码已修改,其它设备已登出'; setTimeout(()=>{document.getElementById('lj-ov-pwd').classList.remove('on');save.disabled=false;save.textContent='确认修改';window.LJToast&&window.LJToast('✓ 密码已更新');},1400); }
        catch(e){ msg.style.color='var(--red)'; msg.textContent=e.message; save.disabled=false; save.textContent='确认修改'; }
      };
      // viewer 隐藏"创建/发起生成"入口(前端兜底,后端已有 403 硬拦)
      if (u.role === 'viewer') {
        document.querySelectorAll('[data-requires-create]').forEach(el => el.style.display='none');
        // viewer 误入任一创作工具页(无权)→ 引导回探索,而非停在点了报 403 的页。
        // 工具页的 data-page 是 tools.js 的 key;用注册表判定当前页是否为工具页。
        const onToolPage = window.LJTools && LJTools.get(document.body.dataset.page);
        if (onToolPage) {
          window.LJToast('查看者无创作权限,已返回探索','err'); location.href = 'explore.html';
        }
      }
    }).catch(()=>{ /* 未登录已被 api.js 跳转 */ });

    // 顶栏真实余额
    LJ.get('/credits/balance').then(r => {
      const el = document.getElementById('lj-balance');
      if (el) el.textContent = (r.balance ?? 0).toLocaleString('en-US');
    }).catch(()=>{});
  }
  // 全局轻提示(右上角 toast),取代静默关闭弹窗带来的"没反应"错觉
  window.LJToast = function(text, kind){
    let host = document.getElementById('lj-toast-host');
    if(!host){ host=document.createElement('div'); host.id='lj-toast-host'; document.body.appendChild(host); }
    const t = document.createElement('div'); t.className='lj-toast'+(kind==='err'?' err':'');
    t.textContent = text; host.appendChild(t);
    requestAnimationFrame(()=>t.classList.add('on'));
    setTimeout(()=>{ t.classList.remove('on'); setTimeout(()=>t.remove(),300); }, 2600);
  };

  // 共享弹窗:取代浏览器原生 confirm()/prompt()。返回 Promise,可 await。
  function ljBuildOverlay(innerHTML){
    const ov = document.createElement('div');
    ov.className = 'lj-ov';
    ov.innerHTML = `<div class="lj-modal">${innerHTML}</div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(()=>ov.classList.add('on'));
    return ov;
  }
  function ljTeardown(ov, onKey){
    ov.classList.remove('on');
    document.removeEventListener('keydown', onKey);
    setTimeout(()=>ov.remove(), 300);
  }
  // 危险/确认弹窗。body 以 HTML 注入,调用方对用户内容用 esc() 转义。→ Promise<boolean>
  window.LJConfirm = function(opts){
    opts = opts || {};
    const { title='请确认', body='', confirmText='确认', cancelText='取消', danger=false } = opts;
    return new Promise(resolve=>{
      const ov = ljBuildOverlay(
        `<h3>${title}</h3>`+
        `<div class="lj-body">${body}</div>`+
        `<div class="row"><button class="cancel" data-act="cancel">${cancelText}</button>`+
        `<button class="ok${danger?' lj-danger':''}" data-act="ok">${confirmText}</button></div>`);
      const done = v => { ljTeardown(ov, onKey); resolve(v); };
      const onKey = e => { if(e.key==='Escape') done(false); };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', e=>{ if(e.target===ov) done(false); });
      ov.querySelector('[data-act=cancel]').onclick = ()=>done(false);
      ov.querySelector('[data-act=ok]').onclick = ()=>done(true);
    });
  };
  // 文本输入弹窗(通用 prompt 替代)。→ Promise<string|null>
  window.LJPrompt = function(opts){
    opts = opts || {};
    const { title='', label='', value='', placeholder='', confirmText='确认', cancelText='取消' } = opts;
    return new Promise(resolve=>{
      const ov = ljBuildOverlay(
        `<h3>${title}</h3>`+
        (label?`<label>${label}</label>`:'')+
        `<input class="lj-prompt-in" value="${String(value).replace(/"/g,'&quot;')}" placeholder="${placeholder}">`+
        `<div class="row"><button class="cancel" data-act="cancel">${cancelText}</button>`+
        `<button class="ok" data-act="ok">${confirmText}</button></div>`);
      const input = ov.querySelector('.lj-prompt-in');
      const done = v => { ljTeardown(ov, onKey); resolve(v); };
      const submit = ()=>{ const t=input.value.trim(); done(t||null); };
      const onKey = e => { if(e.key==='Escape') done(null); if(e.key==='Enter'){ e.preventDefault(); submit(); } };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', e=>{ if(e.target===ov) done(null); });
      ov.querySelector('[data-act=cancel]').onclick = ()=>done(null);
      ov.querySelector('[data-act=ok]').onclick = submit;
      setTimeout(()=>{ input.focus(); input.select(); }, 60);
    });
  };
  // 相对时间(记录卡时间戳:刚刚/N分钟前/N小时前/N天前/日期)。
  // 各创作页记录卡 head() 共用;ts 缺省(刚提交的卡没带 createdAt)返回空串,调用方回落「刚刚」。
  window.LJTimeAgo = function(ts){
    if(!ts) return '';
    const d = Date.now() - ts;
    const m = 60000, h = 3600000, day = 86400000;
    if(d < m) return '刚刚';
    if(d < h) return Math.floor(d/m) + ' 分钟前';
    if(d < day) return Math.floor(d/h) + ' 小时前';
    if(d < 7*day) return Math.floor(d/day) + ' 天前';
    const t = new Date(ts); const pad = n => String(n).padStart(2,'0');
    return t.getFullYear() + '-' + pad(t.getMonth()+1) + '-' + pad(t.getDate());
  };

  /**
   * 统一下载工具(图片/视频/音频通用)。
   * 「下载一闪而过」根因:OSS 签名 URL 无 CORS 头,fetch(签名URL) 被浏览器 CORS 拦截,
   *   回落 window.open 打开图片直链 → 一闪而过。
   * 正解:同源下载端点(/api/jobs/:id/download/:idx,后端加 Content-Disposition:attachment),
   *   同源 URL 上 <a download> 直接生效,无需 fetch,无 CORS。
   * 本函数:
   *   · 同源 URL → 直接 <a href download>(挂 DOM → click → 延迟移除),最稳;
   *   · 跨域 URL(兜底,理论上不再走到)→ fetch blob;失败再回落 window.open。
   * 返回 Promise<boolean>:true=已触发下载,false=回落到新窗口打开。
   */
  function isSameOrigin(url){
    try{ return new URL(url, location.href).origin === location.origin; }
    catch{ return false; }
  }
  function clickAnchor(href, filename, revokeUrl){
    const a = document.createElement('a');
    a.href = href; a.download = filename || 'lingjing-download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // 延迟移除 <a> + 回收 objectURL,给浏览器留出异步抓取窗口(过早回收会闪一下就没)
    setTimeout(()=>{ a.remove(); if(revokeUrl) URL.revokeObjectURL(revokeUrl); }, 4000);
  }
  window.LJDownload = async function(url, filename){
    if(!url) return false;
    // 同源(下载代理端点)→ 直接 <a download>,无需 fetch
    if(isSameOrigin(url)){ clickAnchor(url, filename); return true; }
    // 跨域兜底:fetch → blob → 同源 objectURL
    try{
      const r = await fetch(url, { credentials:'same-origin' });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const blob = await r.blob();
      const u = URL.createObjectURL(blob);
      clickAnchor(u, filename, u);
      return true;
    }catch(e){
      window.open(url, '_blank', 'noopener'); // 最终回落:新窗口(用户可右键另存)
      return false;
    }
  };

  /**
   * 批量下载多个文件(串行 + 间隔),用于一条记录多图。
   * items: [{url, filename}, ...]
   */
  window.LJDownloadAll = async function(items){
    if(!items || !items.length) return;
    let ok = 0;
    for(let i=0; i<items.length; i++){
      const done = await window.LJDownload(items[i].url, items[i].filename);
      if(done) ok++;
      if(i < items.length-1) await new Promise(r=>setTimeout(r, 600)); // 间隔避免浏览器拦截
    }
    window.LJToast && window.LJToast(
      items.length>1 ? `✓ 已开始下载 ${items.length} 个文件` : '✓ 已开始下载'
    );
  };

  /**
   * 共享音色试听器(单例 <audio>)。voices.html / tts.html 声音面板共用。
   * 行为:点 ▶ 播放、再点 ■ 停;切到另一卡自动停上一个;ended 自动复位图标。
   * 按钮图标在 ▶/■ 间切换(播放图标内置,调用方无需传 SVG)。
   * play(url, btn): 播放 url,btn 切 ■;若 btn 正在播则停。
   * stop(): 停止并复位当前按钮。
   */
  window.LJAudioPreview = (function(){
    const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    let audio = null, curBtn = null;
    function ensure(){
      if(!audio){
        audio = document.createElement('audio');
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.addEventListener('ended', stop);
      }
      return audio;
    }
    function stop(){
      try{ if(audio) audio.pause(); }catch(_){}
      if(curBtn){ curBtn.innerHTML = PLAY; curBtn = null; }
    }
    function play(url, btn){
      if(curBtn === btn){ stop(); return; }   // 再点同一个 → 停
      stop();                                  // 切卡 → 先停上一个
      if(!url){ window.LJToast && window.LJToast('暂无试听样本','err'); return; }
      const a = ensure();
      a.src = url;
      a.play().then(()=>{ btn.innerHTML = STOP; curBtn = btn; })
        .catch((e)=>{
          // 区分:样本文件不存在/取不到(load 失败)vs 其它。预置样本缺失最常见
          // (存储里没跑过 seed-preset-samples)→ 给可读且可行动的提示。
          const loadFailed = a.error && (a.error.code === 4 /*SRC_NOT_SUPPORTED*/ || a.error.code === 2 /*NETWORK*/) || (e && e.name === 'NotSupportedError');
          const msg = loadFailed ? '试听样本暂不可用(样本未生成或链接失效)' : '试听失败,请稍后重试';
          window.LJToast && window.LJToast(msg, 'err');
        });
    }
    return { play, stop, PLAY_SVG: PLAY, STOP_SVG: STOP };
  })();

  bindAuth();
})();
