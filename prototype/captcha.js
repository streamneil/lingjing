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

  function mount(container, { onPass, onReset } = {}) {
    let challengeId = null, gapX = 0, trackW = 280, token = null, dragging = false, startX = 0, curX = 0;

    container.innerHTML = `
      <div class="ljc-track" style="position:relative;height:42px;border-radius:10px;background:var(--field,#101012);border:1px solid var(--line,#232327);overflow:hidden;user-select:none">
        <div class="ljc-fill" style="position:absolute;left:0;top:0;bottom:0;width:0;background:var(--blue-bg,rgba(77,141,255,.13));border-right:1px solid var(--blue,#4D8DFF)"></div>
        <div class="ljc-gap" style="position:absolute;top:9px;width:24px;height:24px;border-radius:6px;border:1px dashed var(--t3,#717179);background:rgba(255,255,255,.03)"></div>
        <div class="ljc-hint" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12.5px;color:var(--t3,#717179);pointer-events:none">拖动滑块完成验证</div>
        <div class="ljc-handle" style="position:absolute;left:0;top:0;bottom:0;width:${HANDLE_W}px;border-radius:9px;background:var(--t1,#F6F6F8);display:flex;align-items:center;justify-content:center;cursor:grab;box-shadow:0 2px 8px rgba(0,0,0,.4)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#0A0A0B" stroke-width="2.4" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
        </div>
      </div>`;

    const track = container.querySelector('.ljc-track');
    const fill = container.querySelector('.ljc-fill');
    const gap = container.querySelector('.ljc-gap');
    const hint = container.querySelector('.ljc-hint');
    const handle = container.querySelector('.ljc-handle');

    async function load() {
      token = null;
      try {
        const c = await LJ.get('/captcha/challenge');
        challengeId = c.challengeId; gapX = c.gapX; trackW = c.trackW || track.clientWidth;
        gap.style.left = gapX + 'px';
        reset();
      } catch (e) {
        hint.textContent = '验证加载失败,点此重试';
        track.onclick = load;
      }
    }

    function reset() {
      curX = 0; handle.style.left = '0px'; fill.style.width = '0px';
      handle.style.background = 'var(--t1,#F6F6F8)';
      hint.style.display = 'flex'; hint.textContent = '拖动滑块完成验证';
      track.onclick = null;
      if (onReset) onReset();
    }

    function setX(x) {
      const max = track.clientWidth - HANDLE_W;
      curX = Math.max(0, Math.min(max, x));
      handle.style.left = curX + 'px';
      fill.style.width = (curX + HANDLE_W) + 'px';
      hint.style.display = 'none';
    }

    async function release() {
      if (!dragging) return;
      dragging = false; handle.style.cursor = 'grab';
      // 前端落点换算到服务端轨宽坐标(缺口 x 以 trackW 为基)
      const scale = trackW / (track.clientWidth || trackW);
      const submitX = Math.round(curX * scale);
      try {
        const r = await LJ.post('/captcha/verify', { challengeId, x: submitX });
        token = r.captchaToken;
        handle.style.background = 'var(--green,#34C759)';
        hint.style.display = 'flex'; hint.textContent = '✓ 验证通过';
        if (onPass) onPass(token);
      } catch (e) {
        handle.style.background = 'var(--red,#FF5247)';
        setTimeout(load, 500); // 失败重新出题
      }
    }

    function onDown(e) {
      if (token) return;
      dragging = true; handle.style.cursor = 'grabbing';
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
