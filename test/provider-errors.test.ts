// 灵镜 — 厂商错误可读化(用户反馈:前端不能出现英文 JSON;admin 需看到原始日志排障)。
// 验证:① translateProviderError 把三家(火山/百炼/Gemini)原始错误翻译为中文可读,detail 保原始
//   ② 干净中文原样透出(本平台自抛错误)③ markFailed 单一翻译点:error=中文可读、error_detail=原始日志。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-errs-vitest-32';
const { translateProviderError } = await import('../src/gateway/provider-errors.js');
const { db } = await import('../src/db/index.js');
const { markFailed } = await import('../src/queue/index.js');

const ARK_REAL_PERSON =
  '火山视频提交失败 HTTP 400: {"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input image may contain real person. Request id: 021782470296","param":"","type":"BadRequest"}';

describe('translateProviderError — 厂商错误码 → 中文可读', () => {
  it('火山真人肖像(用户反馈的原始错误)→ 中文,且不含英文 JSON', () => {
    const { readable, detail } = translateProviderError(ARK_REAL_PERSON);
    expect(readable).toContain('真人');
    expect(readable).not.toMatch(/HTTP|InputImage|BadRequest|\{/); // 前端绝不出现英文/JSON
    expect(detail).toBe(ARK_REAL_PERSON); // 原始日志逐字保留(admin 排障)
  });

  it('火山输入图敏感(前缀码)→ 敏感信息中文', () => {
    const { readable } = translateProviderError('火山图片生成失败 HTTP 400: {"code":"InputImageSensitiveContentDetected"}');
    expect(readable).toContain('敏感');
    expect(readable).not.toMatch(/[A-Z][a-z]+[A-Z]/); // 无驼峰英文码残留
  });

  it('百炼内容审核拦截 → 中文', () => {
    const { readable } = translateProviderError('百炼提交失败 HTTP 400: {"code":"DataInspectionFailed"}');
    expect(readable).toContain('内容安全');
  });

  it('百炼欠费 Arrearage → 余额不足中文', () => {
    const { readable } = translateProviderError('{"code":"Arrearage","message":"good standing"}');
    expect(readable).toContain('余额');
  });

  it('Gemini 限流 RESOURCE_EXHAUSTED → 繁忙中文', () => {
    const { readable } = translateProviderError('Gemini 生成失败 HTTP 429: {"error":{"status":"RESOURCE_EXHAUSTED"}}');
    expect(readable).toContain('繁忙');
  });

  it('Gemini 安全策略拦截 → 中文', () => {
    const { readable } = translateProviderError('Gemini 未返回图片(可能被安全策略拦):"SAFETY"');
    expect(readable).toContain('安全策略');
  });

  // Regression: ISSUE-001 — 百炼音频格式错误(真库 5 例)曾落到「生成失败,请稍后重试」兜底,误导用户重试
  // Found by /qa on 2026-07-06
  it('音频/文件格式不支持 → 可操作的换格式提示(非通用兜底)', () => {
    for (const raw of [
      'File type is not supported. Allowed types are: .wav, .mp3.',
      '百炼提交失败 HTTP 400: {"code":"BadRequest.UnsupportedFileFormat"}',
      'unsupported audio format:opus',
    ]) {
      const { readable } = translateProviderError(raw);
      expect(readable).toContain('格式');
      expect(readable).not.toContain('稍后重试'); // 换格式才有用,不能叫用户重试
    }
  });

  it('音频过短/静音 → 可操作提示', () => {
    expect(translateProviderError('valid audio too short!').readable).toContain('音频');
    expect(translateProviderError('{"code":"Audio.AudioSilentError"}').readable).toContain('音频');
  });

  it('HTTP 状态兜底(未知码)→ 按状态给中文', () => {
    const { readable } = translateProviderError('某厂商失败 HTTP 500: {"foo":"bar baz qux"}');
    expect(readable).toContain('稍后重试');
    expect(readable).not.toContain('HTTP');
  });

  it('干净中文原样透出(本平台自抛错误)', () => {
    const msg = '排队超时:长时间未能进入生成,已退还预扣积分,请重试';
    expect(translateProviderError(msg).readable).toBe(msg);
    expect(translateProviderError('积分余额不足').readable).toBe('积分余额不足');
  });

  it('空/空白 → 兜底中文', () => {
    expect(translateProviderError('').readable).toContain('失败');
    expect(translateProviderError(null).readable).toContain('失败');
    expect(translateProviderError(undefined).readable).toContain('失败');
  });
});

describe('markFailed — 单一翻译点', () => {
  const jid = 'job-err-test';
  beforeEach(() => {
    db.prepare(`DELETE FROM job WHERE id=?`).run(jid);
    db.prepare(
      `INSERT INTO job (id,tenant_id,type,status,progress,input_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(jid, 'default', 'video_i2v', 'running', 0, '{}', Date.now(), Date.now());
  });

  it('落库:error=中文可读、error_detail=原始日志', () => {
    markFailed(jid, ARK_REAL_PERSON);
    const row = db.prepare(`SELECT status, error, error_detail FROM job WHERE id=?`).get(jid) as {
      status: string; error: string; error_detail: string;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('真人');
    expect(row.error).not.toMatch(/HTTP|\{/); // 用户可读列绝无英文 JSON
    expect(row.error_detail).toBe(ARK_REAL_PERSON); // 详情列保原始日志
  });

  it('已是中文的错误:error 原样、detail 同步保留', () => {
    markFailed(jid, '积分余额不足');
    const row = db.prepare(`SELECT error, error_detail FROM job WHERE id=?`).get(jid) as {
      error: string; error_detail: string;
    };
    expect(row.error).toBe('积分余额不足');
    expect(row.error_detail).toBe('积分余额不足');
  });
});
