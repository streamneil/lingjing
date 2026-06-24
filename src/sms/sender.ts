// 灵镜 短信发送 — 可插拔 SmsSender(/plan-eng-review,2026-06-24)。
//
// 决策来源:/plan-ceo-review Approach B + /plan-eng-review。
//   接口 SmsSender → AliyunSmsSender(阿里云 Dysmsapi,手签 RPC,零新依赖)
//                  + ConsoleSmsSender(开发/私有化兜底:验证码打到服务端日志,
//                    前端流程照常,签名审批前可上线联调)。
// 自动选择:SMS_PROVIDER 显式指定优先;否则 aliyun 配齐(AK+签名+模板)则用,否则 console。
//
// 阿里云签名/模板需控制台单独审核(1-3 工作日)。审核前用 console,审核后配 env 即切。

import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../config.js';

export type SmsErrorKind = 'config' | 'rejected' | 'transient';

/** 短信发送失败。kind=config(签名/模板/AK 错,需运维介入,API 层应大声告警日志);
 *  rejected(号码非法/被拉黑,用户问题);transient(网络/限流,可重试)。 */
export class SmsSendError extends Error {
  constructor(message: string, public readonly kind: SmsErrorKind, public readonly providerCode?: string) {
    super(message);
    this.name = 'SmsSendError';
  }
}

export interface SmsSender {
  readonly name: string;
  /** 发送验证码。成功 resolve;失败 throw SmsSendError。 */
  sendCode(phone: string, code: string, purpose: string): Promise<void>;
}

/** 测试/联调用:ConsoleSmsSender 记录最近发的码(phone→code)。生产 aliyun 路径不写。 */
export const _sentCodes = new Map<string, string>();

// ── ConsoleSmsSender:把验证码打到服务端日志(开发/私有化/签名审批前)──
export class ConsoleSmsSender implements SmsSender {
  readonly name = 'console';
  async sendCode(phone: string, code: string, purpose: string): Promise<void> {
    _sentCodes.set(phone, code);
    console.log(`[短信·console] → ${phone} (${purpose}) 验证码: ${code}(5 分钟内有效)`);
  }
}

// ── AliyunSmsSender:阿里云 Dysmsapi SendSms,RPC 风格手签(HMAC-SHA1,POP 1.0)──
// 不引 @alicloud SDK(零新依赖,合项目极简风);签名规范见阿里云《公共参数·签名机制》。
function popEncode(s: string): string {
  // RFC3986:encodeURIComponent 后再修正 +/*/~(阿里云要求)。
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

export class AliyunSmsSender implements SmsSender {
  readonly name = 'aliyun';
  constructor(
    private readonly akId: string,
    private readonly akSecret: string,
    private readonly signName: string,
    private readonly templateCode: string,
    private readonly endpoint: string,
  ) {}

  async sendCode(phone: string, code: string, _purpose: string): Promise<void> {
    const params: Record<string, string> = {
      AccessKeyId: this.akId,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: phone,
      RegionId: 'cn-hangzhou',
      SignName: this.signName,
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: randomUUID(),
      SignatureVersion: '1.0',
      TemplateCode: this.templateCode,
      TemplateParam: JSON.stringify({ code }),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-05-25',
    };
    // 规范化:键升序 → key=encode(val) 用 & 连 → StringToSign = GET&%2F&encode(canonical)。
    const canonical = Object.keys(params)
      .sort()
      .map((k) => `${popEncode(k)}=${popEncode(params[k]!)}`)
      .join('&');
    const stringToSign = `GET&${popEncode('/')}&${popEncode(canonical)}`;
    const signature = createHmac('sha1', `${this.akSecret}&`).update(stringToSign).digest('base64');
    const url = `https://${this.endpoint}/?Signature=${popEncode(signature)}&${canonical}`;

    let res: Response;
    try {
      res = await fetch(url, { method: 'GET' });
    } catch (e) {
      throw new SmsSendError(`短信网络错误: ${e instanceof Error ? e.message : e}`, 'transient');
    }
    const body = (await res.json().catch(() => ({}))) as { Code?: string; Message?: string };
    if (body.Code === 'OK') return;
    const c = body.Code ?? `HTTP_${res.status}`;
    // 限流/余额类 → transient;签名/模板/AK 类 → config;号码类 → rejected。
    if (/BUSINESS_LIMIT|FLOW|amount|LIMIT_CONTROL|busy/i.test(c)) {
      throw new SmsSendError(`短信限流: ${c}`, 'transient', c);
    }
    if (/SIGN|TEMPLATE|AccessKey|Forbidden|Unauthorized|Account|Param/i.test(c)) {
      throw new SmsSendError(`短信配置错误(签名/模板/AccessKey): ${c} ${body.Message ?? ''}`, 'config', c);
    }
    throw new SmsSendError(`短信发送被拒: ${c} ${body.Message ?? ''}`, 'rejected', c);
  }
}

// ── 自动选择 + 单例 ──
let _sender: SmsSender | null = null;
export function smsSender(): SmsSender {
  if (_sender) return _sender;
  const a = config.sms.aliyun;
  const aliyunReady = !!(a.accessKeyId && a.accessKeySecret && a.signName && a.templateCode);
  const want = config.sms.provider;
  if (want === 'aliyun' || (want === '' && aliyunReady)) {
    if (!aliyunReady) {
      console.warn('[短信] SMS_PROVIDER=aliyun 但签名/模板/AK 未配齐 —— 回落 console(验证码打日志)');
      _sender = new ConsoleSmsSender();
    } else {
      _sender = new AliyunSmsSender(a.accessKeyId, a.accessKeySecret, a.signName, a.templateCode, a.endpoint);
      console.log(`[短信] 使用阿里云 Dysmsapi(签名「${a.signName}」)`);
    }
  } else {
    if (want !== 'console') console.warn('[短信] 未配阿里云短信 —— 使用 console 兜底(验证码打到服务端日志,仅供开发/联调)');
    _sender = new ConsoleSmsSender();
  }
  return _sender;
}

/** 测试用:重置单例(切换 env 后重选 sender)。 */
export function _resetSmsSender(): void {
  _sender = null;
}
