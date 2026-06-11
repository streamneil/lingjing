// 灵镜 — TTS 情绪指令(T-TTS-EMOTION)。
//
// 全 Qwen-TTS:无「品质」模型选择。系统按是否带情绪自动选合成模型
// (无情绪 qwen3-tts-flash,有情绪 qwen3-tts-instruct-flash;见 worker.resolveVoice)。
// 计价扁价(credits.estimateTtsCost 默认 0.02/字),不再按模型分层。

// ── 情绪(T-TTS-EMOTION)──
// 情绪 key → 自然语言指令短语(透传给 instruct 模型的 instructions)。
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
