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
  SyncImageResult,
  ImageEditInput,
  VideoGenT2VInput,
} from './types.js';

const ARK_PROVIDER = 'volc-ark';
const ARK_FALLBACK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

// 豆包 seedream 精确宽高像素表(火山文档「推荐宽高像素值」)。按 (档,比例) → "WxH"。
// 2K/4K 三型号一致;1K 仅 4.0;3K 仅 5.0-lite。用户选的「档+比例」查此表发精确 size,
// 比例真正生效(原来只发档名让模型自定比例 → 用户选 16:9 也可能出 1:1)。
const SEEDREAM_2K: Record<string, string> = {
  '1:1': '2048x2048', '3:4': '1728x2304', '4:3': '2304x1728', '16:9': '2848x1600',
  '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344',
};
const SEEDREAM_4K: Record<string, string> = {
  '1:1': '4096x4096', '3:4': '3520x4704', '4:3': '4704x3520', '16:9': '5504x3040',
  '9:16': '3040x5504', '2:3': '3328x4992', '3:2': '4992x3328', '21:9': '6240x2656',
};
const SEEDREAM_1K: Record<string, string> = { // 仅 4.0
  '1:1': '1024x1024', '3:4': '864x1152', '4:3': '1152x864', '16:9': '1312x736',
  '9:16': '736x1312', '2:3': '832x1248', '3:2': '1248x832', '21:9': '1568x672',
};
const SEEDREAM_3K: Record<string, string> = { // 仅 5.0-lite
  '1:1': '3072x3072', '3:4': '2592x3456', '4:3': '3456x2592', '16:9': '4096x2304',
  '9:16': '2304x4096', '2:3': '2496x3744', '3:2': '3744x2496', '21:9': '4704x2016',
};
// 各型号支持的档 → 该档的像素表。
const SEEDREAM_PIXELS: Record<string, Record<string, Record<string, string>>> = {
  'doubao-seedream-4-0-250828': { '1K': SEEDREAM_1K, '2K': SEEDREAM_2K, '4K': SEEDREAM_4K },
  'doubao-seedream-4-5-251128': { '2K': SEEDREAM_2K, '4K': SEEDREAM_4K },
  'doubao-seedream-5-0-260128': { '2K': SEEDREAM_2K, '3K': SEEDREAM_3K, '4K': SEEDREAM_4K },
};
/** 把 (型号, 档, 比例) 解析为火山精确像素 size('2848x1600')。
 *  非 seedream → 原样返回 size 档名;查不到(档/比例不支持)→ 回落该型号最低档的该比例,再回落档名。 */
function seedreamSize(modelId: string, tier?: string, ratio?: string): string | undefined {
  const table = SEEDREAM_PIXELS[modelId];
  if (!table) return tier; // 非 seedream:原样(其他厂商不走这)
  const tiers = Object.keys(table);
  const effTier = tier && table[tier] ? tier : tiers[0]!; // 不支持的档(如 4.5 选 1K)→ 回落最低支持档
  const byRatio = table[effTier]!;
  const r = ratio && byRatio[ratio] ? ratio : '1:1'; // 不支持的比例 → 回落 1:1
  return byRatio[r];
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

/** media 组装:火山用 content[] 里的 image_url/video_url/audio_url 对象 + role。
 *  - first_frame → 1 张 role=first_frame
 *  - first_last  → 首帧 first_frame + 尾帧 last_frame
 *  - reference   → N 图 role=reference_image + (多模态)N 视频 role=reference_video + N 音频 role=reference_audio
 *  videoRefs/audioRefs 仅 video_r2v 多模态参考生有(worker 已 publish 成公网 URL)。 */
function buildArkMediaContent(
  task: string | undefined, urls: string[],
  videoUrls: string[] = [], audioUrls: string[] = [],
): Array<Record<string, unknown>> {
  if (task === 'first_last') return [
    { type: 'image_url', image_url: { url: urls[0] }, role: 'first_frame' },
    { type: 'image_url', image_url: { url: urls[1] }, role: 'last_frame' },
  ];
  if (task === 'reference') return [
    ...urls.map((u) => ({ type: 'image_url', image_url: { url: u }, role: 'reference_image' })),
    ...videoUrls.map((u) => ({ type: 'video_url', video_url: { url: u }, role: 'reference_video' })),
    ...audioUrls.map((u) => ({ type: 'audio_url', audio_url: { url: u }, role: 'reference_audio' })),
  ];
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
    const videoUrls = (input.videoRefs ?? []).filter(Boolean) as string[];
    const audioUrls = (input.audioRefs ?? []).filter(Boolean) as string[];
    if (imageUrls.length || videoUrls.length || audioUrls.length)
      content.push(...buildArkMediaContent(input.task, imageUrls, videoUrls, audioUrls));
    const body: Record<string, unknown> = {
      model: def.modelId,
      content,
      resolution,
      duration,
      watermark: false,
    };
    // ratio:模型声明了 ratios 且用户选了才发(文档:21:9/16:9/4:3/1:1/3:4/9:16)。
    // 注:有 reference media 时火山可能以输入图比例为准;发 ratio 无害(厂商不支持则忽略/回落)。
    if (input.ratio && def.ratios.includes(input.ratio)) body.ratio = input.ratio;
    if (def.supportsAudio) body.generate_audio = input.audio ?? false;
    const { status, json } = await arkHttp('POST', '/contents/generations/tasks', body);
    if (status !== 200) {
      const err = new Error(`火山视频提交失败 HTTP ${status}: ${JSON.stringify(json?.error ?? json)}`);
      // 附拦截码供 worker 精确识别隐私拦截(InputImageSensitiveContentDetected.PrivacyInformation)。
      (err as Error & { arkCode?: string }).arkCode = json?.error?.code ?? json?.code;
      throw err;
    }
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
  private async generate(modelId: string, prompt: string, images: string[], opts: { tier?: string; ratio?: string; count?: number }, signal: AbortSignal): Promise<string[]> {
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
    // size 发火山精确像素(档+比例 → "2848x1600"),用户选的比例真正生效(原来只发档名让模型自定比例)。
    const size = seedreamSize(modelId, opts.tier, opts.ratio);
    if (size) body.size = size;
    const { status, json } = await arkHttp('POST', '/images/generations', body, signal);
    if (status !== 200) throw new Error(`火山图片生成失败 HTTP ${status}: ${JSON.stringify(json?.error ?? json)}`);
    const data: Array<{ url?: string; error?: unknown }> = json?.data ?? [];
    const urls = data.map((d) => d.url).filter((u): u is string => !!u);
    if (!urls.length) throw new Error(`火山图片未返回 url: ${JSON.stringify(json?.error ?? json)}`);
    return urls;
  }

  async generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<SyncImageResult> {
    const def = getImageModel(input.model, 'text2img');
    // 档(resolution)+ 比例(ratio)→ 火山精确像素 size(seedreamSize 查表)。
    const urls = await this.generate(def.modelId, input.prompt, [], { tier: input.resolution, ratio: input.ratio, count: input.count }, signal);
    return { urls }; // 火山不返 token usage(非 token 计价)
  }

  async editImage(input: ImageEditInput, signal: AbortSignal): Promise<SyncImageResult> {
    const def = getImageModel(input.model, 'img2img');
    const urls = await this.generate(def.modelId, input.prompt, input.imageUrls ?? [], { tier: input.resolution, ratio: input.ratio, count: input.count }, signal);
    return { urls }; // 火山不返 token usage
  }
}
