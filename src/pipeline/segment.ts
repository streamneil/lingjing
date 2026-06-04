// 灵镜 长文案分段 — 把超过 wan2.2-s2v 单次 20s 上限的文案切成多段。
//
// 背景:百炼 wan2.2-s2v 托管 API 硬限驱动音频 <20s(官方文档)。长文案需切成
// <20s 的片段逐段生成,再 ffmpeg 拼接成一条完整视频。本模块只负责"文案层"切分:
// 按句子边界贪心打包,每段估算时长留安全余量(<18s),避免实际 TTS 后踩 20s 红线。
//
// 估算:中文播报约 5 字/秒(rate=1)。18s ≈ 90 字。rate 越快每段可装越多字,
// 但保守按 rate=1 估,实际更短更安全;worker 仍会用 probeAudioDuration 兜底校验。

// 每段目标字数上限(保守:90 字 ≈ 18s < 20s 硬限,留 2s 余量)。
const SAFE_CHARS_PER_SEGMENT = 90;

// 句子结束符(中英文):用于在自然边界切分,避免把一句话拦腰截断。
const SENTENCE_END = /([。！？!?；;\n])/;

/**
 * 把文案切成多段,每段 ≤ maxChars(默认 90)。
 * 策略:先按句子边界分句,再贪心打包进段;单句超长则按字数硬切(罕见,如无标点长句)。
 * 返回非空段数组;空/纯空白文案返回 []。
 */
export function segmentScript(script: string, maxChars = SAFE_CHARS_PER_SEGMENT): string[] {
  const trimmed = script.trim();
  if (!trimmed) return [];

  // 1. 按句末标点切句(保留标点)。
  const sentences: string[] = [];
  let buf = '';
  for (const part of trimmed.split(SENTENCE_END)) {
    if (part === '') continue;
    if (SENTENCE_END.test(part) && part.length === 1) {
      buf += part; // 标点附到当前句尾
      sentences.push(buf);
      buf = '';
    } else {
      buf += part;
    }
  }
  if (buf.trim()) sentences.push(buf);

  // 2. 贪心打包 + 单句硬切兜底。
  const segments: string[] = [];
  let cur = '';
  const flush = () => { if (cur.trim()) segments.push(cur.trim()); cur = ''; };
  for (const s of sentences) {
    if (s.length > maxChars) {
      // 单句超长(无标点长句):先冲掉当前段,再把这句按 maxChars 硬切。
      flush();
      for (let i = 0; i < s.length; i += maxChars) {
        segments.push(s.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if ((cur + s).length > maxChars) flush();
    cur += s;
  }
  flush();
  return segments;
}
