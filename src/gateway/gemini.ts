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
import { getProviderKey, getProviderBaseUrl } from './provider-keys.js';
import { storage } from '../storage/index.js';
import { getMediaPublisher } from './media-publisher.js';
import type { SyncImageGateway, ImageGenInput, ImageEditInput } from './types.js';

const GEMINI_PROVIDER = 'google-ai-studio';
const GEMINI_FALLBACK_BASE = 'https://generativelanguage.googleapis.com/v1';

function geminiBaseUrl(): string {
  return getProviderBaseUrl(GEMINI_PROVIDER) || GEMINI_FALLBACK_BASE;
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
    const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
    if (opts.aspectRatio || opts.imageSize) {
      generationConfig.responseFormat = { image: { ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}), ...(opts.imageSize ? { imageSize: opts.imageSize } : {}) } };
    }
    const res = await fetch(`${geminiBaseUrl()}/models/${modelId}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': getProviderKey(GEMINI_PROVIDER), 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      signal,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 800) }; }
    if (!res.ok) throw new Error(`Gemini 生成失败 HTTP ${res.status}: ${JSON.stringify(json?.error ?? json)}`);
    // 取所有候选里的图片 part(base64)。
    const outParts: Array<{ inline_data?: { data?: string; mime_type?: string }; inlineData?: { data?: string; mimeType?: string } }> =
      json?.candidates?.[0]?.content?.parts ?? [];
    const urls: string[] = [];
    const publisher = getMediaPublisher('hosted'); // 临时键转公网 URL;finalizeImageJob 再按 job 键重存
    let i = 0;
    for (const p of outParts) {
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

  async generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<string[]> {
    const def = getImageModel(input.model, 'text2img');
    return this.generate(def.modelId, input.prompt, [], { aspectRatio: input.ratio, imageSize: input.resolution }, signal);
  }

  async editImage(input: ImageEditInput, signal: AbortSignal): Promise<string[]> {
    const def = getImageModel(input.model, 'img2img');
    return this.generate(def.modelId, input.prompt, input.imageUrls ?? [], { aspectRatio: input.ratio, imageSize: input.resolution }, signal);
  }
}
