// 灵镜 能力网关 — 火山引擎方舟(Volc Ark)适配器(豆包 Seedance 视频 / Seedream 图片)。
//
// 决策来源:/plan-ceo-review + /plan-eng-review 2026-06-16-model-access-platform PR-2a。
// 第一个异构 provider,验证 provider 抽象(外部声音 P2:真异构厂商才是抽象的唯一有效测试)。
//
// 与百炼的差异(适配器的存在理由):
//  - base_url 不同:ark.cn-beijing.volces.com/api/v3(从 provider 表读);key=getProviderKey('volc-ark')。
//  - 视频:POST /contents/generations/tasks(content[] 多模态体)→ {id};GET /tasks/{id} → {status, content.video_url}。
//    状态字面量是小写 queued/running/succeeded/failed(百炼是大写 SUCCEEDED…)→ 本适配器内部归一,接口对外一致。
//  - 图片:POST /images/generations 同步返 {data:[{url}]}(百炼图片是异步 task)→ 走 SyncImageGateway。
//  - 鉴权同为 Bearer,但 key/base_url 各自独立。
// 文档:https://www.volcengine.com/docs/82379/1520757(视频)、/1666945(图片)。

import { getImageModel } from './image-models.js';
import { getVideoModel } from './video-models.js';
import { getProviderKey, getProviderBaseUrl } from './provider-keys.js';
import type {
  CapabilityGateway,
  VideoSubmitUrls,
  ProviderJobResult,
  ProviderJobStatus,
  ImageGenInput,
  ImageJobResult,
  SyncImageGateway,
  ImageEditInput,
  VideoGenT2VInput,
} from './types.js';

const ARK_PROVIDER = 'volc-ark';
const ARK_FALLBACK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

// 豆包 seedream 各型号支持的分辨率档(火山文档)。平台 UI 只给 1K/2K/4K + 上限校验,不拦下限;
// 这里按型号托底:用户选了型号不支持的低档(如 4.5 选 1K)→ 自动抬到该型号最低支持档,绝不报错。
const SEEDREAM_SIZES: Record<string, string[]> = {
  'doubao-seedream-4-0-250828': ['1K', '2K', '4K'],
  'doubao-seedream-4-5-251128': ['2K', '4K'],
  'doubao-seedream-5-0-260128': ['2K', '3K', '4K'],
};
const SIZE_ORDER = ['1K', '2K', '3K', '4K'];
/** 把请求 size clamp 到该 modelId 支持的档;不支持的低档抬到最低支持档。非档位值(如 2048x2048)原样透传。 */
function clampSeedreamSize(modelId: string, size?: string): string | undefined {
  if (!size) return undefined;
  const allowed = SEEDREAM_SIZES[modelId];
  if (!allowed) return size; // 非 seedream / 未知型号:原样
  if (allowed.includes(size)) return size; // 支持:原样
  if (!SIZE_ORDER.includes(size)) return size; // 像素值(WxH)不动,交给厂商校验
  // 档位但不支持(低于该型号最低档)→ 抬到最低支持档。
  return allowed[0];
}

function arkBaseUrl(): string {
  return getProviderBaseUrl(ARK_PROVIDER) || ARK_FALLBACK_BASE;
}
function arkHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getProviderKey(ARK_PROVIDER)}`, 'Content-Type': 'application/json' };
}

async function arkHttp(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${arkBaseUrl()}${path}`, {
    method,
    headers: arkHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 800) }; }
  return { status: res.status, json };
}

/** 火山视频任务状态(小写)归一到网关 4 态。 */
function normalizeArkStatus(s: string | undefined): ProviderJobStatus {
  switch (s) {
    case 'succeeded': return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'expired': return 'failed';
    case 'running': return 'running';
    case 'queued':
    default: return 'pending';
  }
}

/** i2v media 组装:火山用 content[] 里的 image_url 对象 + role 表达首帧/尾帧/参考图。
 *  - first_frame → 1 张 role=first_frame
 *  - first_last  → 首帧 first_frame + 尾帧 last_frame
 *  - reference   → N 张 role=reference_image(Seedance 2.0 多模态参考生) */
function buildArkImageContent(task: string | undefined, urls: string[]): Array<Record<string, unknown>> {
  if (task === 'first_last') return [
    { type: 'image_url', image_url: { url: urls[0] }, role: 'first_frame' },
    { type: 'image_url', image_url: { url: urls[1] }, role: 'last_frame' },
  ];
  if (task === 'reference') return urls.map((u) => ({ type: 'image_url', image_url: { url: u }, role: 'reference_image' }));
  // first_frame(默认):1 张首帧
  return urls.length ? [{ type: 'image_url', image_url: { url: urls[0] }, role: 'first_frame' }] : [];
}

export class ArkGateway implements CapabilityGateway, SyncImageGateway {
  // ── 视频(豆包 Seedance:文生视频 / 图生视频 / 参考生)──
  async submitVideoT2V(input: VideoGenT2VInput): Promise<string> {
    const def = getVideoModel(input.model);
    const duration = input.durationSnapshot ?? input.duration ?? def.defaultDuration;
    const resolution = (input.resSnapshot ?? input.resolution ?? def.resolutions[0] ?? '720P').toLowerCase(); // 火山用小写 720p
    // content[]:文本 + (i2v/参考生时)图片对象。imageRefs 已是 worker publish 的公网 URL(就地覆写)。
    const content: Array<Record<string, unknown>> = [];
    if (input.prompt) content.push({ type: 'text', text: input.prompt });
    const imageUrls = (input.imageRefs ?? []).filter(Boolean) as string[];
    if (imageUrls.length) content.push(...buildArkImageContent(input.task, imageUrls));
    const body: Record<string, unknown> = {
      model: def.modelId,
      content,
      resolution,
      duration,
      watermark: false,
    };
    if (def.supportsAudio) body.generate_audio = input.audio ?? false;
    const { status, json } = await arkHttp('POST', '/contents/generations/tasks', body);
    if (status !== 200) throw new Error(`火山视频提交失败 HTTP ${status}: ${JSON.stringify(json?.error ?? json)}`);
    const taskId: string | undefined = json?.id;
    if (!taskId) throw new Error(`火山视频未返回任务 id: ${JSON.stringify(json)}`);
    return taskId;
  }

  async fetchJobStatus(providerTaskId: string): Promise<ProviderJobResult> {
    const { status, json } = await arkHttp('GET', `/contents/generations/tasks/${providerTaskId}`);
    if (status !== 200) return { status: 'failed', error: `火山查询任务失败 HTTP ${status}` };
    const normalized = normalizeArkStatus(json?.status);
    const result: ProviderJobResult = { status: normalized };
    if (normalized === 'succeeded') {
      result.videoUrl = json?.content?.video_url;
      result.aiLabel = 'none'; // worker 统一 applyAiLabel 后处理(与百炼同口径)
    }
    if (normalized === 'failed') result.error = json?.error?.message ?? json?.error?.code ?? '火山任务失败';
    return result;
  }

  // 数字人 s2v 不走火山(豆包无音频驱动口型接口);保留方法满足接口,被调即报错(防误路由)。
  async submitVideo(_urls: VideoSubmitUrls): Promise<string> {
    throw new Error('火山(豆包)不支持数字人 s2v 音频驱动视频,请用百炼 wan2.2-s2v');
  }

  // ── 图片(豆包 Seedream:同步返回,无 task)──
  // CapabilityGateway 的异步 submitImage/submitImageEdit + fetchImageStatus 不适配火山(火山图片是同步)。
  // worker 对火山图片走 SyncImageGateway(generateImageSync/editImage),与百炼 S 形状同路径。
  async submitImage(_input: ImageGenInput): Promise<string> {
    throw new Error('火山图片为同步接口,应走 generateImageSync(SyncImageGateway)');
  }
  async submitImageEdit(_input: ImageGenInput): Promise<string> {
    throw new Error('火山图片为同步接口,应走 editImage(SyncImageGateway)');
  }
  async fetchImageStatus(_providerTaskId: string): Promise<ImageJobResult> {
    throw new Error('火山图片为同步接口,无异步任务状态');
  }

  // ── SyncImageGateway:同步文生图 / 图生图 ──
  /** 火山同步图片生成核心:POST /images/generations,返 data[].url。signal 做硬超时。 */
  private async generate(modelId: string, prompt: string, images: string[], opts: { size?: string; count?: number }, signal: AbortSignal): Promise<string[]> {
    const body: Record<string, unknown> = {
      model: modelId,
      prompt,
      watermark: false,
      response_format: 'url',
      // 锁单图输出:不传则豆包可能按 prompt 自主判断返回组图(多图),与本平台「单图」语义不符。
      //   本平台暂不暴露组图,显式 disabled 保证 data[] 恒 1 张(文档「多图融合」示例同款)。
      sequential_image_generation: 'disabled',
    };
    if (images.length === 1) body.image = images[0];
    else if (images.length > 1) body.image = images; // 多图融合(多输入图 → 单输出图)
    const size = clampSeedreamSize(modelId, opts.size); // 按型号托底(4.5/5.0-lite 选 1K → 抬到 2K)
    if (size) body.size = size; // 如 '2K' 或 '2048x2048'
    const { status, json } = await arkHttp('POST', '/images/generations', body, signal);
    if (status !== 200) throw new Error(`火山图片生成失败 HTTP ${status}: ${JSON.stringify(json?.error ?? json)}`);
    const data: Array<{ url?: string; error?: unknown }> = json?.data ?? [];
    const urls = data.map((d) => d.url).filter((u): u is string => !!u);
    if (!urls.length) throw new Error(`火山图片未返回 url: ${JSON.stringify(json?.error ?? json)}`);
    return urls;
  }

  async generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<string[]> {
    const def = getImageModel(input.model, 'text2img');
    // 火山 size:优先用 resolution 档(2K/4K),否则模型默认。
    const size = input.resolution || undefined;
    return this.generate(def.modelId, input.prompt, [], { size, count: input.count }, signal);
  }

  async editImage(input: ImageEditInput, signal: AbortSignal): Promise<string[]> {
    const def = getImageModel(input.model, 'img2img');
    const size = input.resolution || undefined;
    return this.generate(def.modelId, input.prompt, input.imageUrls ?? [], { size, count: input.count }, signal);
  }
}
