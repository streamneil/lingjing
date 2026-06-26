// 灵镜 拼图缺口行为验证组件 — canvas 背景 + 缺口 + 可拖拼图块,块对齐缺口过验后回调 captchaToken。
// 租户登录(login.html)与超管登录(admin-login.html)共用。
//
// 协议:GET /api/captcha/challenge 拿 {challengeId, trackW, gapX, pieceY};用户把拼图块拖到缺口
// (服务端按 |x-gapX|≤容差 判过);POST /api/captcha/verify {challengeId, x} 校验落点,过则发一次性 token。
//
// 坐标:拖动手柄得比例 r∈[0,1];piece 屏幕左 = r·(imageW-pieceW),提交服务端坐标 x = r·(trackW-PIECE_W)。
// 二者用同一 r → piece 视觉对齐缺口时,提交 x 恰为 gapX(服务端坐标)。客户端已知 gapX,落点不准时本地回弹
// 不打服务端(不浪费 challenge)。注:gapX 下发前端,本控件是约定/视觉/信任层,非强 bot 防护
// (密码暴破真墙是 /login 失败限频 login-throttle,短信侧是每日上限)。
//
// 无障碍:手柄 role=slider + aria-value* + ←/→ 步进 + Enter/Space 提交;「换一张」刷新。
// 用法:LJCaptcha.mount(containerEl, { onPass(token), onReset() })

window.LJCaptcha = (function () {
  const HANDLE_W = 44;     // 底部滑轨手柄宽
  const PIECE_W = 46;      // 拼图块视觉宽(屏幕 px)
  const TRACK_W_REF = 280; // 服务端参考轨宽(与 platform.ts CAPTCHA_TRACK_W 对齐)
  const PIECE_W_REF = 44;  // 服务端参考块宽(与 platform.ts CAPTCHA_PIECE_W 对齐)
  const IMG_H = 150;       // 背景图高
  const TOL_SRV = 8;       // 服务端容差(与 platform.ts CAPTCHA_GAP_TOL 对齐),本地预判用
  const KEY_STEP = 4;      // 键盘每步像素(手柄坐标)
  // 内置背景图(prototype/captcha-bg/,经 /captcha-bg/ 公开访问;png/jpg 混用、尺寸不一均可,
  // 组件按 cover 居中裁剪到展示区)。每次出题随机一张;任一图 404 自动回退程序化图案。
  const BG_IMAGES = [
    '1.png', '2.png', '3.png', '4.png', '5.png', '6.png', '7.png', '8.png',
    '9.jpg', '10.png', '11.png', '12.jpg', '13.png',
  ].map((n) => '/captcha-bg/' + n);

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return; styleInjected = true;
    const css = `
    .ljcp{user-select:none;touch-action:none;height:${IMG_H + 10 + 46}px}
    .ljcp-img{position:relative;width:100%;height:${IMG_H}px;border-radius:12px;overflow:hidden;border:1px solid var(--line,#232327);background:var(--field,#101012)}
    .ljcp-bg{display:block;width:100%;height:100%}
    .ljcp-piece{position:absolute;top:0;left:0;width:${PIECE_W}px;height:${PIECE_W}px;pointer-events:none;filter:drop-shadow(0 3px 8px rgba(0,0,0,.55));will-change:left}
    .ljcp-rail{position:relative;height:46px;margin-top:10px;border-radius:12px;background:var(--field,#101012);border:1px solid var(--line,#232327);overflow:hidden}
    .ljcp-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,rgba(77,141,255,.10),rgba(77,141,255,.22))}
    .ljcp-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--t3,#717179);pointer-events:none;letter-spacing:.3px;padding-left:${HANDLE_W}px}
    .ljcp-hint .arrows{display:inline-flex;margin-left:8px;color:var(--t4,#4A4A51);animation:ljcp-nudge 1.4s ease infinite}
    @keyframes ljcp-nudge{0%,100%{transform:translateX(0);opacity:.5}50%{transform:translateX(4px);opacity:1}}
    .ljcp-handle{position:absolute;left:3px;top:3px;bottom:3px;width:${HANDLE_W}px;border-radius:9px;background:linear-gradient(180deg,#fff,#E9E9EE);display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 3px 10px -2px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.6) inset;z-index:2;outline:none}
    .ljcp-handle:focus-visible{box-shadow:0 0 0 2px var(--blue,#4D8DFF),0 3px 10px -2px rgba(0,0,0,.5)}
    .ljcp-handle:active{cursor:grabbing}
    .ljcp-handle svg{color:#0A0A0B}
    .ljcp.ljcp-ok .ljcp-rail{border-color:var(--green,#34C759)}
    .ljcp.ljcp-ok .ljcp-fill{background:rgba(52,199,89,.16)}
    .ljcp.ljcp-ok .ljcp-handle{background:linear-gradient(180deg,#3DDc6A,#2BA84C)}
    .ljcp.ljcp-ok .ljcp-handle svg{color:#fff}
    .ljcp.ljcp-ok .ljcp-hint{color:var(--green,#34C759);padding-left:0}
    .ljcp.ljcp-err .ljcp-rail{border-color:var(--red,#FF5247);animation:ljcp-shake .35s}
    .ljcp.ljcp-err .ljcp-handle{background:linear-gradient(180deg,#FF6B61,#E5392E)}
    @keyframes ljcp-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
    .ljcp-refresh{position:absolute;top:6px;right:6px;z-index:3;width:28px;height:28px;border-radius:8px;border:1px solid var(--line,#232327);background:rgba(0,0,0,.45);color:var(--t2,#c8c8cf);display:flex;align-items:center;justify-content:center;cursor:pointer}
    .ljcp-refresh:hover{color:var(--t1,#fff)}`;
    const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
  }

  const ARROW_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l6 6-6 6M13 6l6 6-6 6"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>';
  const REFRESH_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';

  // 种子 PRNG(challengeId → 确定性背景图,使「缺口/拼图块」是同一张图的挖空与填回)。
  function seeded(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    return function () { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  }
  // 把背景图案画到任意 ctx(bg 与 piece 用同一图案 + 同偏移 → 块能视觉填回缺口)。
  function paintPattern(ctx, w, h, rnd) {
    const hue = Math.floor(rnd() * 360);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${hue},42%,30%)`); g.addColorStop(1, `hsl(${(hue + 60) % 360},42%,18%)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      const cx = rnd() * w, cy = rnd() * h, r = 18 + rnd() * 46;
      ctx.fillStyle = `hsla(${Math.floor(rnd() * 360)},55%,${40 + rnd() * 25}%,.30)`;
      ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // cover-fit:把图按"填满+居中裁剪"画进 dw×dh(任意比例的图都不变形)。
  function coverDraw(ctx, img, dw, dh) {
    const ir = img.width / img.height, dr = dw / dh;
    let sw, sh, sx, sy;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // 拼图形状(内接于 x,y,s,s 方框,不外溢 → 不改坐标)。同一 challenge 的缺口与拼图块用同一形状。
  const SHAPE_COUNT = 5; // 0 圆角方 / 1 圆 / 2 六边形 / 3 三角 / 4 菱形
  function shapePath(ctx, x, y, s, id) {
    if (id === 0) { roundRectPath(ctx, x + 1, y + 1, s - 2, s - 2, 8); return; }
    const cx = x + s / 2, cy = y + s / 2, r = s / 2 - 1;
    ctx.beginPath();
    if (id === 1) { ctx.arc(cx, cy, r, 0, Math.PI * 2); }
    else if (id === 2) { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3, px = cx + r * Math.cos(a), py = cy + r * Math.sin(a); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.closePath(); }
    else if (id === 3) { ctx.moveTo(cx, y + 2); ctx.lineTo(x + s - 2, y + s - 3); ctx.lineTo(x + 2, y + s - 3); ctx.closePath(); }
    else { ctx.moveTo(cx, y + 1); ctx.lineTo(x + s - 1, cy); ctx.lineTo(cx, y + s - 1); ctx.lineTo(x + 1, cy); ctx.closePath(); }
  }

  function mount(container, { onPass, onReset } = {}) {
    injectStyle();
    let challengeId = null, trackW = TRACK_W_REF, gapX = 0, pieceY = 0;
    let token = null, dragging = false, startX = 0, curX = 0, imgW = 0, bgImg = null;
    const HINT_DEFAULT = '拖动滑块完成拼图<span class="arrows">›››</span>'; // 滑轨提示恒定文案(不随错误/刷新切换)

    container.innerHTML = `
      <div class="ljcp">
        <div class="ljcp-img">
          <canvas class="ljcp-bg"></canvas>
          <canvas class="ljcp-piece" width="${PIECE_W}" height="${PIECE_W}"></canvas>
          <div class="ljcp-refresh" title="换一张" role="button" tabindex="0">${REFRESH_SVG}</div>
        </div>
        <div class="ljcp-rail">
          <div class="ljcp-fill"></div>
          <div class="ljcp-hint">${HINT_DEFAULT}</div>
          <div class="ljcp-handle" role="slider" tabindex="0" aria-label="拖动滑块把拼图填入缺口"
               aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">${ARROW_SVG}</div>
        </div>
      </div>`;

    const root = container.querySelector('.ljcp');
    const imgWrap = container.querySelector('.ljcp-img');
    const bg = container.querySelector('.ljcp-bg');
    const piece = container.querySelector('.ljcp-piece');
    const fill = container.querySelector('.ljcp-fill');
    const hint = container.querySelector('.ljcp-hint');
    const handle = container.querySelector('.ljcp-handle');
    const refresh = container.querySelector('.ljcp-refresh');
    const rail = container.querySelector('.ljcp-rail');

    function railTravel() { return rail.clientWidth - HANDLE_W - 6; }
    function ratio() { const t = railTravel(); return t > 0 ? curX / t : 0; }
    // 缺口屏幕左 = 比例 · (图宽-块宽);与提交坐标同比例 → 对齐时提交 x 恰为 gapX。
    function gapLeftPx() { return (gapX / (trackW - PIECE_W_REF)) * (imgW - PIECE_W); }
    function serverX() { return ratio() * (trackW - PIECE_W_REF); }

    function draw() {
      imgW = imgWrap.clientWidth || 300;
      const dpr = window.devicePixelRatio || 1;
      bg.width = imgW * dpr; bg.height = IMG_H * dpr; bg.style.width = imgW + 'px'; bg.style.height = IMG_H + 'px';
      const ctx = bg.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (bgImg) coverDraw(ctx, bgImg, imgW, IMG_H); // 内置图优先
      else paintPattern(ctx, imgW, IMG_H, seeded(challengeId || 'seed')); // 缺图回退程序化图案
      // 拼图块:从同一图案复制缺口区域(用第二个 rnd 重放同序列保证一致)。
      const pctx = piece.getContext('2d'); piece.width = PIECE_W * dpr; piece.height = PIECE_W * dpr;
      piece.style.width = PIECE_W + 'px'; piece.style.height = PIECE_W + 'px'; pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gl = gapLeftPx();
      // 每个 challenge 一个形状(缺口与拼图块同形);独立种子,不与背景图案 rnd 串扰。
      const shapeId = Math.floor(seeded((challengeId || 'seed') + ':s')() * SHAPE_COUNT);
      pctx.clearRect(0, 0, PIECE_W, PIECE_W);
      pctx.save(); shapePath(pctx, 0, 0, PIECE_W, shapeId); pctx.clip();
      pctx.drawImage(bg, gl * dpr, pieceY * dpr, PIECE_W * dpr, PIECE_W * dpr, 0, 0, PIECE_W, PIECE_W);
      pctx.restore();
      pctx.lineWidth = 1.5; pctx.strokeStyle = 'rgba(255,255,255,.7)'; shapePath(pctx, 0, 0, PIECE_W, shapeId); pctx.stroke();
      // 在背景上挖缺口(压暗 + 描边)—— 同一形状。
      ctx.save(); shapePath(ctx, gl, pieceY, PIECE_W, shapeId);
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.stroke(); ctx.restore();
      piece.style.top = pieceY + 'px';
      setX(curX);
    }

    async function load() {
      token = null; curX = 0;
      root.classList.remove('ljcp-ok', 'ljcp-err');
      try {
        const c = await LJ.get('/captcha/challenge');
        challengeId = c.challengeId; trackW = c.trackW || TRACK_W_REF; gapX = c.gapX; pieceY = c.pieceY || 20;
        handle.innerHTML = ARROW_SVG; handle.setAttribute('aria-disabled', 'false');
        hint.style.display = 'flex'; if (hint.innerHTML !== HINT_DEFAULT) hint.innerHTML = HINT_DEFAULT;
        // 背景图:随机选一张内置图,加载完重画;缺图(404)→ bgImg 留 null → 回退程序化图案。
        bgImg = null;
        const im = new Image();
        im.onload = () => { bgImg = im; if (!token) draw(); };
        im.onerror = () => { bgImg = null; };
        im.src = BG_IMAGES[Math.floor(Math.random() * BG_IMAGES.length)];
        draw();
        if (onReset) onReset();
      } catch (e) {
        hint.innerHTML = '验证加载失败,点此重试'; root.onclick = load;
      }
    }

    function setX(x) {
      curX = Math.max(0, Math.min(railTravel(), x));
      handle.style.left = (curX + 3) + 'px';
      fill.style.width = (curX + HANDLE_W) + 'px';
      piece.style.left = (ratio() * (imgW - PIECE_W)) + 'px';
      handle.setAttribute('aria-valuenow', Math.round(ratio() * 100));
      // 提示「拖动滑块完成拼图」恒显示(不随拖动隐藏),手柄滑过其上即可 —— 杜绝消失再显示。
    }

    async function submit() {
      // 本地预判:提交坐标在容差内才打服务端。没对准 → 滑块弹回(不隐藏)+ 自动换一张新题。
      // 没对准:只抖动反馈(不改提示文案,避免「拖动滑块完成拼图」消失再显示)+ 弹回 + 自动换一张。
      if (Math.abs(serverX() - gapX) > TOL_SRV) { flashErr(); snapBack(); setTimeout(load, 700); return; }
      try {
        const r = await LJ.post('/captcha/verify', { challengeId, x: serverX() });
        token = r.captchaToken;
        root.classList.add('ljcp-ok'); handle.innerHTML = CHECK_SVG;
        handle.setAttribute('aria-disabled', 'true');
        hint.style.display = 'flex'; hint.innerHTML = '验证通过';
        if (onPass) onPass(token);
      } catch (e) {
        flashErr(); setTimeout(load, 500); // 失败(多为过期)→ 换新题
      }
    }

    function flashErr(msg) {
      root.classList.add('ljcp-err');
      if (msg) { hint.style.display = 'flex'; hint.innerHTML = msg; }
      setTimeout(() => root.classList.remove('ljcp-err'), 400);
    }
    function snapBack() {
      handle.style.transition = 'left .2s ease'; piece.style.transition = 'left .2s ease';
      curX = 0; setX(0);
      hint.style.display = 'flex';
      setTimeout(() => { handle.style.transition = ''; piece.style.transition = ''; }, 220);
    }

    function release() {
      if (!dragging) return;
      dragging = false;
      const t = railTravel();
      if (curX < 6) { snapBack(); return; } // 几乎没动:回弹不打服务端
      void submit();
    }
    function onDown(e) {
      if (token) return;
      dragging = true; handle.focus();
      startX = (e.touches ? e.touches[0].clientX : e.clientX) - curX;
    }
    function onMove(e) {
      if (!dragging) return;
      const cx = (e.touches ? e.touches[0].clientX : e.clientX);
      setX(cx - startX);
    }
    // 键盘无障碍:←/→ 步进,Enter/Space 在当前位置提交。
    function onKey(e) {
      if (token) return;
      if (e.key === 'ArrowRight') { setX(curX + KEY_STEP); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setX(curX - KEY_STEP); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (curX > 6) void submit(); }
    }

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mouseup', release);
    window.addEventListener('touchend', release);
    handle.addEventListener('keydown', onKey);
    refresh.onclick = load;
    refresh.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); load(); } };
    window.addEventListener('resize', () => { if (!token) draw(); });

    load();
    return { reset: load, getToken: () => token };
  }

  return { mount };
})();
