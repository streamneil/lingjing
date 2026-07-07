// 灵镜 能力网关 — Google AI Studio(Gemini / Nano Banana)适配器。
//
// 决策来源:/plan-ceo-review + /plan-eng-review 2026-06-16-model-access-platform PR-2a(第三个 provider)。
// 验证 provider 抽象对「完全异构」厂商也成立 —— Gemini 与百炼/火山三处都不同:
//  - 鉴权:header `x-goog-api-key`(不是 Authorization: Bearer)。
//  - 端点:POST {base}/models/{modelId}:generateContent(modelId 拼进 path)。
//  - 入参:contents[{parts:[{text},{inline_data:{mime_type,data:base64}}]}](输入图是 base64 内联,非 URL)。
//  - 出参:candidates[0].content.parts[].inline_data.data(base64 图字节,同步返回,无 task)。
// 适配器吸收这三处差异,对外仍给 SyncImageGateway 标准契约(返回公网 URL 数组)——
//   base64 → storage.putObject → publish 转公网 URL(finalizeImageJob 再 putObjectFromUrl 重存,契约不变)。
// 文档:https://ai.google.dev/gemini-api/docs/image-generation

import { getImageModel } from './image-models.js';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import { getProviderKey, getProviderBaseUrl } from './provider-keys.js';
import { storage } from '../storage/index.js';
import { getMediaPublisher } from './media-publisher.js';
import type { SyncImageGateway, SyncImageResult, ImageGenInput, ImageEditInput } from './types.js';

const GEMINI_PROVIDER = 'google-ai-studio';
const GEMINI_FALLBACK_BASE = 'https://generativelanguage.googleapis.com/v1beta'; // v1beta:image-gen config 字段(实测 v1 不认)

function geminiBaseUrl(): string {
  return getProviderBaseUrl(GEMINI_PROVIDER) || GEMINI_FALLBACK_BASE;
}

// 出网代理(仅 Gemini 用)。中国大陆 ECS 直连 Google 被墙 → 必须走代理(如本机 clash 7890)。
// 只挂在 Gemini 这一个 fetch 上,百炼/火山/OSS 等国内流量仍直连,不会被绕到海外代理变慢/出错。
// Node 全局 fetch(undici)不认 HTTP_PROXY 环境变量,必须显式传 dispatcher —— 这正是 curl 能通、
// 平台却 fetch failed 的原因。容器内 127.0.0.1≠宿主机,代理地址要用 host.docker.internal/网桥 IP。
// 只认显式的 GEMINI_PROXY:不回落通用 HTTPS_PROXY/https_proxy —— 那些是常见的环境噪声
// (开发机 shell、CI 都可能设),回落会让 Gemini 在没打算走代理时被误导向代理(还会破坏测试隔离)。
// 未设 = 直连(本地开发不受影响)。
let _proxyAgent: ProxyAgent | null = null;
let _proxyAgentUrl: string | undefined;
function geminiDispatcher(): Dispatcher | undefined {
  const url = process.env.GEMINI_PROXY;
  if (!url) return undefined;
  if (!_proxyAgent || _proxyAgentUrl !== url) {
    _proxyAgent = new ProxyAgent(url); // 缓存(按 url),不每次新建
    _proxyAgentUrl = url;
  }
  return _proxyAgent;
}

/** 把输入图公网 URL 拉成 base64 内联(Gemini 不吃 URL,只吃 inline_data)。 */
async function urlToInlineData(url: string): Promise<{ mime_type: string; data: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gemini 输入图拉取失败 ${res.status}`);
  const mime = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return { mime_type: mime, data: buf.toString('base64') };
}

export class GeminiGateway implements SyncImageGateway {
  /** 同步生成核心:组 contents 体 → POST :generateContent → 取 base64 → 存储转公网 URL。
   *  signal 做硬超时(同步调无 poll,挂连接会冻 worker —— 与百炼/火山 S 形状同口径)。 */
  private async generate(modelId: string, prompt: string, inputUrls: string[], opts: { aspectRatio?: string; imageSize?: string }, signal: AbortSignal): Promise<string[]> {
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const u of inputUrls) parts.push({ inline_data: await urlToInlineData(u) });
    // ⚠ 实测(真火山... Google API 探针)定位的正确形状:端点 v1beta + camelCase;
    //   size 控制是 generationConfig.imageConfig(不是文档 SDK 示例里的 responseFormat —— 那是 SDK 抽象,
    //   裸 REST 用 imageConfig 才被接受;responseFormat 会 400 Unknown/Invalid)。
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    // aspectRatio 所有模型支持;imageSize 仅 Gemini 3.x(2.5-flash 不吃,文档明示)。imageSize 大写 K。
    const supportsImageSize = modelId.startsWith('gemini-3');
    const imageCfg: Record<string, unknown> = {};
    if (opts.aspectRatio) imageCfg.aspectRatio = opts.aspectRatio;
    if (opts.imageSize && supportsImageSize) imageCfg.imageSize = opts.imageSize;
    if (Object.keys(imageCfg).length) generationConfig.imageConfig = imageCfg;
    const url = `${geminiBaseUrl()}/models/${modelId}:generateContent`;
    const reqInit = {
      method: 'POST' as const,
      headers: { 'x-goog-api-key': getProviderKey(GEMINI_PROVIDER), 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      signal,
    };
    let res: Response;
    try {
      // 无代理 → 用全局 fetch(正常路径不变,且测试可 spyOn 拦截)。
      // 配了代理 → 用 undici fetch + dispatcher 走代理(全局 fetch 不认跨实例 dispatcher)。
      const dispatcher = geminiDispatcher();
      res = dispatcher
        ? ((await undiciFetch(url, { ...reqInit, dispatcher })) as unknown as Response)
        : await fetch(url, reqInit);
    } catch (e) {
      // fetch 抛错 = 网络层失败(连不上/DNS/TLS),非 HTTP 错误码。中国大陆服务器直连 Google
      // 会被墙 → 原始报错只有含糊的 "fetch failed"。这里换成可操作的提示。
      const m = e instanceof Error ? e.message : String(e);
      const proxied = process.env.GEMINI_PROXY;
      throw new Error(
        `无法连接 Google Gemini(${m})。服务器访问不到 generativelanguage.googleapis.com。` +
          (proxied
            ? `已配代理 ${proxied} 但仍失败 —— 容器内 127.0.0.1≠宿主机,代理地址要用 host.docker.internal 或网桥 IP,` +
              `且代理须监听该地址(clash allow-lan);确认 curl --proxy ${proxied} 在容器内能通。`
            : `中国大陆 ECS 直连 Google 会被墙 —— 在 .env 配 GEMINI_PROXY(如 http://host.docker.internal:7890)走出网代理,` +
              `或在 /admin 关掉 Gemini、改用百炼/火山的图片模型。`),
      );
    }
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 800) }; }
    if (!res.ok) {
      const detail = JSON.stringify(json?.error ?? json);
      // 429 free_tier limit:0 = 该 Google Key 免费层对该模型无配额 → 需开通计费,非平台 bug。
      if (res.status === 429)
        throw new Error(
          `Gemini 配额不足(HTTP 429)。该 Google API Key 对 ${modelId} 的配额为 0(多为免费层)` +
            `—— 需在 Google AI Studio / Cloud 项目开通计费(付费层)后才可用 Nano Banana。原始:${detail}`,
        );
      throw new Error(`Gemini 生成失败 HTTP ${res.status}: ${detail}`);
    }
    // 取所有候选里的图片 part(base64)。
    const outParts: Array<{ thought?: boolean; inline_data?: { data?: string; mime_type?: string }; inlineData?: { data?: string; mimeType?: string } }> =
      json?.candidates?.[0]?.content?.parts ?? [];
    const urls: string[] = [];
    const publisher = getMediaPublisher('hosted'); // 临时键转公网 URL;finalizeImageJob 再按 job 键重存
    let i = 0;
    for (const p of outParts) {
      // ⚠ Gemini 3.x 是 thinking 模型(默认开,不可关):响应含中间「思考图」part(thought:true),
      //   不是成品,必须跳过 —— 否则会把思考过程的中间图当成品返回(多张/错图)。文档明示。
      if (p.thought === true) continue;
      // 兼容 snake_case(inline_data)与 camelCase(inlineData)两种返回风格。
      const b64 = p.inline_data?.data ?? p.inlineData?.data;
      const mime = p.inline_data?.mime_type ?? p.inlineData?.mimeType ?? 'image/png';
      if (!b64) continue;
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
      const key = `gemini-tmp/${modelId}-${Date.now()}-${i++}.${ext}`;
      await storage.putObject(key, Buffer.from(b64, 'base64'), mime);
      urls.push(await publisher.publish(key));
    }
    if (!urls.length) throw new Error(`Gemini 未返回图片(可能被安全策略拦):${JSON.stringify(json?.candidates?.[0]?.finishReason ?? json)}`);
    return urls;
  }

  async generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<SyncImageResult> {
    const def = getImageModel(input.model, 'text2img');
    const urls = await this.generate(def.modelId, input.prompt, [], { aspectRatio: input.ratio, imageSize: input.resolution }, signal);
    return { urls }; // Gemini 不返 token usage(非 token 计价)
  }

  async editImage(input: ImageEditInput, signal: AbortSignal): Promise<SyncImageResult> {
    const def = getImageModel(input.model, 'img2img');
    const urls = await this.generate(def.modelId, input.prompt, input.imageUrls ?? [], { aspectRatio: input.ratio, imageSize: input.resolution }, signal);
    return { urls }; // Gemini 不返 token usage
  }
}
