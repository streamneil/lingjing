// 图片转影片 / 参考生影片实时积分 wiring 静态回归。
// 浏览器估价发生在素材上传前,不得给 /jobs/estimate 发送伪造 storage key；否则后端租户
// 所有权校验会正确拒绝,而页面 catch 静默后创建按钮永久显示“—”。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const img = readFileSync(path.join(root, '../prototype/img2video.html'), 'utf8');
const ref = readFileSync(path.join(root, '../prototype/ref-video.html'), 'utf8');

function functionWindow(html: string, name: string, next: string): string {
  const start = html.indexOf(`function ${name}`);
  expect(start, `找不到 ${name}`).toBeGreaterThan(-1);
  const end = html.indexOf(next, start);
  return html.slice(start, end > start ? end : start + 2500);
}

describe('视频生成页实时积分估价', () => {
  it('图片转影片估价传空 refs,授权切换也会重算', () => {
    const win = functionWindow(img, 'scheduleEstimate', 'function refreshBtn');
    expect(win).toContain("LJ.post('/jobs/estimate', jobBody([]))");
    expect(win).not.toMatch(/['"]est['"]\s*\+/);
    expect(img).toMatch(/consentChk['"]\)\.addEventListener\('change',[\s\S]{0,120}scheduleEstimate\(\)/);
  });

  it('参考生影片估价不伪造三类 refs,但携带本地参考视频总时长', () => {
    const win = functionWindow(ref, 'jobBodyMeta', 'let estTimer');
    expect(win).not.toContain('b.imageRefs=');
    expect(win).not.toContain('b.videoRefs=');
    expect(win).not.toContain('b.audioRefs=');
    expect(win).toContain('b.hasVideoInput=true');
    expect(win).toContain('b.inputVideoDuration=');
  });
});
