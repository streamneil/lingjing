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
