// 灵镜 cookie 安全标志 — Secure 由环境变量控制(DRY,租户 + 超管共用)。
//
// 决策来源:Docker 部署就绪 D3/C8/C9。
//   生产经 Caddy 反代终结 TLS(HTTPS),cookie 必须带 Secure(只在 HTTPS 传);
//   本地 dev 裸 HTTP,带 Secure 会让浏览器发不出 cookie → 登不进。
//   故用 COOKIE_SECURE env 开关:生产 docker-compose 设 true,本地不设。
//
// set 和 clear 必须一致(同一 Secure 标志),否则 set 带 Secure、clear 不带,
// 某些浏览器认为是不同 cookie 清不掉。两处都走 secureAttr()。

/** 生产(COOKIE_SECURE=true)返回 '; Secure',否则空串。拼进 Set-Cookie。 */
export function secureAttr(): string {
  return process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
}
