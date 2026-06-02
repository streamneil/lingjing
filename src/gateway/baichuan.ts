// 灵镜 能力网关 — 百炼(DashScope)适配器。
//
// 已由 context7 文档 + 连通性探针确认:百炼是 submit→轮询 task_status 的异步范式
// (X-DashScope-Async: enable 头提交,GET /tasks/:id 轮询,task_status: SUCCEEDED/FAILED)。
// 因此 fetchJobStatus 走 GET /tasks/:id;poll 模式是默认与私有化兜底。
//
// ⚠️ C-research 待补(标 TODO 处):数字人视频生成的真实 model 名、generation 路径、
//    input 字段 schema —— 需以你百炼控制台"数字人/视频生成"开通后的 API 文档为准。
//    其余(认证、异步范式、轮询、错误处理)均为真实可用代码。

import { config } from '../config.js';
import type {
  CapabilityGateway,
  VideoGenInput,
  ProviderJobResult,
  ProviderJobStatus,
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
  async submitVideo(input: VideoGenInput): Promise<string> {
    const model = config.baichuan.avatarModel;
    if (!model) {
      throw new Error(
        '未配置 BAICHUAN_AVATAR_MODEL。开通百炼数字人后,把真实 model 名填进 .env(见 C-research)。',
      );
    }

    // TODO(C-research): generation 路径与 input 字段以真实数字人 API 文档为准。
    // 下面是百炼异步任务的通用形态(参考 VideoSynthesis / ImageSynthesis 范式)。
    const { status, json } = await httpJson(
      'POST',
      '/services/aigc/video-generation/generation',
      {
        model,
        input: {
          avatar: input.avatarRef,
          voice: input.voiceRef,
          text: input.script,
        },
        parameters: {
          resolution: input.resolution ?? '1080P',
          ratio: input.ratio ?? '16:9',
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
      // TODO(C-research): 成品 URL 字段名以真实返回为准(video_url / results[0].url)。
      result.videoUrl = out.video_url ?? out.results?.[0]?.url;
      // C-code 探明:成品是否自带 AI 标识。暂按 none(需我方后处理),探明后改。
      result.aiLabel = 'none';
    }
    if (normalized === 'failed') {
      result.error = out.message ?? out.code ?? '百炼任务失败';
    }
    return result;
  }
}

/**
 * 网关工厂 —— 厂商凭证/实现的切换点(护城河:一套代码两种交付)。
 * Slice1 单租户:返回平台百炼网关。
 * Slice2 多租户 + 私有化:按 tenant 的厂商凭证配置返回对应网关(客户自有 key)。
 */
export function getGateway(_tenantId: string = config.defaultTenantId): CapabilityGateway {
  return new BaichuanGateway();
}
