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
import type {
  CapabilityGateway,
  VideoSubmitUrls,
  ProviderJobResult,
  ProviderJobStatus,
  ImageGenInput,
  ImageJobResult,
} from './types.js';

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.baichuan.apiKey()}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function httpJson(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${config.baichuan.baseUrl}${path}`, {
    method,
    headers: authHeaders(extraHeaders),
    body: body ? JSON.stringify(body) : undefined,
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

export class BaichuanGateway implements CapabilityGateway {
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
    const model = config.baichuan.imageModel || 'qwen-image';
    const n = Math.min(4, Math.max(1, Math.floor(input.count ?? 1)));
    const { status, json } = await httpJson(
      'POST',
      '/services/aigc/text2image/image-synthesis/',
      {
        model,
        input: { prompt: input.prompt },
        parameters: { n, size: IMG_SIZE[input.resolution ?? '1K'] ?? IMG_SIZE['1K'] },
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
      // ⚠️ results 是数组(与视频 video_url 对象不同),逐元素取 url。
      const arr = Array.isArray(out.results) ? out.results : [];
      result.imageUrls = arr
        .map((r: { url?: string }) => r?.url)
        .filter((u: unknown): u is string => typeof u === 'string');
    }
    if (normalized === 'failed') {
      result.error = out.message ?? out.code ?? '百炼文生图任务失败';
    }
    return result;
  }
}

// 分辨率档 → qwen-image size 参数(占位映射,按控制台实际支持尺寸调整)。
const IMG_SIZE: Record<string, string> = {
  '1K': '1024*1024',
  '2K': '1440*1440',
  '4K': '2048*2048',
};

/**
 * 网关工厂 —— 厂商凭证/实现的切换点(护城河:一套代码两种交付)。
 * Slice1 单租户:返回平台百炼网关。
 * Slice2 多租户 + 私有化:按 tenant 的厂商凭证配置返回对应网关(客户自有 key)。
 */
export function getGateway(_tenantId: string = config.defaultTenantId): CapabilityGateway {
  return new BaichuanGateway();
}
