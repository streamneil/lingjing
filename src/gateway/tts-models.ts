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

// ── 语速(T-TTS-EMOTION 同机制)──
// Qwen-TTS 无精确倍速参数,语速经自然语言指令(instructions)控制,仅 instruct 模型生效。
// 故语速做成档位 key(非倍速数值),'normal' = 不加指令(默认)。
export const SPEEDS: Record<string, EmotionDef> = {
  slow: { key: 'slow', label: '缓慢', instruction: '请用缓慢的语速朗读。' },
  slower: { key: 'slower', label: '偏慢', instruction: '请把语速放慢一些。' },
  normal: { key: 'normal', label: '中速', instruction: '' },
  faster: { key: 'faster', label: '偏快', instruction: '请把语速加快一些。' },
  fast: { key: 'fast', label: '快速', instruction: '请用较快的语速朗读。' },
};

export function getSpeed(key: string | undefined): EmotionDef | undefined {
  return key ? SPEEDS[key] : undefined;
}

// ── 语言(language_type)──
// 查证(2026-06,DashScope 实测):Qwen-TTS 经 input.language_type 指定合成语种,
// 已实测接受值:Auto / Chinese / English / Japanese / Korean / French / German /
// Russian / Italian / Spanish / Portuguese(方言绑定音色,非 language_type,不在此列)。
// 'Auto' = 由模型按文本自动判断(默认,不下发该字段保 byte-identical)。
export interface LanguageDef {
  key: string; // = API language_type 值(Auto 例外:表示不下发)
  label: string; // UI 中文标签
}

export const LANGUAGES: Record<string, LanguageDef> = {
  Auto: { key: 'Auto', label: '自动' },
  Chinese: { key: 'Chinese', label: '中文' },
  English: { key: 'English', label: '英语' },
  Japanese: { key: 'Japanese', label: '日语' },
  Korean: { key: 'Korean', label: '韩语' },
  French: { key: 'French', label: '法语' },
  German: { key: 'German', label: '德语' },
  Russian: { key: 'Russian', label: '俄语' },
  Italian: { key: 'Italian', label: '意大利语' },
  Spanish: { key: 'Spanish', label: '西班牙语' },
  Portuguese: { key: 'Portuguese', label: '葡萄牙语' },
};

export function getLanguage(key: string | undefined): LanguageDef | undefined {
  return key ? LANGUAGES[key] : undefined;
}

/** 合成情绪 + 语速 + 音高 → 一条 instruction 文本(供 gateway 透传)。全无 → 空串。 */
export function buildInstruction(emotionKey?: string, pitch?: number, speedKey?: string): string {
  const parts: string[] = [];
  const emo = getEmotion(emotionKey);
  if (emo && emo.instruction) parts.push(emo.instruction);
  const spd = getSpeed(speedKey);
  if (spd && spd.instruction) parts.push(spd.instruction);
  if (typeof pitch === 'number' && pitch !== 0)
    parts.push(pitch > 0 ? '请把音调略微提高。' : '请把音调略微压低。');
  return parts.join('');
}
