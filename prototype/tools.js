// 灵镜 创作工具描述符注册表 —— 多工具平台的唯一真源。
//
// 决策来源:/plan-eng-review E1/E2/E4 + /plan-ceo-review SCOPE_REDUCTION。
//
// 「工具页共壳」的行为层契约:shell.js(侧栏)/ explore.html(首屏卡)/ tool.html
// (工作区)全部从这一份数组读,不各写一套。后续接第 N 个工具 = 往这里加一条 + 实现它的
// 左面板 renderer,壳零改动。
//
// 字段:
//   key        URL/页面键(?tool=key),也是 data-page 高亮键
//   label      中文名(侧栏 + 卡片 + 面包屑)
//   icon       侧栏/卡片 line-icon 的 <svg> 内层 path(viewBox 0 0 24 24)
//   badge      可选角标:{text,kind}  kind: 'new'(蓝)| 'nano'(灰描边)
//   enabled    是否已接后端。false → 工作区显「即将上线」、创建置灰、不调 /jobs。
//              决策来源:E3/外部声音 P1 —— UI 不开空头支票(唯一 /jobs 硬要 avatar/voice/script)。
//   outputKind 产物类型 'video'|'image'|'audio' —— 右画廊按此渲染(非永远 <video>)。E4。
//   page       已接工具的工作区页面(enabled=true 才用;未接走通用 tool.html 占位)。
//   tier       /plan-ceo-review 分档:'live'(已上线)|'next'(接)|'later'(缓)|'parked'(划)。
//              仅作路线图记录,不影响前端行为(行为只看 enabled)。
//
// ⚠️ 接后端前置硬约束(见计划「后端前置约束」表):worker.processJob 须按 job.type 分发、
//    gateway 泛化、estimateCost 改 per-toolType。本表只管前端;enabled 翻 true 前那些必须先就位。

(function () {
  // 内层 path 复用 shell.js 同款 line-icon 约定(stroke=currentColor stroke-width≈1.7)
  const TOOLS = [
    {
      key: 'ref-video', label: '参考生成影片',
      icon: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 9 4-2v10l-4-2"/><path d="m8 10 2 2-2 2"/>',
      badge: { text: '新', kind: 'new' }, enabled: false, outputKind: 'video', tier: 'later',
    },
    {
      key: 'img2video', label: '图片转影片',
      icon: '<rect x="3" y="4" width="14" height="14" rx="2"/><circle cx="8" cy="9" r="1.6"/><path d="m4 16 4-4 3 3"/><path d="m17 10 4-2v10l-4-2"/>',
      enabled: false, outputKind: 'video', tier: 'next',
    },
    {
      key: 'text2video', label: '文字转影片',
      icon: '<path d="M5 6h14M9 6v12M7 18h4"/><path d="m16 11 4-2v8l-4-2"/>',
      enabled: false, outputKind: 'video', tier: 'later',
    },
    {
      key: 'ai-image', label: 'AI 图片',
      icon: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m5 17 4-4 3 3 3-3 4 4"/>',
      badge: { text: 'Nano Banana', kind: 'nano' }, enabled: false, outputKind: 'image', tier: 'next',
    },
    {
      key: 'ai-image-edit', label: 'AI 图片编辑器',
      icon: '<rect x="4" y="4" width="13" height="13" rx="2"/><path d="m5 15 3-3 2 2"/><path d="M14 18.5 19 13.5l2.5 2.5-5 5H14v-2.5Z"/>',
      enabled: false, outputKind: 'image', tier: 'later',
    },
    {
      key: 'ai-video-edit', label: 'AI 影片编辑器',
      icon: '<rect x="3" y="5" width="14" height="13" rx="2"/><path d="m8 9 4 2.5L8 14V9Z"/><path d="M15 18.5 20 13.5l2 2-5 5H15v-2.5Z"/>',
      enabled: false, outputKind: 'video', tier: 'later',
    },
    {
      key: 'ai-avatar', label: 'AI 虚拟人',
      icon: '<circle cx="12" cy="8" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>',
      enabled: true, outputKind: 'video', page: 'create.html', tier: 'live',
    },
    {
      key: 'ai-music', label: 'AI 音乐',
      icon: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
      enabled: false, outputKind: 'audio', tier: 'parked',
    },
    {
      key: 'tts', label: '文字转语音',
      icon: '<path d="M4 11v2M8 7v10M12 4v16M16 8v8M20 11v2"/>',
      enabled: false, outputKind: 'audio', tier: 'next',
    },
  ];

  // 工具工作区入口:已接 → 自己的页面;未接 → 通用占位页带 ?tool=key(显「即将上线」)。
  function toolHref(t) {
    return t.enabled && t.page ? t.page : `tool.html?tool=${encodeURIComponent(t.key)}`;
  }

  function getTool(key) {
    return TOOLS.find((t) => t.key === key) || null;
  }

  window.LJTools = { list: TOOLS, get: getTool, href: toolHref };
})();
