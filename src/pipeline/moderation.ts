// 灵镜 合规 — 内容送审钩子。
//
// 决策来源:/plan-eng-review D5 + 外部声音 #5 —— 对融媒体/政企客户,内容送审是
// 准入门槛(深度合成强监管),不是后期 filter。生成管线从 Slice1 就预留这个钩子,
// 这样二期接真实审核(百炼内容安全 / 阿里内容安全)时不用改动整个任务流。
//
// 过渡方案:长度保护 + 本地敏感词表(见 sensitive-words.ts)。
// 真实文本/成品审核(阿里云内容安全 Green)记 TODO(T-MODERATION-API),
// 接入时只换本实现,worker 管线(worker.ts:80/146 调用)不动。

import { findSensitiveWord } from './sensitive-words.js';

export interface ModerationVerdict {
  allowed: boolean;
  reason?: string; // 拒绝原因(用户可见)
}

/** 生成前:审文案。长度保护 + 本地敏感词表。 */
export async function moderateScript(script: string): Promise<ModerationVerdict> {
  if (script.trim().length === 0) {
    return { allowed: false, reason: '文案为空' };
  }
  if (script.length > 2000) {
    return { allowed: false, reason: '文案超过 2000 字上限' };
  }
  // 本地敏感词表过渡:命中即拒,不向用户回显具体词(避免摸边界绕过)。
  const hit = findSensitiveWord(script);
  if (hit) {
    return { allowed: false, reason: '文案包含敏感内容,无法生成,请修改后重试' };
  }
  return { allowed: true };
}

/** 生成前:审 AI 图片提示词。同样的关键词表,但**无视频脚本的 2000 字限制**
 *  (图片提示词上限按 qwen-image 实际 ~800,过长在 adapter 侧报错;此处只管违规内容)。
 *  决策来源:/plan-ceo-review A3 + 外部声音 P2(moderateScript 的 2000 限是 video-specific)。 */
export async function moderatePrompt(prompt: string): Promise<ModerationVerdict> {
  if (prompt.trim().length === 0) {
    return { allowed: false, reason: '提示词为空' };
  }
  const hit = findSensitiveWord(prompt);
  if (hit) {
    return { allowed: false, reason: '提示词包含敏感内容,无法生成,请修改后重试' };
  }
  return { allowed: true };
}

/** 生成后:审成品(视频/图片)。当前放行(passthrough),留接口。
 *  ⚠️ 这是 passthrough hook,不做真实画面审核(从 Slice1 起就是)。
 *  二期接阿里云内容安全 Green(T-MODERATION-API)时只换本实现,worker 管线不动。 */
export async function moderateOutput(_outputKeyOrUrl: string): Promise<ModerationVerdict> {
  // TODO(二期,T-MODERATION-API): 接真实成品审核(画面/音频违规检测)。
  return { allowed: true };
}
