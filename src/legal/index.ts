// 灵镜 法务/合规 —— 服务条款 + 隐私政策的版本事实源。
//
// 设计来源:/plan-eng-review —— terms_version 留痕必须可举证"用户当时同意的是哪一版"。
// 唯一事实源是后端这个常量(不信任前端传来的版本号):创建 avatar/voice 写 authorization 时
// 直接用 TERMS_VERSION 落库;前端 GET /api/legal/version 只读不写。
//
// 改条款 = 改这个版本号(用日期版),旧授权记录保留它们各自同意的旧版本,形成可追溯链。

/** 当前生效的条款/隐私政策版本(日期版)。改条款内容时必须同步上调此值。 */
export const TERMS_VERSION = '2026-06-01';

/** 条款页与版本元信息(供前端展示/留痕)。 */
export function currentLegalVersion(): { version: string; termsUrl: string; privacyUrl: string } {
  return { version: TERMS_VERSION, termsUrl: '/terms.html', privacyUrl: '/privacy.html' };
}
