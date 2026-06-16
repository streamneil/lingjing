// 灵镜 — AI 音乐(Fun-Music)。
//
// 查证(2026-06,阿里官方):Fun-Music 走 HTTP,POST
// /services/audio/music/generation,同步返回 output.audio.url(MP3,24h 过期)。
// 计费按 usage.duration(秒)。prompt 与 lyrics 二选一(同传仅 lyrics 生效)。
// 邀测阶段 + 仅北京地域:未开通账号返 AccessDenied,错误原文透传给前端引导申请开通。
//
// 参考:https://help.aliyun.com/zh/model-studio/fun-music
// 本轮只做非流式(不发 X-DashScope-SSE);SSE 流式留后续。

import { config } from '../config.js';
import { getProviderKey } from './provider-keys.js'; // PR-1:key 从加密表取(回落 .env)

export interface MusicGenParams {
  model: string; // fun-music-preview / fun-music-v1
  prompt?: string; // 与 lyrics 二选一;模型据此自动创作歌词并谱曲
  lyrics?: string; // 与 prompt 二选一;同传仅 lyrics 生效
  gender?: 'male' | 'female'; // 演唱声音性别;纯音乐不传
  format?: 'mp3' | 'wav'; // 默认 mp3
}

export interface MusicGenResult {
  url: string; // 完整 MP3 的 OSS URL(24h 过期,worker 须当场拉进存储)
  lyrics: string; // extra_info.lyrics(AI 创作/回显歌词;纯音乐可能为空)
  duration: number; // usage.duration(秒),用于计费结算
}

/**
 * Fun-Music HTTP 生成单条歌曲/纯音乐,返回 {url, lyrics, duration}。
 * prompt 与 lyrics 至少传一个(由调用方/buildAiMusicJob 校验);同传仅 lyrics 生效。
 * 错误处理与 cosyvoice.synthesizeSpeechHttp 同口径:非 200 抛可读错误(透传邀测/地域原文)。
 */
export async function generateMusic(params: MusicGenParams): Promise<MusicGenResult> {
  const apiKey = getProviderKey('bailian');
  const res = await fetch(`${config.baichuan.baseUrl}/services/audio/music/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      input: {
        // lyrics 优先(API:同传仅 lyrics 生效);否则用 prompt。
        ...(params.lyrics ? { lyrics: params.lyrics } : { prompt: params.prompt }),
        ...(params.gender ? { gender: params.gender } : {}),
        ...(params.format ? { format: params.format } : {}),
      },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    output?: { audio?: { url?: string }; extra_info?: { lyrics?: string } };
    usage?: { duration?: number };
    message?: string;
    code?: string;
  };
  if (res.status !== 200) {
    // 透传原文(邀测未开通 = AccessDenied;非北京地域亦在此):前端据此引导申请开通。
    throw new Error(`音乐生成失败 HTTP ${res.status}: ${json.message ?? json.code ?? '未知错误'}`);
  }
  const url = json.output?.audio?.url;
  if (!url) throw new Error('音乐生成无音频(output.audio.url 为空)');
  return {
    url,
    lyrics: json.output?.extra_info?.lyrics ?? '',
    duration: typeof json.usage?.duration === 'number' ? json.usage.duration : 0,
  };
}
