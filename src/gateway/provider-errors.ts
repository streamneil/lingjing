// 灵镜 厂商错误翻译 — 把 provider 的原始错误(火山方舟 / 阿里百炼 / Google Gemini)
// 翻译成「用户可读的中文提示」,同时保留「原始技术日志」供 admin 排障。
//
// 决策来源:用户反馈 —— 前端不能出现类似
//   火山视频提交失败 HTTP 400: {"code":"InputImageSensitiveContentDetected.PrivacyInformation",...}
// 这种英文/JSON;而 admin 消耗流水又需要看到完整原始日志(含 code / RequestId)排查根因。
//
// 设计(单一翻译点):所有失败最终都经 queue/index.ts 的 markFailed 落库,
//   markFailed 调用本模块 → error 列存中文可读、error_detail 列存原始日志。
//   因此本模块是纯函数、无外部依赖(可被 db 迁移回填历史行安全调用)。
//
// 匹配策略(按顺序,先命中先用):
//   1) 厂商错误码精确匹配(RULES,长/具体码在前,前缀码在后);
//   2) HTTP 状态 / 关键词兜底(fallback 分类);
//   3) 原文已是干净中文(无 HTTP/JSON/英文码特征)→ 原样透出;
//   4) 最终兜底 → 通用「生成失败,请稍后重试」。
// 无论哪条,detail 恒为原始输入(admin 永远能看到真相)。

/** 一条码规则:raw 中命中 pattern → 用 message 作为用户可读文案。 */
interface ErrorRule {
  pattern: RegExp;
  message: string;
}

// ── 厂商错误码 → 中文可读(节选自三家官方错误码文档,聚焦图/视频/音频生成场景)──
// 顺序即优先级:更具体的码(带 .PrivacyInformation / .PolicyViolation 后缀)必须排在其前缀码之前,
// 否则会被宽泛的前缀先命中。
const RULES: ErrorRule[] = [
  // —— 火山方舟(Volc Ark / 豆包)——
  { pattern: /Input(Image|Video)SensitiveContentDetected\.PrivacyInformation/, message: '输入的图片/视频可能包含真人肖像,火山内容安全策略暂不支持,请更换为非真人素材后重试。' },
  { pattern: /Input(Image|Video|Text|Audio)SensitiveContentDetected\.PolicyViolation/, message: '输入内容可能涉及版权限制,请更换素材后重试。' },
  { pattern: /Output(Video)SensitiveContentDetected\.PolicyViolation/, message: '生成的视频可能涉及版权限制,请更换提示词后重试。' },
  { pattern: /InputImageSensitiveContentDetected/, message: '输入图片可能包含敏感信息,请更换后重试。' },
  { pattern: /InputVideoSensitiveContentDetected/, message: '输入视频可能包含敏感信息,请更换后重试。' },
  { pattern: /InputAudioSensitiveContentDetected/, message: '输入音频可能包含敏感信息,请更换后重试。' },
  { pattern: /Input(Text)?SensitiveContentDetected\.SevereViolation/, message: '提示词可能包含严重违规信息,请更换提示词后重试。' },
  { pattern: /Input(Text)?SensitiveContentDetected\.Violence/, message: '提示词可能包含激进/暴力相关信息,请更换提示词后重试。' },
  { pattern: /Input(Text)?SensitiveContentDetected/, message: '提示词可能包含敏感信息,请调整提示词后重试。' },
  { pattern: /OutputImageSensitiveContentDetected/, message: '生成的图片可能包含敏感信息,请更换提示词后重试。' },
  { pattern: /OutputVideoSensitiveContentDetected/, message: '生成的视频可能包含敏感信息,请更换提示词后重试。' },
  { pattern: /Output(Audio|Text)SensitiveContentDetected/, message: '生成内容可能包含敏感信息,请更换提示词后重试。' },
  { pattern: /InputImageRiskDetection/, message: '输入图片被内容风控识别为敏感内容,请更换后重试。' },
  { pattern: /InputTextRiskDetection/, message: '提示词被内容风控识别为敏感内容,请调整后重试。' },
  { pattern: /Output(Image|Text)RiskDetection/, message: '生成内容被内容风控识别为敏感内容,请更换提示词后重试。' },
  { pattern: /OutofContextError|OutOfContext/, message: '输入的图文内容过长,超过模型上下文上限,请精简后重试。' },
  { pattern: /InvalidImageURL|InvalidImageURL\.(EmptyURL|InvalidFormat)|read image error|download image failed|Invalid image format/, message: '输入图片无法读取(可能格式不支持或图片已损坏),请更换图片后重试。' },

  // —— 阿里百炼(DashScope)——
  { pattern: /IPInfringementSuspect|IP infringement/, message: '输入内容涉嫌知识产权侵权,请更换素材后重试。' },
  { pattern: /DataInspectionFailed|data_inspection_failed|inappropriate content|绿网/, message: '输入或生成内容未通过内容安全审核,请更换素材/提示词后重试。' },
  { pattern: /InvalidFile\.NoHuman|has no human body/, message: '输入图片未检测到人物,请上传包含清晰单人的照片后重试。' },
  { pattern: /InvalidFile\.MultiHuman|multi human bodies/, message: '输入图片中包含多人,请上传单人照片后重试。' },
  { pattern: /InvalidFile\.(FacePose|FullFace|FrontBody|BodyPose|BodyProportion|FullBody)/, message: '输入图片中的人物姿态/构图不符合要求(需正面、清晰、完整),请更换后重试。' },
  { pattern: /InvalidFile\.Resolution|InvalidImageResolution|image resolution is invalid|size of image is too/, message: '输入图片分辨率不符合要求,请更换尺寸合适的图片后重试。' },
  { pattern: /InvalidFile\.(Size|ImageSize|Duration|AspectRatio|Format|FPS)|file size must|file duration must|file ratio/, message: '输入文件的大小/时长/比例/格式不符合要求,请更换后重试。' },
  { pattern: /File type is not supported|unsupported audio format|audio format is illegal|BadRequest\.UnsupportedFileFormat|Input files? format (is )?not supported|file format is not supported/i, message: '上传的音频/文件格式不支持,请更换为支持的格式(如 .wav / .mp3)后重试。' },
  { pattern: /audio (too short|duration|length)|AudioShortError|AudioLengthError|silent audio|AudioSilentError/i, message: '上传的音频不符合要求(过短 / 静音 / 时长超限),请更换后重试。' },
  { pattern: /Arrearage|AccountOverdue|account has an overdue|good standing|ServiceOverdue|BillOverdue/, message: '平台生成账户余额不足或已欠费,请联系平台管理员处理。' },

  // —— Google Gemini ——
  { pattern: /RESOURCE_EXHAUSTED|RECITATION/, message: '生成服务繁忙(已达速率上限),请稍后重试。' },
  { pattern: /FAILED_PRECONDITION/, message: '当前生成模型在本地区不可用,请联系平台管理员。' },
  { pattern: /(finishReason|BlockReason|blockReason)[^a-zA-Z]*(SAFETY|OTHER|PROHIBITED)|被安全策略拦|safety setting/, message: '生成内容被模型安全策略拦截,请更换提示词后重试。' },
  { pattern: /DEADLINE_EXCEEDED/, message: '生成超时,请稍后重试。' },

  // —— 跨厂商通用码 ——
  { pattern: /AuthenticationError|invalid api|api key|InvalidApiKey|PERMISSION_DENIED|AccessDenied|Unauthorized|AuthError/i, message: '生成通道鉴权异常(密钥失效或权限不足),请联系平台管理员。' },
  { pattern: /RateLimit|TooManyRequests|Throttling|ServerOverloaded|RequestBurstTooFast|ModelServingError|ServiceUnavailable|UNAVAILABLE|429/i, message: '生成服务繁忙,请稍后重试。' },
  { pattern: /InvalidParameter|MissingParameter|INVALID_ARGUMENT|BadRequest|不合法|not valid/i, message: '生成请求参数有误,请调整输入或稍后重试;若持续出现请联系客服。' },
  { pattern: /InternalServiceError|InternalServerError|InternalError|INTERNAL|ModelServiceFailed|inference error|500/i, message: '生成服务暂时异常,请稍后重试。' },
];

// HTTP 状态兜底(未命中任何码时,按状态给一句得体的中文)。
const HTTP_FALLBACK: Array<{ code: string; message: string }> = [
  { code: '401', message: '生成通道鉴权异常,请联系平台管理员。' },
  { code: '403', message: '生成通道无访问权限或账户异常,请联系平台管理员。' },
  { code: '429', message: '生成服务繁忙,请稍后重试。' },
  { code: '400', message: '生成请求被厂商拒绝(可能是内容或参数问题),请调整输入后重试。' },
  { code: '500', message: '生成服务暂时异常,请稍后重试。' },
  { code: '503', message: '生成服务暂时不可用,请稍后重试。' },
];

/** 原文是否「已是干净的中文提示」——无 HTTP 码、无 JSON 花括号、无明显英文错误码特征。
 *  这类通常是本平台自己抛的中文错误(如「排队超时…」「积分不足」),直接透出即可。 */
function isCleanChinese(raw: string): boolean {
  if (/HTTP\s*\d{3}|[{}]|RequestId|Request id|Request ID/i.test(raw)) return false;
  const hasChinese = /[一-龥]/.test(raw);
  // 含中文,且不含长串英文错误码(连续大小写混排 ≥12 字母)→ 视为干净中文。
  const hasLongAsciiCode = /[A-Za-z]{12,}/.test(raw.replace(/\s/g, ''));
  return hasChinese && !hasLongAsciiCode;
}

/**
 * 把任意 provider 原始错误翻译为 { readable(中文可读), detail(原始日志) }。
 * - detail 恒为原始输入(admin 消耗流水的「详情」永远能看到真相,含 code/RequestId)。
 * - readable 供前端 + admin 概要展示,绝不含英文 JSON。
 * 纯函数、幂等、无副作用。
 */
export function translateProviderError(raw: string | null | undefined): { readable: string; detail: string } {
  const detail = (raw ?? '').toString();
  const text = detail.trim();
  if (!text) return { readable: '生成失败,请稍后重试。', detail };

  // 1) 厂商错误码精确匹配
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { readable: rule.message, detail };
  }

  // 2) 原文已是干净中文 → 原样透出(本平台自抛的中文错误)
  if (isCleanChinese(text)) return { readable: text, detail };

  // 3) HTTP 状态兜底
  const httpMatch = text.match(/HTTP\s*(\d{3})|\b(\d{3})\b/);
  const status = httpMatch?.[1] ?? httpMatch?.[2];
  if (status) {
    const hit = HTTP_FALLBACK.find((h) => h.code === status);
    if (hit) return { readable: hit.message, detail };
  }

  // 4) 最终兜底
  return { readable: '生成失败,请稍后重试;若持续出现请联系客服。', detail };
}
