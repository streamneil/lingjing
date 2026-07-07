// 灵镜 能力网关 — OpenAI GPT Image 2 适配器(第 4 个 provider,纯文生图)。
//
// 决策来源:/plan-ceo-review + /plan-eng-review 2026-07-07(见 ceo-plans/2026-07-07-gpt-image-2.md)。
// 与 Gemini 同为「同步返回 base64」形状,复用 sync-image-common 的代理 + b64→公网 URL 尾:
//  - 鉴权:`Authorization: Bearer {key}`(不同于 Gemini 的 x-goog-api-key)。
//  - 端点:POST {base}/images/generations。出参:data[].b64_json(GPT image 恒 base64,无 url 选项)。
//  - size:任意 WxH(÷16、比例 1:3~3:1、≤3840×2160);从 def.pixelMatrix 按 ratio+resolution 派生(快照无关)。
//  - 计价:token 计价(Design B),响应 usage.output_tokens 是结算真相 → 随 SyncImageResult 返回,worker 回写 usageSnapshot。
//  - 出网代理:api.openai.com 国内 ECS 被墙,同 Gemini 走 OPENAI_PROXY(undici ProxyAgent)。
// 文档:https://platform.openai.com/docs/api-reference/images/create

import { getImageModel, imagePixelWH } from './image-models.js';
import { getProviderKey, getProviderBaseUrl } from './provider-keys.js';
import { proxyDispatcher, proxiedFetch, b64ToPublicUrl } from './sync-image-common.js';
import type { SyncImageGateway, SyncImageResult, ImageGenInput, ImageEditInput, ImageUsage } from './types.js';

const OPENAI_PROVIDER = 'openai';
const OPENAI_FALLBACK_BASE = 'https://api.openai.com/v1';
const MAX_EDGE = 3840; // 最长边上限(宽或高)
const MAX_PIXELS = 3840 * 2160; // 最大总像素(3840×2160)

function openaiBaseUrl(): string {
  return getProviderBaseUrl(OPENAI_PROVIDER) || OPENAI_FALLBACK_BASE;
}

export class OpenAIImageGateway implements SyncImageGateway {
  /** 同步文生图:组体 → POST /images/generations → 取 data[].b64_json 转公网 URL + 解析 usage。
   *  signal 硬超时(同步调无 poll,挂连接会冻 worker,与 Gemini/百炼 S 同口径)。 */
  async generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<SyncImageResult> {
    const def = getImageModel(input.model, 'text2img');

    // 空 key 可读错误(admin 未录 key 的窗口期)。getProviderKey 抛 ProviderKeyError → 换成可操作中文。
    let apiKey: string;
    try {
      apiKey = getProviderKey(OPENAI_PROVIDER);
    } catch {
      throw new Error('OpenAI key 未配置 —— 请到 admin 厂商页录入 OpenAI 的 API key 后再使用 gpt-image-2。');
    }

    // size:从 pixelMatrix 派生 WxH(快照无关,pixelMatrix 是代码常量,无 mid-flight 漂移)。
    const wh = imagePixelWH(def, input.ratio, input.resolution);
    if (!wh) throw new Error(`gpt-image-2 无法解析分辨率(ratio=${input.ratio ?? '默认'}, resolution=${input.resolution ?? '默认'})。`);
    const size = formatSize(wh.width, wh.height); // 越界抛错防 400(÷16 / 比例 1:3~3:1 / ≤3840×2160)

    const n = Math.min(def.maxImages, Math.max(1, Math.floor(input.count ?? 1)));
    const body: Record<string, unknown> = { model: def.modelId, prompt: input.prompt, n, size };
    if (input.quality) body.quality = input.quality; // 用户所选画质(low|medium|high)

    const url = `${openaiBaseUrl()}/images/generations`;
    const reqInit = {
      method: 'POST' as const,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    };

    let res: Response;
    try {
      res = await proxiedFetch(url, reqInit as RequestInit, proxyDispatcher('OPENAI_PROXY'));
    } catch (e) {
      // fetch 抛错 = 网络层失败(连不上/DNS/TLS),非 HTTP 码。国内 ECS 直连 OpenAI 被墙 → 换可操作提示。
      const m = e instanceof Error ? e.message : String(e);
      const proxied = process.env.OPENAI_PROXY;
      throw new Error(
        `无法连接 OpenAI(${m})。服务器访问不到 api.openai.com。` +
          (proxied
            ? `已配代理 ${proxied} 但仍失败 —— 容器内 127.0.0.1≠宿主机,代理地址要用 host.docker.internal 或网桥 IP,` +
              `确认容器内 curl --proxy ${proxied} 能通。`
            : `中国大陆 ECS 直连 OpenAI 会被墙 —— 在 .env 配 OPENAI_PROXY(如 http://host.docker.internal:7890)走出网代理,` +
              `或在 /admin 关掉 gpt-image-2、改用百炼/火山/Gemini 的图片模型。`),
      );
    }

    const text = await res.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 800) }; }
    if (!res.ok) throw mapOpenAiError(res.status, json);

    // GPT image 恒返 data[].b64_json(无 url 选项)。缺 → 清晰错误,绝不 b64ToPublicUrl(undefined) 裸崩。
    const data = (json.data as Array<{ b64_json?: string }> | undefined) ?? [];
    const urls: string[] = [];
    let i = 0;
    for (const d of data) {
      if (!d.b64_json) continue;
      urls.push(await b64ToPublicUrl(d.b64_json, 'image/png', `openai-tmp/${def.modelId}-${Date.now()}-${i++}.png`));
    }
    if (!urls.length) throw new Error(`OpenAI 未返回图片(data[].b64_json 为空):${JSON.stringify(json).slice(0, 400)}`);

    return { urls, usage: parseUsage(json.usage) };
  }

  /** gpt-image-2 官方 edit 端点不含此模型(modes 无 img2img,永不触达);接口要求存在故给清晰错误。 */
  async editImage(_input: ImageEditInput, _signal: AbortSignal): Promise<string[]> {
    throw new Error('gpt-image-2 不支持图生图/编辑(官方 /images/edits 端点不含此模型)。');
  }
}

/** 校验并格式化 size(OpenAI 用 `x` 分隔,非百炼 `*`)。越界抛错防 400。 */
function formatSize(w: number, h: number): string {
  if (w % 16 !== 0 || h % 16 !== 0) throw new Error(`gpt-image-2 尺寸宽高须为 16 的倍数(得到 ${w}x${h})。`);
  const ratio = w / h;
  if (ratio < 1 / 3 || ratio > 3) throw new Error(`gpt-image-2 宽高比须在 1:3 ~ 3:1 之间(得到 ${w}x${h})。`);
  if (w > MAX_EDGE || h > MAX_EDGE || w * h > MAX_PIXELS)
    throw new Error(`gpt-image-2 分辨率超上限 3840×2160(得到 ${w}x${h})。`);
  return `${w}x${h}`;
}

/** OpenAI 错误 → 可读中文(worker 据此 FAIL job,绝不裸码)。 */
function mapOpenAiError(status: number, json: Record<string, unknown>): Error {
  const err = (json.error ?? json) as Record<string, unknown>;
  const detail = JSON.stringify(err).slice(0, 600);
  const msg = String((err as { message?: unknown }).message ?? '');
  const code = String((err as { code?: unknown; type?: unknown }).code ?? (err as { type?: unknown }).type ?? '');
  // 403 组织未验证:gpt-image 系最常见真实失败(valid key + 未验证组织返 403,非 401)。
  if (status === 403 || /verif/i.test(msg) || /verif/i.test(code))
    return new Error(`OpenAI 组织未验证 —— 请在 OpenAI 后台完成组织验证(Organization verification)后才能调用 gpt-image-2。原始:${detail}`);
  // 400 内容审核拦截。
  if (status === 400 && (/content_policy|moderation|safety/i.test(code) || /content policy|moderation|safety/i.test(msg)))
    return new Error(`内容被 OpenAI 审核拦截,请调整提示词后重试。原始:${detail}`);
  if (status === 401) return new Error(`OpenAI 鉴权失败(HTTP 401)—— 请检查 admin 厂商页录入的 OpenAI key。原始:${detail}`);
  return new Error(`OpenAI 生成失败 HTTP ${status}: ${detail}`);
}

/** 解析响应 usage(token 计价结算的真相)。缺失 → undefined(结算回落估算,不崩)。 */
function parseUsage(raw: unknown): ImageUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  const inputTokens = Number(u.input_tokens ?? 0);
  const outputTokens = Number(u.output_tokens ?? 0);
  const totalTokens = Number(u.total_tokens ?? inputTokens + outputTokens);
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined; // 无有效 output token → 不回写,结算回落估算
  return { inputTokens, outputTokens, totalTokens };
}
