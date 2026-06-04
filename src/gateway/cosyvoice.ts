// 灵镜 — CosyVoice TTS(WebSocket)。
//
// 查证(2026-06,阿里官方文档):CosyVoice 系列只支持 WebSocket,不支持 HTTP REST,
// 且返回二进制音频流(不返回 URL)。协议:run-task → 等 task-started → continue-task(文本)
// → finish-task → 收音频帧 → task-finished。
// 因此:本模块把文案合成为音频 Buffer,由调用方(worker)上传 MinIO 拿公网 URL,
// 再喂给 wan2.2-s2v 的 audio_url。
//
// 参考:https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';

export interface TtsParams {
  text: string;
  voice: string; // 预置音色名(如 'longxiaochun' 等)或克隆音色 id
  model?: string; // 默认 cosyvoice-v2
  rate?: number; // 语速 0.5-2,默认 1(CosyVoice rate 参数)
  volume?: number; // 音量 0-100,默认 50(CosyVoice volume 参数)
}

/**
 * 合成语音,返回 MP3 音频 Buffer。
 * 走 WebSocket 三段式协议;把所有 binary 帧拼成完整音频。
 */
export function synthesizeSpeech(params: TtsParams): Promise<Buffer> {
  const apiKey = config.baichuan.apiKey();
  const model = params.model ?? config.baichuan.ttsModel;
  const taskId = randomUUID();

  return new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const chunks: Buffer[] = [];
    let started = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error('CosyVoice TTS 超时'));
    }, 60_000);

    ws.on('open', () => {
      // run-task:配置音色 + 输出格式
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model,
            parameters: {
              text_type: 'PlainText', voice: params.voice, format: 'mp3', sample_rate: 22050,
              rate: params.rate ?? 1, volume: params.volume ?? 50,
            },
            input: {},
          },
        }),
      );
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        chunks.push(data); // 音频帧
        return;
      }
      let evt: any;
      try { evt = JSON.parse(data.toString()); } catch { return; }
      const event = evt?.header?.event;
      if (event === 'task-started' && !started) {
        started = true;
        // continue-task:发文本
        ws.send(
          JSON.stringify({
            header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: { text: params.text } },
          }),
        );
        // finish-task:结束
        ws.send(
          JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} },
          }),
        );
      } else if (event === 'task-finished') {
        clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        resolve(Buffer.concat(chunks));
      } else if (event === 'task-failed') {
        clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        reject(new Error(`CosyVoice 失败: ${evt?.header?.error_message ?? '未知'}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

// ── 声音复刻(voice enrollment)──
// 查证(2026-06,阿里官方):POST /services/audio/tts/customization,model=voice-enrollment,
// action=create_voice,传 target_model + prefix + 公网音频 URL → 返回 output.voice_id。
// 复刻出的 voice_id(形如 cosyvoice-v1-<prefix>-xxxx)配合同一个 target_model 合成本人声音。
// 实测确认:target_model=cosyvoice-v1(新账号有免费额度),voice_id 直接传给 synthesizeSpeech 的 voice。

/** 创建复刻音色。audioUrl 须公网可达(OSS 签名 URL);prefix 仅数字+小写字母、<10 字符。
 *  返回百炼的 voice_id,存库后合成时当 voice 用。 */
export async function createClonedVoice(audioUrl: string, prefix: string): Promise<string> {
  const apiKey = config.baichuan.apiKey();
  const targetModel = config.baichuan.ttsModel; // 与合成同模型(cosyvoice-v1)
  const res = await fetch(`${config.baichuan.baseUrl}/services/audio/tts/customization`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'voice-enrollment',
      input: { action: 'create_voice', target_model: targetModel, prefix, url: audioUrl },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    output?: { voice_id?: string };
    message?: string;
    code?: string;
  };
  if (res.status !== 200 || !json.output?.voice_id) {
    throw new Error(`声音复刻失败 HTTP ${res.status}: ${json.message ?? json.code ?? '未知错误'}`);
  }
  return json.output.voice_id;
}
