// 生成静态侧边栏 HTML 并内联到各页面的 #shell-mount。
//
// 为什么:侧边栏原由 shell.js 用 JS 注入,Chrome/Arc 会在脚本运行前先绘制空左栏 →
// 每次切页菜单弹出闪烁。把菜单 HTML 静态写进每页(首帧即有菜单)→ 所有浏览器 0 闪。
// shell.js 改为只增强(active 高亮、品牌覆盖、余额、工具组角色调整),不再注入侧栏。
//
// 单一真源:nav 链接定义在本文件;创作工具组从 tools.js 的 TOOLS 数组解析(不另写一套)。
// 菜单改版后重跑:`node prototype/build-sidebar.mjs`,各页 <!--SIDEBAR:START/END--> 块幂等重写。

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));

// —— 图标(与 shell.js 的 I 表一致)——
const I = {
  explore: '<circle cx="12" cy="12" r="9"/><path d="m15 9-3.5 1.5L10 14l3.5-1.5L15 9Z"/>',
  assets: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  billing: '<path d="M3 3v18h18"/><path d="m7 14 3-4 4 3 4-6"/>',
  orders: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  invoices: '<path d="M5 3h11l3 3v15l-2-1.2L15 21l-2-1.2L11 21l-2-1.2L7 21l-2-1.2V3Z"/><path d="M8 8h7M8 12h7M8 16h4"/>',
  members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
};
const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ic = (p) => svg(I[p]);

// nav 链接。active 按页面 data-page 在生成时静态烘焙(首帧即高亮,不靠 JS),
// 消除 Safari/Chrome 下「切页后高亮慢一拍」的闪烁。
const link = (p, label, href, cur) =>
  `<a class="sb-item${p === cur ? ' active' : ''}" data-page="${p}" href="${href}" data-label="${label}">${ic(p)}<span>${label}</span></a>`;

// —— 创作工具组:从 tools.js 解析 TOOLS(单一真源)——
function parseTools() {
  const src = readFileSync(join(DIR, 'tools.js'), 'utf8');
  // 提取 TOOLS 数组字面量并 eval(纯数据,无副作用)。
  const m = src.match(/const TOOLS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('无法从 tools.js 解析 TOOLS 数组');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}
function toolHref(t) {
  return t.enabled && t.page ? t.page : `tool.html?tool=${encodeURIComponent(t.key)}`;
}
function buildToolItems(tools, cur) {
  return tools.filter((t) => !t.hideInNav).map((t) => {
    let suffix = '';
    if (t.badge) suffix = `<span class="${t.badge.kind === 'nano' ? 'nano' : 'nbadge'}">${t.badge.text}</span>`;
    else if (!t.enabled) suffix = `<span class="soon">即将上线</span>`;
    const on = t.key === cur ? ' active' : '';
    return `<a class="sb-item sb-tool${on}" data-page="${t.key}" href="${toolHref(t)}" data-label="${t.label}" data-requires-create>${svg(t.icon)}<span>${t.label}</span>${suffix}</a>`;
  }).join('');
}

// —— 默认品牌(static:shell.js 会按 localStorage 缓存运行时覆盖为机构真实名/Logo)——
const DEFAULT_MARK = `<svg viewBox="0 0 100 100" fill="none"><circle cx="37" cy="50" r="29" stroke="#0E0E0E" stroke-width="5"/><circle cx="63" cy="50" r="29" stroke="#0E0E0E" stroke-width="5"/><path d="M50 24.08 A29 29 0 0 1 50 75.92 A29 29 0 0 1 50 24.08 Z" fill="#0E0E0E"/></svg>`;

function buildSidebar(cur) {
  const tools = parseTools();
  const items =
    link('explore', '探索', 'explore.html', cur) +
    link('assets', '我的资产', 'assets.html', cur) +
    `<div class="sb-group">创作工具</div>` +
    `<div id="sb-tools">${buildToolItems(tools, cur)}</div>` +
    `<div class="sb-group">财务中心</div>` +
    link('billing', '用量计费', 'billing.html', cur) +
    link('orders', '充值订单', 'orders.html', cur) +
    link('invoices', '发票管理', 'invoices.html', cur) +
    `<div class="sb-group">经营管理</div>` +
    link('members', '成员与权限', 'members.html', cur) +
    link('settings', '系统设置', 'settings.html', cur);
  return `<aside class="sidebar">
<a class="sb-brand" href="explore.html" title="灵镜 · 探索">
<span class="logo-mark" id="lj-brand-mark">${DEFAULT_MARK}</span>
<span class="nm">Lingjing</span><span class="cjk">灵镜</span>
</a>
<nav class="sb-nav">${items}</nav>
</aside>
<script>/* 品牌即时渲染:此内联脚本紧跟 .sb-brand,解析到此即同步执行(早于首次绘制),
按 localStorage 缓存把默认「Lingjing 灵镜」改成机构真实名/Logo → Chrome/Safari 0 闪。
shell.js(defer)随后用 LJ.me() 校正并写回缓存。 */
(function(){try{var c=JSON.parse(localStorage.getItem('ljBrand')||'null');if(!c)return;
var b=document.currentScript.previousElementSibling;
var brand=b&&b.querySelector?b.querySelector('.sb-brand'):null;if(!brand)return;
if(c.showName){var nm=brand.querySelector('.nm'),cj=brand.querySelector('.cjk');if(nm)nm.textContent=c.showName;if(cj)cj.style.display='none';brand.title=c.showName;}
if(c.logoUrl){var m=brand.querySelector('#lj-brand-mark');if(m){var img=new Image();img.src=c.logoUrl;img.style.cssText='width:100%;height:100%;object-fit:contain;border-radius:7px';img.onload=function(){m.innerHTML='';m.appendChild(img);};}}
}catch(e){}})();
</script>`;
}

// —— 内联进各页 #shell-mount(START/END 标记间幂等重写)——
const START = '<!--SIDEBAR:START 由 build-sidebar.mjs 生成,勿手改-->';
const END = '<!--SIDEBAR:END-->';

function injectInto(file, sidebar) {
  let html = readFileSync(join(DIR, file), 'utf8');
  if (!/id="shell-mount"/.test(html)) return 'skip(no-mount)';
  const block = `${START}\n${sidebar}\n${END}`;
  if (html.includes(START) && html.includes(END)) {
    // 幂等替换已有块
    html = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  } else {
    // 首次:在 shell-mount 开标签后、.main-col 前插入
    html = html.replace(
      /(<div class="shell" id="shell-mount">\s*)/,
      `$1\n${block}\n`,
    );
  }
  writeFileSync(join(DIR, file), html);
  return 'ok';
}

const EXCLUDE = new Set(['login.html']); // 无壳页
const pages = readdirSync(DIR).filter(
  (f) => f.endsWith('.html') && !EXCLUDE.has(f) && readFileSync(join(DIR, f), 'utf8').includes('id="shell-mount"'),
);
// 每页按其 <body data-page="..."> 静态烘焙对应菜单的 active 高亮 → 首帧即高亮。
const results = pages.map((f) => {
  const html = readFileSync(join(DIR, f), 'utf8');
  const cur = (html.match(/<body[^>]*\bdata-page="([^"]*)"/) || [])[1] || '';
  return `${f}: ${injectInto(f, buildSidebar(cur))} (active=${cur || '—'})`;
});
console.log(`生成侧边栏并内联 ${pages.length} 页:`);
console.log(results.join('\n'));
