// 灵镜 合规 — 内容送审钩子。
//
// 决策来源:/plan-eng-review D5 + 外部声音 #5 —— 对融媒体/政企客户,内容送审是
// 准入门槛(深度合成强监管),不是后期 filter。生成管线从 Slice1 就预留这个钩子,
// 这样二期接真实审核(百炼内容安全 / 阿里内容安全)时不用改动整个任务流。
//
// Slice 1:空实现(放行 + 记日志)。C-research 问清百炼送审能力后,在此接真实审核。

export interface ModerationVerdict {
  allowed: boolean;
  reason?: string; // 拒绝原因(用户可见)
}

/** 生成前:审文案。Slice1 放行,留接口。 */
export async function moderateScript(script: string): Promise<ModerationVerdict> {
  // TODO(二期): 接真实文本审核。Slice1 仅做最基础长度保护(命脉闭环约束)。
  if (script.trim().length === 0) {
    return { allowed: false, reason: '文案为空' };
  }
  if (script.length > 2000) {
    return { allowed: false, reason: '文案超过 2000 字上限' };
  }
  return { allowed: true };
}

/** 生成后:审成品(视频)。Slice1 放行,留接口。 */
export async function moderateOutput(_videoKeyOrUrl: string): Promise<ModerationVerdict> {
  // TODO(二期): 接真实成品审核(画面/音频违规检测)。
  return { allowed: true };
}
