// 灵镜 — TTS 品质模型注册表(T-TTS-QUALITY-MODEL)。
//
// 文字转语音的「品质」下拉选模型;不同模型音质/价格分层。
// 关键约束:模型与音色的**传输**必须配套 —— 预置/克隆音色走 CosyVoice WebSocket,
// 设计音色走 Qwen HTTP(见 worker.resolveVoice)。故品质下拉须按所选音色的 transport 过滤,
// 跨传输选模型会被 buildTtsJob 拒(400)。
//
// 计价:pricePerChar 替代 credits 里的扁价常量(reserve==settle 由 buildTtsJob 快照守)。
// cosyvoice-v1 = 0.02(与历史扁价一致,默认不选模型时 byte-identical)。

export type TtsTransport = 'ws' | 'http';

export interface TtsModelDef {
  key: string; // input.model 存它;UI 传它
  modelId: string; // 传给网关的真实模型名(synthesizeSpeech/synthesizeSpeechHttp 的 model)
  label: string; // UI 标签
  transport: TtsTransport; // ws=CosyVoice WebSocket;http=Qwen/MiniMax MultiModalConversation
  pricePerChar: number; // 每字计价(替代 credits 扁价;reserve==settle 由快照守)
  supportsInstruction: boolean; // 是否支持指令控制(情绪/音高,T-TTS-EMOTION 用)
}

export const TTS_MODELS: Record<string, TtsModelDef> = {
  'cosyvoice-v1': {
    key: 'cosyvoice-v1', modelId: 'cosyvoice-v1', label: '标准(免费额度)',
    transport: 'ws', pricePerChar: 0.02, supportsInstruction: false,
  },
  'cosyvoice-v3.5-flash': {
    key: 'cosyvoice-v3.5-flash', modelId: 'cosyvoice-v3.5-flash', label: '高保真(CosyVoice 3.5)',
    transport: 'ws', pricePerChar: 0.05, supportsInstruction: true,
  },
  'qwen3-tts-flash': {
    key: 'qwen3-tts-flash', modelId: 'qwen3-tts-flash', label: '千问3-TTS(自然)',
    transport: 'http', pricePerChar: 0.04, supportsInstruction: false,
  },
  'qwen3-tts-instruct-flash': {
    key: 'qwen3-tts-instruct-flash', modelId: 'qwen3-tts-instruct-flash', label: '千问3-TTS 指令(情绪)',
    transport: 'http', pricePerChar: 0.06, supportsInstruction: true,
  },
};

/** 某传输下的可选模型(品质下拉按所选音色 transport 过滤)。 */
export function listTtsModels(transport: TtsTransport): TtsModelDef[] {
  return Object.values(TTS_MODELS).filter((m) => m.transport === transport);
}

/** 按 key 取模型定义;未知 → undefined。 */
export function getTtsModel(key: string | undefined): TtsModelDef | undefined {
  return key ? TTS_MODELS[key] : undefined;
}

// ── 情绪(T-TTS-EMOTION)──
// 情绪 key → 自然语言指令短语(透传给 supportsInstruction 模型的 instruction/instructions)。
// 'auto' = 不加指令(模型自行判断)。
export interface EmotionDef {
  key: string;
  label: string;
  instruction: string; // 空串 = 不加指令
}

export const EMOTIONS: Record<string, EmotionDef> = {
  auto: { key: 'auto', label: '自动', instruction: '' },
  cheerful: { key: 'cheerful', label: '开朗', instruction: '请用开朗愉悦的语气表达。' },
  calm: { key: 'calm', label: '沉稳', instruction: '请用沉稳平和的语气表达。' },
  gentle: { key: 'gentle', label: '温柔', instruction: '请用温柔亲切的语气表达。' },
  serious: { key: 'serious', label: '严肃', instruction: '请用严肃正式的语气表达。' },
  lively: { key: 'lively', label: '活泼', instruction: '请用活泼生动的语气表达。' },
  healing: { key: 'healing', label: '治愈', instruction: '请用温暖治愈的语气表达。' },
};

export function getEmotion(key: string | undefined): EmotionDef | undefined {
  return key ? EMOTIONS[key] : undefined;
}

/** 合成情绪 + 音高 → 一条 instruction 文本(供 gateway 透传)。无情绪无音高 → 空串。 */
export function buildInstruction(emotionKey?: string, pitch?: number): string {
  const parts: string[] = [];
  const emo = getEmotion(emotionKey);
  if (emo && emo.instruction) parts.push(emo.instruction);
  if (typeof pitch === 'number' && pitch !== 0)
    parts.push(pitch > 0 ? '请把音调略微提高。' : '请把音调略微压低。');
  return parts.join('');
}
