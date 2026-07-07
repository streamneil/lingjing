// 灵镜 同步图像网关共享工具(DRY:Gemini/OpenAI 等「同步返回 base64」适配器共用)。
//
// 决策来源:/plan-eng-review 2026-07-07 CQ1 + 外部声音 #8。
//  - 只抽**真通用**的两块:出网代理 dispatcher(仅 env 变量名不同)+ b64 → 存储 → 公网 URL 尾。
//  - **不含响应解析** —— 各厂商 body 形状不同(Gemini 的 inline_data snake/camel + thought-part 跳过 +
//    safety-block;OpenAI 的 data[].b64_json),解析各网关自留。
//  - Gemini 改调这两个 helper 为**独立后续 commit**(TODO T-GPTIMG2-GEMINI-DRY),不阻 gpt-image-2 上线。

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { storage } from '../storage/index.js';
import { getMediaPublisher } from './media-publisher.js';

// 出网代理缓存(按 env 变量名 → {agent, url})。url 变则重建。
const _agents = new Map<string, { agent: ProxyAgent; url: string }>();

/**
 * 按 env 变量名取出网代理 dispatcher(缓存)。未设该变量 = 直连(返 undefined)。
 * Node 全局 fetch(undici)不认 HTTP(S)_PROXY 环境变量,必须显式传 dispatcher —— 这正是
 * curl 能通、平台却 fetch failed 的原因。只认**显式指定**的变量名(OPENAI_PROXY / GEMINI_PROXY),
 * 不回落通用 HTTPS_PROXY(那是开发机/CI 常见噪声,回落会把没打算走代理的流量误导向代理)。
 */
export function proxyDispatcher(envVarName: string): Dispatcher | undefined {
  const url = process.env[envVarName];
  if (!url) return undefined;
  const cached = _agents.get(envVarName);
  if (!cached || cached.url !== url) {
    _agents.set(envVarName, { agent: new ProxyAgent(url), url });
  }
  return _agents.get(envVarName)!.agent;
}

/**
 * 走(可选)代理的 fetch:配了代理 → undici fetch + dispatcher(全局 fetch 不认跨实例 dispatcher);
 * 否则 → 全局 fetch(正常路径不变,且测试可 spyOn 拦截)。
 * 注:网络层失败(连不上/DNS/TLS)的可读化提示是 provider 专属(消息含各自域名/代理变量名),留在各网关的 try/catch。
 */
export async function proxiedFetch(url: string, init: RequestInit, dispatcher?: Dispatcher): Promise<Response> {
  return dispatcher
    ? ((await undiciFetch(url, { ...(init as Record<string, unknown>), dispatcher } as never)) as unknown as Response)
    : fetch(url, init);
}

/**
 * base64 图 → 落临时存储键 → 转公网 URL(finalizeImageJob 再按 job 键重存,契约不变)。
 * 同步 b64 适配器(Gemini/OpenAI)共用的存储尾。key 由调用方给(含 provider 前缀 + 序号,避免撞键)。
 */
export async function b64ToPublicUrl(b64: string, mime: string, key: string): Promise<string> {
  const publisher = getMediaPublisher('hosted'); // 临时键转公网 URL;finalize 再按 job 键重存
  await storage.putObject(key, Buffer.from(b64, 'base64'), mime);
  return publisher.publish(key);
}
