// 灵镜 滑块行为验证组件 — 渲染拖拽滑块,过验后回调 captchaToken。
// 租户登录(login.html)与超管登录(admin-login.html)共用。
//
// 协议:GET /api/captcha/challenge 拿 {challengeId, gapX, trackW};用户把滑块拖到
// 缺口位置(gapX);POST /api/captcha/verify {challengeId, x} 校验落点,过则发一次性 token。
// 服务端比对自己存的 target_x,前端篡改返回值无用(真挡无头脚本:无 token → 登录 400)。
//
// 用法:LJCaptcha.mount(containerEl, { onPass(token), onReset() })

window.LJCaptcha = (function () {
  const HANDLE_W = 44;

  // 一次性注入组件样式(避免依赖宿主页 CSS 变量缺失)。
  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return; styleInjected = true;
    const css = `
    .ljc{position:relative;height:46px;border-radius:12px;background:var(--field,#101012);border:1px solid var(--line,#232327);overflow:hidden;user-select:none;touch-action:none}
    .ljc-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,rgba(77,141,255,.10),rgba(77,141,255,.22));border-right:1px solid var(--blue,#4D8DFF);transition:none}
    .ljc-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--t3,#717179);pointer-events:none;letter-spacing:.3px;padding-left:${HANDLE_W}px}
    .ljc-hint .arrows{display:inline-flex;margin-left:8px;color:var(--t4,#4A4A51);animation:ljc-nudge 1.4s var(--ease,ease) infinite}
    @keyframes ljc-nudge{0%,100%{transform:translateX(0);opacity:.5}50%{transform:translateX(4px);opacity:1}}
    .ljc-handle{position:absolute;left:3px;top:3px;bottom:3px;width:${HANDLE_W}px;border-radius:9px;background:linear-gradient(180deg,#fff,#E9E9EE);display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 3px 10px -2px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.6) inset;transition:background .2s;z-index:2}
    .ljc-handle:active{cursor:grabbing}
    .ljc-handle svg{color:#0A0A0B}
    .ljc.ok{border-color:var(--green,#34C759)}
    .ljc.ok .ljc-fill{background:rgba(52,199,89,.16);border-right-color:var(--green,#34C759)}
    .ljc.ok .ljc-handle{background:linear-gradient(180deg,#3DDc6A,#2BA84C)}
    .ljc.ok .ljc-handle svg{color:#fff}
    .ljc.ok .ljc-hint{color:var(--green,#34C759);padding-left:0}
    .ljc.err{border-color:var(--red,#FF5247);animation:ljc-shake .35s}
    .ljc.err .ljc-handle{background:linear-gradient(180deg,#FF6B61,#E5392E)}
    @keyframes ljc-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}`;
    const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
  }

  // 手柄图标:>>(待拖)/ ✓(过验)
  const ARROW_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l6 6-6 6M13 6l6 6-6 6"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>';

  function mount(container, { onPass, onReset } = {}) {
    injectStyle();
    let challengeId = null, trackW = 280, token = null, dragging = false, startX = 0, curX = 0;

    container.innerHTML = `
      <div class="ljc">
        <div class="ljc-fill"></div>
        <div class="ljc-hint">拖动滑块到最右端完成验证<span class="arrows">›››</span></div>
        <div class="ljc-handle">${ARROW_SVG}</div>
      </div>`;

    const root = container.querySelector('.ljc');
    const fill = container.querySelector('.ljc-fill');
    const hint = container.querySelector('.ljc-hint');
    const handle = container.querySelector('.ljc-handle');

    async function load() {
      token = null;
      try {
        const c = await LJ.get('/captcha/challenge');
        challengeId = c.challengeId; trackW = c.trackW || root.clientWidth;
        reset();
      } catch (e) {
        hint.innerHTML = '验证加载失败,点此重试';
        root.onclick = load;
      }
    }

    function reset() {
      curX = 0; handle.style.left = '3px'; fill.style.width = '0px';
      handle.innerHTML = ARROW_SVG;
      root.classList.remove('ok', 'err');
      hint.style.display = 'flex'; hint.innerHTML = '拖动滑块到最右端完成验证<span class="arrows">›››</span>';
      root.onclick = null;
      if (onReset) onReset();
    }

    // 轨道可拖最大像素(末端)。提交时按 trackW 换算到服务端坐标。
    function maxTravel() { return root.clientWidth - HANDLE_W - 6; }

    function setX(x) {
      curX = Math.max(0, Math.min(maxTravel(), x));
      handle.style.left = (curX + 3) + 'px';
      fill.style.width = (curX + HANDLE_W) + 'px';
      hint.style.display = 'none';
    }

    async function release() {
      if (!dragging) return;
      dragging = false;
      const max = maxTravel();
      // 没拖到底:直接弹回,不打服务端(省一次请求 + 不消费 challenge)
      if (curX < max - 4) { snapBack(); return; }
      // 拖到底:提交服务端坐标的末端值(trackW),服务端按"到末端"判过
      try {
        const r = await LJ.post('/captcha/verify', { challengeId, x: trackW });
        token = r.captchaToken;
        root.classList.add('ok');
        handle.style.left = (max + 3) + 'px'; fill.style.width = (max + HANDLE_W) + 'px';
        handle.innerHTML = CHECK_SVG;
        hint.style.display = 'flex'; hint.innerHTML = '验证通过';
        if (onPass) onPass(token);
      } catch (e) {
        root.classList.add('err');
        setTimeout(load, 450); // 失败重新出题
      }
    }

    // 未拖到底:动画弹回起点 + 恢复提示
    function snapBack() {
      handle.style.transition = 'left .2s var(--ease,ease)';
      fill.style.transition = 'width .2s var(--ease,ease)';
      curX = 0; handle.style.left = '3px'; fill.style.width = '0px';
      hint.style.display = 'flex';
      setTimeout(() => { handle.style.transition = ''; fill.style.transition = ''; }, 220);
    }

    function onDown(e) {
      if (token) return;
      dragging = true;
      startX = (e.touches ? e.touches[0].clientX : e.clientX) - curX;
    }
    function onMove(e) {
      if (!dragging) return;
      const cx = (e.touches ? e.touches[0].clientX : e.clientX);
      setX(cx - startX);
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mouseup', release);
    window.addEventListener('touchend', release);

    load();
    return { reset: load, getToken: () => token };
  }

  return { mount };
})();
