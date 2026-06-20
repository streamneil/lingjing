// 共享左侧导航 — 各页 <body data-page="..."> 决定高亮(工具页用 tools.js 的 key 当 data-page)
(function(){
  // 全局 popover 关闭:点击 .pop-anchor 之外的任意区域 → 关闭所有打开的 modelPill/setPill/seed 弹框。
  // 不依赖每页的 .pop-ov 透明遮罩(z-index 边界 case 下遮罩可能被更高层元素挡住吞掉点击)。
  // 用 mousedown 捕获,比 click 更早、更稳;点击弹框内部(.pop)或锚点(.pop-anchor)不关闭。
  document.addEventListener('mousedown', (e)=>{
    if (!document.querySelector('.pop.show')) return; // 无打开的弹框,快速返回
    // 点在 pill 锚点(.pop-anchor)或弹框内部(.pop)→ 不关。
    // 关键:弹框可能被 portal 到 body(.pop-portal,逃离 .cfg 裁剪),此时已不在 .pop-anchor 内,
    // 必须再判 .closest('.pop'),否则点选项时 mousedown 先关掉弹框 → mouseup/click 落空 → 「点不中」。
    if (e.target.closest('.pop-anchor') || e.target.closest('.pop')) return;
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
    orders: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
    invoices: '<path d="M5 3h11l3 3v15l-2-1.2L15 21l-2-1.2L11 21l-2-1.2L7 21l-2-1.2V3Z"/><path d="M8 8h7M8 12h7M8 16h4"/>',
    members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  };
  const svg = inner => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ic = p => svg(I[p]);

  // 品牌即时渲染辅助(供同步模板 + onerror 回退用,挂到 window 方便 inline 调用)。
  function ljEscapeBrand(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  const __DEFAULT_MARK_SVG = `<svg viewBox="0 0 100 100" fill="none"><circle cx="37" cy="50" r="29" stroke="#0E0E0E" stroke-width="5"/><circle cx="63" cy="50" r="29" stroke="#0E0E0E" stroke-width="5"/><path d="M50 24.08 A29 29 0 0 1 50 75.92 A29 29 0 0 1 50 24.08 Z" fill="#0E0E0E"/></svg>`;
  function ljDefaultMarkSVG(){ return __DEFAULT_MARK_SVG; }
  // 缓存 logo 加载失败时回退默认图标(img.onerror inline 调用)。
  window.ljDefaultMark = function(){ const s=document.createElement('span'); s.innerHTML=__DEFAULT_MARK_SVG; return s.firstChild; };
  const cur = document.body.dataset.page;
  // data-label:折叠态(≤1000px)hover 飞出标签用(span 此时被隐藏)。
  const link = (p, label, href, extra) =>
    `<a class="sb-item ${p===cur?'active':''}" href="${href}" data-label="${label}"${extra||''}>${ic(p)}<span>${label}</span></a>`;

  // 创作工具组:从 tools.js 注册表渲染(唯一真源)。徽章/即将上线角标随描述符。
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

  const __mount = document.getElementById('shell-mount');

  // 侧边栏现已静态内联进各页 HTML(build-sidebar.mjs 生成)→ 首帧即有菜单,
  // 所有浏览器 0 闪。shell.js 不再注入侧栏,只「增强」:设 active 高亮 + 品牌覆盖。
  // 兜底:万一某页没有静态侧栏(漏生成),仍按旧逻辑动态注入,保证不白屏。
  let __sidebar = __mount.querySelector('.sidebar');
  if (!__sidebar) {
    const items =
      link('explore','探索','explore.html') +
      link('assets','我的资产','assets.html') +
      `<div class="sb-group">创作工具</div>` +
      `<div id="sb-tools">${buildToolItems()}</div>` +
      `<div class="sb-group">财务中心</div>` +
      link('billing','用量计费','billing.html') +
      link('orders','充值订单','orders.html') +
      link('invoices','发票管理','invoices.html') +
      `<div class="sb-group">经营管理</div>` +
      link('members','成员与权限','members.html') +
      link('settings','系统设置','settings.html');
    __mount.insertAdjacentHTML('afterbegin', `
    <aside class="sidebar">
      <a class="sb-brand" href="explore.html" title="灵镜 · 探索">
        <span class="logo-mark" id="lj-brand-mark">${ljDefaultMarkSVG()}</span>
        <span class="nm">Lingjing</span><span class="cjk">灵镜</span>
      </a>
      <nav class="sb-nav">${items}</nav>
    </aside>`);
    __sidebar = __mount.querySelector('.sidebar');
  }
  __mount.classList.add('sb-ready');

  // 当前页高亮:静态侧栏的 .sb-item 不带 active,这里按 data-page 加(工具页用工具 key)。
  if (cur) {
    const activeItem = __sidebar.querySelector(`.sb-item[data-page="${cur}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  // 品牌即时渲染:整页重载时先读上次缓存的机构品牌,同步覆盖静态默认「Lingjing 灵镜」
  // → 缓存命中 0 闪。LJ.me() 返回后(bindAuth)写回缓存并按需校正,几乎总相同。
  let __brandCache = null;
  try { __brandCache = JSON.parse(localStorage.getItem('ljBrand') || 'null'); } catch {}
  if (__brandCache && (__brandCache.showName || __brandCache.logoUrl)) {
    const brandEl = __sidebar.querySelector('.sb-brand');
    if (brandEl) {
      if (__brandCache.showName) {
        const nm = brandEl.querySelector('.nm'), cjk = brandEl.querySelector('.cjk');
        if (nm) nm.textContent = __brandCache.showName; // textContent 防 XSS
        if (cjk) cjk.style.display = 'none';
        brandEl.title = __brandCache.showName;
      }
      if (__brandCache.logoUrl) {
        const mark = brandEl.querySelector('#lj-brand-mark');
        if (mark) {
          const img = new Image();
          img.src = __brandCache.logoUrl;
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:7px';
          img.onload = () => { mark.innerHTML = ''; mark.appendChild(img); };
          // onerror:保留默认 SVG
        }
      }
    }
  }

  // 创作工具组:现已静态内联(build-sidebar.mjs)→ #sb-tools 首帧即有项,本函数空转返回。
  // 兜底:仅当静态项缺失(旧页/漏生成)才等 LJTools 动态填充。
  function fillTools(){
    const host = document.getElementById('sb-tools');
    if (!host || host.children.length) return; // 已有静态工具项 → 无需做事
    if (!window.LJTools) { setTimeout(fillTools, 30); return; }
    host.innerHTML = buildToolItems();
    // 兜底动态渲染的工具项也要按 data-page 高亮当前页。
    if (cur) { const a = host.querySelector(`.sb-item[data-page="${cur}"]`); if (a) a.classList.add('active'); }
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
        剩余 <b class="num" id="lj-balance">—</b><a href="recharge.html" class="topup">充值</a>
      </div>
      <div class="lj-acc-wrap" style="position:relative">
        <div class="avatar-btn" id="lj-account" title="账号">融</div>
        <div id="lj-menu" style="display:none;position:absolute;right:0;top:46px;width:220px;background:var(--modal,#161618);border:1px solid var(--line,#232327);border-radius:14px;box-shadow:var(--sh-pop);padding:7px;z-index:200">
          <div id="lj-menu-head" style="padding:11px 12px 10px;border-bottom:1px solid var(--line-soft,#1A1A1D);margin-bottom:6px">
            <div id="lj-menu-name" style="font-size:14px;font-weight:600;color:var(--t1)">…</div>
            <div id="lj-menu-role" style="font-size:11.5px;color:var(--t3);margin-top:2px;font-family:var(--f-mono)"></div>
          </div>
          <button class="lj-mi" data-act="account">账户</button>
          <button class="lj-mi" data-act="pricing">定价</button>
          <button class="lj-mi" data-act="logout" style="color:var(--red)">登出</button>
        </div>
      </div>
    </header>`;
  const mc = document.querySelector('.main-col');
  if (mc) mc.insertAdjacentHTML('afterbegin', bar);

  // 账号菜单项样式 + 全站弹窗(LJConfirm/LJPrompt 用)+ toast。
  // 注:个人信息/改密码的静态弹窗实例已迁到独立页 account.html;但 .lj-ov/.lj-modal
  //     样式仍由 LJConfirm/LJPrompt(ljBuildOverlay)动态复用 —— 全站登出确认、定价咨询输入都靠它。
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

  // 登录态:拉当前用户填充机构名/账号;未登录 api.js 会跳 login。
  // 注意 shell.js 在 api.js 之前注入,这里延迟到 LJ 就绪后执行。
  const ROLE_CN = {admin:'管理员',creator:'创作者'};
  function bindAuth(){
    if (!window.LJ) { setTimeout(bindAuth, 30); return; }
    LJ.me().then(u => {
      window.__ljRole = u.role; // 当前角色(管理员/创作者)
      const acc = document.getElementById('lj-account');
      const menu = document.getElementById('lj-menu');
      const display = u.displayName || u.username;
      // 机构品牌:已自定义(设过 logo 或改过名)→ 换侧边栏顶部名称 + Logo。
      // isCustomBranded 由服务端判定(单一真相源),前端不字符串比 '我的机构'。
      // 缓存即时渲染:同步阶段已按 localStorage.ljBrand 渲染过;此处只在「真实值
      // 与已渲染缓存不同」时才改 DOM(几乎总相同 → 无可见跳变),并写回缓存供下次切页。
      const showName = u.isCustomBranded ? (u.brandName || u.tenantName) : '';
      const logoUrl = u.orgLogoKey
        ? '/api/org-logo/' + u.tenantId + '?v=' + encodeURIComponent(u.logoVer || '')
        : '';
      // 写回缓存(无自定义则清空 → 防换账号后串用上家品牌)。
      try {
        if (showName || logoUrl) localStorage.setItem('ljBrand', JSON.stringify({ showName, logoUrl }));
        else localStorage.removeItem('ljBrand');
      } catch {}

      const brand = document.querySelector('.sb-brand');
      if (brand) {
        const nm = brand.querySelector('.nm'), cjk = brand.querySelector('.cjk');
        // 名称:与当前渲染不同才改(缓存命中时通常已正确)。
        const wantName = showName || 'Lingjing';
        if (showName) {
          brand.title = showName;
          if (nm && nm.textContent !== wantName) nm.textContent = wantName;
          if (cjk && cjk.style.display !== 'none') cjk.style.display = 'none';
        }
      }
      // 机构 Logo:有则替换默认品牌图标;缓存命中时 src 已一致,onload 不会造成可见跳变。
      if (logoUrl) {
        const mark = document.getElementById('lj-brand-mark');
        const curImg = mark && mark.querySelector('img');
        // 已是同一 logo(缓存命中)→ 不重复换,避免无谓闪一下。
        if (mark && !(curImg && curImg.getAttribute('src') === logoUrl)) {
          const img = new Image();
          img.src = logoUrl;
          img.alt = u.tenantName || '机构';
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:7px';
          img.onload = () => { mark.innerHTML = ''; mark.appendChild(img); };
          // onerror:不替换,保留当前图标
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
        // 账户/定价改为独立页跳转(原弹窗式个人信息/改密码已迁到 account.html)。
        if (act==='logout'){ if(!(await window.LJConfirm({title:'登出',body:'确认要退出当前账号吗?',confirmText:'登出',danger:true})))return; try{await LJ.logout();}catch{} try{localStorage.removeItem('ljBrand');}catch{} location.href='login.html'; }
        else if (act==='account'){ location.href='account.html'; }
        else if (act==='pricing'){ location.href='pricing.html'; }
      });
      // 角色精简为 管理员/创作者,两者都可创作 → 无需隐藏创作入口(原 viewer 隐藏逻辑已移除)。
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

  /* ── 弹框定位:portal 到 body 顶层 + 按 pill 定位(居左弹出、不被 .cfg/侧栏遮挡)──
   * 各模块 setPill 等弹框统一调用,避免被左栏 overflow/层叠上下文裁切。
   * LJPlacePop(pop, pill): 把 pop 移到 body、fixed 定位(右沿对齐 pill 右沿向左铺,
   *   贴 pill 上沿向上;放不下则下方/夹紧内滚)。LJUnplacePop(pop): 关闭时归还原位 + 清样式。 */
  window.LJPlacePop = function(pop, pill){
    if(!pop || !pill) return;
    const r = pill.getBoundingClientRect(), M = 8, GAP = 8, vw = window.innerWidth, vh = window.innerHeight;
    if(!pop._ljHome) pop._ljHome = pop.parentNode;
    document.body.appendChild(pop);
    pop.classList.add('lj-pop-portal');
    pop.style.visibility = 'hidden'; pop.style.left = '0'; pop.style.right = 'auto'; pop.style.top = '0'; pop.style.bottom = 'auto'; pop.style.maxHeight = '';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.max(M, r.right - pw);                 // 右沿对齐 pill 右沿(居左铺)
    let top = r.top - GAP - ph;                           // 贴 pill 上沿向上
    if(top < M){ const below = r.bottom + GAP; top = (below + ph <= vh - M) ? below : M; if(top === M) pop.style.maxHeight = (vh - 2*M) + 'px'; }
    pop.style.left = left + 'px'; pop.style.top = Math.max(M, top) + 'px'; pop.style.visibility = '';
  };
  window.LJUnplacePop = function(pop){
    if(!pop) return;
    pop.classList.remove('lj-pop-portal');
    pop.style.left = pop.style.right = pop.style.top = pop.style.bottom = pop.style.maxHeight = pop.style.visibility = '';
    if(pop._ljHome && pop.parentNode !== pop._ljHome) pop._ljHome.appendChild(pop);
  };

  bindAuth();

  // 示范素材兜底:/api/showcase-asset 图若加载失败(极少 —— 镜像自带 + 桶兜底),用中性占位替换,
  // 绝不露浏览器「裂图」图标(落地第一印象)。捕获阶段(img error 不冒泡),一次性防循环。
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.ljFallback) return;
    if (!/\/api\/showcase-asset\//.test(img.currentSrc || img.src || '')) return;
    img.dataset.ljFallback = '1';
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#1a1a1d"/>'
      + '<path d="M20 40l8-9 6 6 6-8 6 11z" fill="#3a3a40"/><circle cx="24" cy="22" r="4" fill="#3a3a40"/></svg>');
    img.style.objectFit = 'cover';
  }, true);
})();
