// 灵镜 能力网关 — 百炼(DashScope)适配器。
//
// 查证(2026-06 阿里官方文档)的真实 wan2.2-s2v 接口:
//   端点 POST /services/aigc/image2video/video-synthesis/  (X-DashScope-Async: enable)
//   input: { image_url, audio_url }  parameters: { resolution: '480P'|'720P' }
//   返回 output.task_id;GET /tasks/:id 轮询,task_status: SUCCEEDED/FAILED;
//   成功 output.video_url 即成品。
//   ⚠️ image_url / audio_url 必须公网可访问(私有化内网需特殊处理,见 TODOS)。
//   ⚠️ wan2.2-s2v 不做 TTS:文案要先经 CosyVoice 转音频(见 worker 编排)。
// 参考:https://help.aliyun.com/zh/model-studio/wan-s2v-api

import { config } from '../config.js';
import { getImageModel, sizeParams, isKnownModel } from './image-models.js';
import { getVideoModel, isKnownVideoModel } from './video-models.js';
import { getProviderKey } from './provider-keys.js'; // PR-1:key 从加密表取(回落 .env)
import { ArkGateway } from './ark.js'; // PR-2a:火山(豆包)适配器
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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${getProviderKey('bailian')}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function httpJson(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal, // 同步调用(图生图)传 AbortSignal 做硬超时;异步轮询路径不传
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${config.baichuan.baseUrl}${path}`, {
    method,
    headers: authHeaders(extraHeaders),
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 800) };
  }
  return { status: res.status, json };
}

/** i2v media 组装(R3.1):按 task 把已 publish 的公网 URL 数组组成 input.media[{type,url}]。
 *  - first_frame → [{first_frame}]  (urls 须 1 张)
 *  - first_last  → [{first_frame},{last_frame}]  (urls[0]=首帧、[1]=尾帧,序由前端槽位定)
 *  - reference   → [{reference_image}×N]  (1..maxRefImages 张) */
function buildMedia(task: string, urls: string[]): Array<{ type: string; url: string }> {
  if (task === 'first_frame') return [{ type: 'first_frame', url: urls[0]! }];
  if (task === 'first_last') return [
    { type: 'first_frame', url: urls[0]! },
    { type: 'last_frame', url: urls[1]! },
  ];
  // reference
  return urls.map((url) => ({ type: 'reference_image', url }));
}

/** 把百炼的 task_status 归一到网关的 4 态。 */
function normalizeStatus(s: string | undefined): ProviderJobStatus {
  switch (s) {
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
    case 'CANCELED':
    case 'UNKNOWN':
      return 'failed';
    case 'RUNNING':
      return 'running';
    case 'PENDING':
    default:
      return 'pending';
  }
}

export class BaichuanGateway implements CapabilityGateway, SyncImageGateway {
  async submitVideo(urls: VideoSubmitUrls): Promise<string> {
    const model = config.baichuan.avatarModel || 'wan2.2-s2v';

    // wan2.2-s2v 真实入参:image_url + audio_url(均需公网可访问)
    const { status, json } = await httpJson(
      'POST',
      '/services/aigc/image2video/video-synthesis/',
      {
        model,
        input: {
          image_url: urls.imageUrl,
          audio_url: urls.audioUrl,
        },
        parameters: {
          resolution: urls.resolution ?? '720P', // s2v 支持 480P | 720P
        },
      },
      { 'X-DashScope-Async': 'enable' }, // 异步任务,返回 task_id
    );

    if (status !== 200) {
      throw new Error(`百炼提交失败 HTTP ${status}: ${JSON.stringify(json?.message ?? json)}`);
    }
    const taskId: string | undefined = json?.output?.task_id;
    if (!taskId) {
      throw new Error(`百炼未返回 task_id: ${JSON.stringify(json?.output ?? json)}`);
    }
    return taskId;
  }

  async fetchJobStatus(providerTaskId: string): Promise<ProviderJobResult> {
    const { status, json } = await httpJson('GET', `/tasks/${providerTaskId}`);
    if (status !== 200) {
      return { status: 'failed', error: `查询任务失败 HTTP ${status}` };
    }
    const out = json?.output ?? {};
    const normalized = normalizeStatus(out.task_status);
    const result: ProviderJobResult = { status: normalized };

    if (typeof out.progress === 'number') result.progress = out.progress;

    if (normalized === 'succeeded') {
      // 查证(2026-06 官方):成品在 output.results.video_url(results 是对象,非数组)。URL 有效期 24h。
      result.videoUrl = out.results?.video_url ?? out.video_url;
      // wan2.2-s2v 成品默认不自带 AI 标识;由 worker 调 applyAiLabel(pipeline/ai-label.ts)
      // ffmpeg 后处理打"AI 合成"水印 + 元数据(已实现,受 tenant_setting.ai_label_enabled 控制)。
      result.aiLabel = 'none';
    }
    if (normalized === 'failed') {
      result.error = out.message ?? out.code ?? '百炼任务失败';
    }
    return result;
  }

  // ── AI 图片(qwen-image 文生图)──
  // 查证(2026-06 官方):端点 POST /services/aigc/text2image/image-synthesis/(X-DashScope-Async: enable)
  //   input: { prompt }  parameters: { n, size }  →  output.task_id
  //   GET /tasks/:id 轮询;成功 output.results 是**数组**(多图),每元素 { url }。URL 24h 过期。
  // 参考:https://help.aliyun.com/zh/model-studio/qwen-image-api
  async submitImage(input: ImageGenInput): Promise<string> {
    // model 从 registry(P1-c:删 config.imageModel 读,registry 是唯一真相源)。
    const def = getImageModel(input.model);
    const n = Math.min(def.maxImages, Math.max(1, Math.floor(input.count ?? 1)));
    const { status, json } = await httpJson(
      'POST',
      '/services/aigc/text2image/image-synthesis/',
      {
        model: def.modelId,
        input: { prompt: input.prompt },
        parameters: { n, ...sizeParams(def, input.ratio, input.resolution, { width: (input as ImageGenInput).width, height: (input as ImageGenInput).height }), ...seedParam(input.seed) },
      },
      { 'X-DashScope-Async': 'enable' },
    );
    if (status !== 200) {
      throw new Error(`百炼文生图提交失败 HTTP ${status}: ${JSON.stringify(json?.message ?? json)}`);
    }
    const taskId: string | undefined = json?.output?.task_id;
    if (!taskId) {
      throw new Error(`百炼文生图未返回 task_id: ${JSON.stringify(json?.output ?? json)}`);
    }
    return taskId;
  }

  // ── 万相2.7 异步含图编辑(A_EDIT)──
  // 查证(2026-06 官方):端点 POST /services/aigc/image-generation/generation(X-DashScope-Async: enable)
  //   input.messages[0].content = [{image:url}...,{text:prompt}]  parameters: { size, n, watermark, bbox_list? }
  //   →  output.task_id;GET /tasks/:id 轮询;成功 output.choices[0].message.content[].image(数组,多图)。
  //   bbox_list 仅万相2.7 支持(局部重绘框选);长度须 = 输入图数,空框图传 []。
  // 参考:https://help.aliyun.com/zh/model-studio/wan-image-edit
  async submitImageEdit(input: ImageGenInput): Promise<string> {
    const def = getImageModel(input.model, 'img2img');
    const n = Math.min(def.maxImages, Math.max(1, Math.floor(input.count ?? 1)));
    const content: Array<{ image: string } | { text: string }> = (input.imageRefs ?? []).map((u) => ({ image: u }));
    content.push({ text: input.prompt });
    const params: Record<string, unknown> = {
      n,
      watermark: false,
      ...sizeParams(def, input.ratio, input.resolution, { width: input.width, height: input.height }),
      ...seedParam(input.seed),
    };
    if (def.supportsBbox && Array.isArray(input.bboxList) && input.bboxList.length) params.bbox_list = input.bboxList;
    const { status, json } = await httpJson(
      'POST',
      '/services/aigc/image-generation/generation',
      { model: def.modelId, input: { messages: [{ role: 'user', content }] }, parameters: params },
      { 'X-DashScope-Async': 'enable' },
    );
    if (status !== 200) {
      throw new Error(`万相2.7 编辑提交失败 HTTP ${status}: ${JSON.stringify(json?.message ?? json)}`);
    }
    const taskId: string | undefined = json?.output?.task_id;
    if (!taskId) {
      throw new Error(`万相2.7 编辑未返回 task_id: ${JSON.stringify(json?.output ?? json)}`);
    }
    return taskId;
  }

  /** 提交文生视频(HappyHorse/万相2.7/可灵)。按 shape 组体,统一端点 + 异步头,取 output.task_id。
   *
   *  请求体形(spec review R3 + 文档核实):
   *    V_DASH(happyhorse/wan2.7):
   *      input: { prompt[, negative_prompt] }
   *      parameters: { resolution, ratio, duration, watermark:false[, prompt_extend][, seed] }
   *    V_KLING(可灵,modelId 带 kling/ 前缀):
   *      input: { prompt }
   *      parameters: { mode, aspect_ratio, duration, audio, watermark:false }
   *
   *  ⚠️ 成品轮询走 fetchJobStatus(三家与 s2v 同 /tasks/{id} + 顶层 output.video_url)。
   *     T2 硬验证门:实测三家真实回包字段 + 状态字面量 + 可灵 watermark_video_url(取非水印 video_url)。 */
  async submitVideoT2V(input: VideoGenT2VInput): Promise<string> {
    const def = getVideoModel(input.model);
    const isEdit = input.task === 'edit';
    // ⚠ 编辑任务不发 duration(发了会把输入视频截到该秒数);仅 wan 截断参数显式生效。
    //   watermark 恒显式 false:HappyHorse 编辑厂商默认 true(烙「Happy Horse」角标)。
    const duration = input.durationSnapshot ?? input.duration ?? def.defaultDuration;
    const parameters: Record<string, unknown> = isEdit
      ? { watermark: false }
      : { duration, watermark: false };
    if (isEdit && def.supportsTruncate && input.truncateDuration) {
      parameters.duration = input.truncateDuration; // wan 编辑:从 0 秒截取至该长度(2-10s)
    }
    if (isEdit && input.audioSetting === 'origin') {
      parameters.audio_setting = 'origin'; // 保留原声;auto 为厂商默认,缺省不发
    }
    const reqInput: Record<string, unknown> = {};
    // prompt:i2v 首帧/首尾帧、wan 编辑可选 → 空则不发;t2v/参考生/HH 编辑必填(build 已挡)。
    if (input.prompt && input.prompt.trim()) reqInput.prompt = input.prompt;

    // ── media 组装:编辑 = [{video}] + 0..N reference_image;i2v 按 task 组(R3.1)。
    //    videoRef/imageRefs 已是 worker publish 的公网 URL。
    if (isEdit && input.videoRef) {
      reqInput.media = [
        { type: 'video', url: input.videoRef },
        ...(input.imageRefs ?? []).map((url) => ({ type: 'reference_image', url })),
      ];
    } else if (input.task && Array.isArray(input.imageRefs) && input.imageRefs.length) {
      reqInput.media = buildMedia(input.task, input.imageRefs);
    }

    if (def.shape === 'V_KLING') {
      // 可灵:mode(std/pro)+ aspect_ratio + audio。无 resolution 字段(R3:档由 mode 决定)。
      parameters.mode = input.mode ?? 'std';
      parameters.aspect_ratio = input.ratio ?? '16:9';
      parameters.audio = def.supportsAudio ? !!input.audio : false;
    } else {
      // V_DASH:resolution(720P/1080P)。ratio 仅当模型声明(参考生有、i2v 首帧跟首帧不传)。
      parameters.resolution = input.resolution ?? '720P';
      if (def.ratios.length && input.ratio) parameters.ratio = input.ratio;
      if (def.supportsPromptExtend) parameters.prompt_extend = input.promptExtend ?? true;
      if (def.supportsNegative && input.negativePrompt) reqInput.negative_prompt = input.negativePrompt;
    }
    if (typeof input.seed === 'number') parameters.seed = input.seed;

    const { status, json } = await httpJson(
      'POST',
      '/services/aigc/video-generation/video-synthesis',
      { model: def.modelId, input: reqInput, parameters },
      { 'X-DashScope-Async': 'enable' },
    );
    if (status !== 200) {
      throw new Error(`文生视频提交失败 HTTP ${status}: ${JSON.stringify(json?.message ?? json)}`);
    }
    const taskId: string | undefined = json?.output?.task_id;
    if (!taskId) {
      throw new Error(`文生视频未返回 task_id: ${JSON.stringify(json?.output ?? json)}`);
    }
    return taskId;
  }

  async fetchImageStatus(providerTaskId: string): Promise<ImageJobResult> {
    const { status, json } = await httpJson('GET', `/tasks/${providerTaskId}`);
    if (status !== 200) {
      return { status: 'failed', error: `查询图片任务失败 HTTP ${status}` };
    }
    const out = json?.output ?? {};
    const normalized = normalizeStatus(out.task_status);
    const result: ImageJobResult = { status: normalized };
    if (typeof out.progress === 'number') result.progress = out.progress;
    if (normalized === 'succeeded') {
      result.imageUrls = parseImageUrls(out);
    }
    if (normalized === 'failed') {
      result.error = out.message ?? out.code ?? '百炼图片任务失败';
    }
    return result;
  }

  // ── 图生图(qwen-image-edit,同步)──
  // 查证(2026-06 官方):端点 POST /services/aigc/multimodal-generation/generation(无 async 头,同步直返)。
  //   input.messages[0].content = [{image:url}...,{text:prompt}]  parameters{n,size}
  //   →  output.choices[0].message.content[].image(成品图 URL 数组,24h 过期)。
  // signal 做硬超时(外部声音 P2):同步调无 poll 循环,挂连接会冻 worker。
  // 参考:https://help.aliyun.com/zh/model-studio/qwen-image-edit-api
  async editImage(input: ImageEditInput, signal: AbortSignal): Promise<string[]> {
    // model 从 registry(P1-c:删 config.imageEditModel 读)。img2img 缺省走编辑默认。
    const def = getImageModel(input.model, 'img2img');
    const content: Array<{ image: string } | { text: string }> = input.imageUrls.map((u) => ({
      image: u,
    }));
    content.push({ text: input.prompt });
    // 出图张数:按 model maxImages clamp(千问2.0 Pro=6 可多出;qwen-image-edit=1 固定 1)。
    const n = Math.min(def.maxImages, Math.max(1, Math.floor(input.count ?? 1)));
    return callMultimodalSync(
      def.modelId,
      content,
      { n: String(n), ...sizeParams(def, input.ratio, input.resolution, { width: (input as ImageGenInput).width, height: (input as ImageGenInput).height }), ...seedParam(input.seed) },
      signal,
    );
  }

  // 同步文生图(S 形状,纯文本 content,无输入图)。eng 外部声音 P1-a:
  // editImage 必填 imageUrls,S 模型 text2img 需独立方法;content=[{text}](非空,不触 P3-b 空 content 抛错)。
  async generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<string[]> {
    const def = getImageModel(input.model);
    const content: Array<{ text: string }> = [{ text: input.prompt }];
    const n = Math.min(def.maxImages, Math.max(1, Math.floor(input.count ?? 1)));
    return callMultimodalSync(
      def.modelId,
      content,
      { n: String(n), ...sizeParams(def, input.ratio, input.resolution, { width: (input as ImageGenInput).width, height: (input as ImageGenInput).height }), ...seedParam(input.seed) },
      signal,
    );
  }
}

// S 形状共用:同步 multimodal-generation/generation 调用 + 解析 choices[].content[].image。
// 外部声音核实:choices 非 results;同步无 poll,AbortController 是唯一防冻 worker 保障。
async function callMultimodalSync(
  modelId: string,
  content: Array<Record<string, string>>,
  extraParams: Record<string, string | number>,
  signal: AbortSignal,
): Promise<string[]> {
  const params: Record<string, unknown> = { watermark: false, ...extraParams };
  if (params.n !== undefined) params.n = Number(params.n);
  else params.n = 1;
  const { status, json } = await httpJson(
    'POST',
    '/services/aigc/multimodal-generation/generation',
    {
      model: modelId,
      input: { messages: [{ role: 'user', content }] },
      parameters: params,
    },
    {}, // 同步,无 X-DashScope-Async 头
    signal,
  );
  if (status !== 200) {
    throw new Error(`百炼图像(同步)失败 HTTP ${status}: ${JSON.stringify(json?.message ?? json)}`);
  }
  const parts = json?.output?.choices?.[0]?.message?.content;
  const urls: string[] = Array.isArray(parts)
    ? parts.map((p: { image?: string }) => p?.image).filter((u: unknown): u is string => typeof u === 'string')
    : [];
  if (urls.length === 0) {
    throw new Error(`百炼图像无成品(可能内容被拒):${JSON.stringify(json?.output ?? json).slice(0, 300)}`);
  }
  return urls;
}

// (比例 + 分辨率)→ qwen-image size 参数(W*H)。
// 比例决定长宽比,分辨率决定边长基数。占位映射,按控制台实际支持尺寸调整。
const RES_BASE: Record<string, number> = { '1K': 1024, '2K': 1440, '4K': 2048 };
// 比例 → [宽系数, 高系数](归一到基数)。auto/未知 → 1:1。
const RATIO_WH: Record<string, [number, number]> = {
  '1:1': [1, 1],
  '16:9': [16, 9],
  '9:16': [9, 16],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '3:2': [3, 2],
  '2:3': [2, 3],
};
// 成品图 URL 双解析:文生图异步回 output.results[].url;万相2.7 含图编辑回
// output.choices[0].message.content[].image(多模态体)。两种都取,过滤非字符串。
function parseImageUrls(out: any): string[] {
  // 1) results[].url(qwen-image / wan2.2 文生图异步)
  if (Array.isArray(out?.results)) {
    return out.results
      .map((r: { url?: string }) => r?.url)
      .filter((u: unknown): u is string => typeof u === 'string');
  }
  // 2) choices[].message.content[].image(万相2.7 异步编辑多模态回包)
  const urls: string[] = [];
  const choices = Array.isArray(out?.choices) ? out.choices : [];
  for (const c of choices) {
    const content = c?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item && typeof item.image === 'string') urls.push(item.image);
    }
  }
  return urls;
}

// seed 透传(A4):有效整数 → { seed:n };空/未传/非法 → {}(不加字段 = 随机)。
function seedParam(seed?: number): Record<string, number> {
  if (typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 2147483647) {
    return { seed };
  }
  return {};
}

export function imageSize(ratio?: string, resolution?: string): string {
  const base = RES_BASE[resolution ?? '1K'] ?? 1024;
  const [rw, rh] = RATIO_WH[ratio ?? '1:1'] ?? [1, 1];
  // 以较长边贴近 base,按比例算另一边,8 像素对齐(多数模型要求 8 倍数)。
  const long = base;
  const short = Math.round((base * Math.min(rw, rh)) / Math.max(rw, rh) / 8) * 8;
  const [w, h] = rw >= rh ? [long, short] : [short, long];
  return `${w}*${h}`;
}

/** 解析模型 key 的接入厂商(PR-2a)。查 image/video 注册表的 provider 字段;缺省/未知 → 'bailian'。 */
export function providerForModel(modelKey?: string): string {
  if (!modelKey) return 'bailian';
  if (isKnownVideoModel(modelKey)) return getVideoModel(modelKey).provider ?? 'bailian';
  if (isKnownModel(modelKey)) return getImageModel(modelKey).provider ?? 'bailian';
  return 'bailian'; // 未知 key 走百炼(老 job 兼容)
}

// 适配器单例(无状态,复用一份即可)。
const _bailian = new BaichuanGateway();
let _ark: ArkGateway | null = null;

/**
 * 网关工厂 —— 按模型选 provider 适配器(PR-2a:多 provider 抽象)。
 * 入参从 tenantId 改为 modelKey(eng-review:7 处 worker 调用点同步改)。
 *   - 模型 provider='bailian'(或未指定/未知)→ 百炼适配器(行为与改造前完全一致,零变更)。
 *   - 模型 provider='volc-ark' → 火山(豆包)适配器。
 * 返回类型仍是 CapabilityGateway(接口不变);同步图片走 SyncImageGateway(两适配器都实现)。
 */
export function getGateway(modelKey?: string): CapabilityGateway {
  const provider = providerForModel(modelKey);
  if (provider === 'volc-ark') return (_ark ??= new ArkGateway());
  return _bailian; // 默认百炼(s2v/未知/bailian 模型)
}
