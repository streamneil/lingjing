// 灵镜 — Qwen-TTS 合成(全 HTTP MultiModalConversation;零 CosyVoice)。
//
// 查证(2026-06,阿里官方):Qwen-TTS 走 HTTP MultiModalConversation
// (POST /services/aigc/multimodal-generation/generation)。系统音色/复刻(VC)/设计(VD)
// 全经此接口合成;指令控制(情绪/音调)用 instructions,仅 qwen3-tts-instruct-flash 系统音色支持。
// 响应可能是 output.audio.url(签名 URL,24h 过期)或 output.audio.data(base64 内联),
// 随模型/参数而异 → 双解析,统一返 Buffer(worker 统一 putObject 拿公网 URL 喂 wan2.2-s2v)。

import { config } from '../config.js';

export interface TtsParams {
  text: string;
  voice: string; // Qwen 系统音色名(如 'Cherry')或复刻/设计产出的 voice_id
  model?: string; // qwen3-tts-flash / qwen3-tts-instruct-flash / vc / vd
  instruction?: string; // 指令控制(情绪/音调,自然语言);仅 qwen3-tts-instruct-flash 有效
  languageType?: string; // 合成语种(input.language_type;Chinese/English/… )。缺省=不下发(模型自判)。
}

/**
 * Qwen-TTS HTTP 合成单段文本,返音频 Buffer。
 * voice 为系统音色名或设计/复刻产出的 voice_id;model 见 resolveVoice。
 * 双解析:优先 output.audio.url(fetch),否则 output.audio.data(base64 decode)。
 */
export async function synthesizeSpeechHttp(params: TtsParams): Promise<Buffer> {
  const apiKey = config.baichuan.apiKey();
  const res = await fetch(
    `${config.baichuan.baseUrl}/services/aigc/multimodal-generation/generation`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        // Qwen-TTS 指令控制用 instructions(复数);Qwen 无 pitch 参数,折进指令文本。
        input: {
          text: params.text,
          voice: params.voice,
          ...(params.instruction ? { instructions: params.instruction } : {}),
          ...(params.languageType ? { language_type: params.languageType } : {}),
        },
      }),
    },
  );
  const json = (await res.json().catch(() => ({}))) as {
    output?: { audio?: { url?: string; data?: string } };
    message?: string;
    code?: string;
  };
  if (res.status !== 200) {
    throw new Error(`Qwen-TTS 合成失败 HTTP ${res.status}: ${json.message ?? json.code ?? '未知错误'}`);
  }
  const audio = json.output?.audio;
  if (audio?.url) {
    // url 形式:拉取签名 URL 成 Buffer(URL 24h 过期,须当场取)
    const a = await fetch(audio.url);
    if (!a.ok) throw new Error(`Qwen-TTS 音频拉取失败 HTTP ${a.status}`);
    return Buffer.from(await a.arrayBuffer());
  }
  if (audio?.data) {
    // inline 形式:base64 解码
    return Buffer.from(audio.data, 'base64');
  }
  throw new Error('Qwen-TTS 合成无音频(output.audio.url/data 均空)');
}

// ── 声音复刻(Qwen-TTS VC)──
// 查证(2026-06,阿里官方 voice-cloning-user-guide):POST /services/audio/tts/customization,
// model=qwen-voice-enrollment,action=create,传 target_model(qwen3-tts-vc-*)+ preferred_name
// + audio.data(公网 URL 或 base64)→ 返回 output.voice(形如 voice_xxx)。
// 复刻 voice 配合同一 target_model(走 HTTP multimodal-generation)合成本人声音。零 CosyVoice。

/** 创建复刻音色(Qwen VC)。audioUrl 须公网可达(OSS 签名 URL);prefix 作 preferred_name。
 *  返回 Qwen voice id,存库后合成时当 voice 用(model=vcModel,http)。 */
export async function createClonedVoice(audioUrl: string, prefix: string): Promise<string> {
  const apiKey = config.baichuan.apiKey();
  const res = await fetch(`${config.baichuan.baseUrl}/services/audio/tts/customization`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: config.baichuan.vcModel,
        preferred_name: prefix,
        audio: { data: audioUrl },
      },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    output?: { voice?: string };
    message?: string;
    code?: string;
  };
  if (res.status !== 200 || !json.output?.voice) {
    throw new Error(`声音复刻失败 HTTP ${res.status}: ${json.message ?? json.code ?? '未知错误'}`);
  }
  return json.output.voice;
}

// ── 声音设计(voice design)──
// 查证(2026-06,阿里官方):POST /services/audio/tts/customization,model=qwen-voice-design,
// action=create,传 target_model(qwen3-tts-vd-*)+ preferred_name + voice_prompt + preview_text
// → 返回 output.voice(设计音色 id)+ output.preview_audio(base64 预览,可选)。
// 设计 voice 须用同 target_model(designModel,走 HTTP)合成,见 resolveVoice。

export interface DesignedVoiceResult {
  voiceId: string;
  previewAudio?: Buffer; // 预览音频(base64 解码),供前端试听确认后再用
}

/** 通过自然语言描述创建设计音色。voicePrompt 描述声音特质(≤2048 字),previewText 预览朗读文本。
 *  返回 Qwen voice id(存库当 voice 用)+ 可选预览音频 Buffer。 */
export async function createDesignedVoice(
  voicePrompt: string,
  previewText: string,
  preferredName: string,
): Promise<DesignedVoiceResult> {
  const apiKey = config.baichuan.apiKey();
  const res = await fetch(`${config.baichuan.baseUrl}/services/audio/tts/customization`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen-voice-design',
      input: {
        action: 'create',
        target_model: config.baichuan.designModel,
        preferred_name: preferredName,
        voice_prompt: voicePrompt,
        preview_text: previewText,
      },
      parameters: { sample_rate: 24000, response_format: 'wav' },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    output?: { voice?: string; preview_audio?: { data?: string } };
    message?: string;
    code?: string;
  };
  if (res.status !== 200 || !json.output?.voice) {
    throw new Error(`声音设计失败 HTTP ${res.status}: ${json.message ?? json.code ?? '未知错误'}`);
  }
  const previewData = json.output.preview_audio?.data;
  return {
    voiceId: json.output.voice,
    previewAudio: previewData ? Buffer.from(previewData, 'base64') : undefined,
  };
}
