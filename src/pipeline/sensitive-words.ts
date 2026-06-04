// 灵镜 合规 — 本地敏感词表(过渡方案)。
//
// 决策来源:/plan-ceo-review 项目收尾 D6 —— 内容审核先用本地敏感词表过渡,
// 真实 API(阿里云内容安全 Green)记 TODO(T-MODERATION-API)。
//
// ⚠️ 这是过渡方案,覆盖有限,不能替代真实内容检测。融媒体/政企正式交付前
//    应接阿里云内容安全或同等服务。词表按类别组织,便于人工维护与扩充。
//
// 匹配策略:大小写无关 + 去除空白干扰(防"敏 感 词"绕过)的简单子串匹配。
// 不做复杂的拼音/谐音/变体识别 —— 那是真实 API 的职责。

// 类别化词表(seed)。生产可从外部配置/DB 加载;此处内置一份基础集。
export const SENSITIVE_WORDS: Record<string, string[]> = {
  // 涉政敏感(示例 seed,正式交付需按属地宣传/网信要求扩充)
  political: ['法轮功', '反共', '颠覆国家', '台独', '港独', '疆独', '藏独'],
  // 违禁/违法
  prohibited: ['赌博', '毒品', '枪支', '爆炸物', '制毒', '贩毒'],
  // 涉黄涉暴(基础)
  vulgar: ['色情', '裸聊', '嫖娼'],
};

// 扁平化词表(去重),用于快速匹配。
const FLAT_WORDS: string[] = Array.from(
  new Set(Object.values(SENSITIVE_WORDS).flat()),
).filter((w) => w.length > 0);

/** 命中检测:返回第一个命中的敏感词,未命中返回 null。
 *  归一化:小写 + 去所有空白,削弱"空格拆字"类的低级绕过。 */
export function findSensitiveWord(text: string): string | null {
  const normalized = text.toLowerCase().replace(/\s+/g, '');
  for (const word of FLAT_WORDS) {
    if (normalized.includes(word.toLowerCase())) return word;
  }
  return null;
}
