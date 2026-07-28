// 参考生成影片页 — 三类素材上传都要带 consent(prototype 静态资源静态检查)。
//
// v0.9.2 起后端对参考音频也强制 consent。前端要是漏了那一行,网页端的音频上传直接 400,
// 而这是**用户可见的功能中断**,后端测试一条都不会红 —— 后端只会正确地拒绝一个没带 consent 的请求。
//
// 本项目无 DOM 测试框架(全部是后端测试),沿用 job-channel-ui / connect-script 的手法:
// 对静态资源做内容检查。粗但有效:漏接线这一类失败模式,静态检查抓得住。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(root, '../prototype/ref-video.html'), 'utf8');

/** 抠出 uploadGroup 函数体(三类素材的上传都在里面)。 */
function uploadGroupBody(): string {
  const start = html.indexOf('async function uploadGroup');
  expect(start, 'ref-video.html 里找不到 uploadGroup —— 上传逻辑被重构了,本测试要跟着改').toBeGreaterThan(-1);
  // 到下一个顶层 function/btn 监听为止,够覆盖三个分支
  const end = html.indexOf('btn.addEventListener', start);
  return html.slice(start, end > start ? end : start + 3000);
}

/** 把 uploadGroup 切成三个**互不重叠**的分支窗口。
 *  这一步是本文件的成败关键:上一版用无界 slice 取视频分支,结果把图片分支的 consent 一起吞了 ——
 *  删掉视频分支自己的 consent 行,四条测试照样全绿(专家用变异实测过)。
 *  断言窗口必须由分支分隔符切出来,不能用「从这里到结尾」或魔法偏移量。 */
function branches(body: string): { aud: string; vid: string; img: string } {
  const iAud = body.indexOf("kind==='aud'");
  const iVid = body.indexOf("kind==='vid'");
  const iImg = body.indexOf('/api/image-uploads');
  expect(iAud, '找不到音频分支').toBeGreaterThan(-1);
  expect(iVid, '找不到视频分支').toBeGreaterThan(iAud);
  expect(iImg, '找不到图片分支').toBeGreaterThan(iVid);
  // 图片分支没有 kind=== 守卫(是 fallthrough),用它的 FormData 起点当窗口左界
  const iImgStart = body.lastIndexOf('const fd=new FormData()', iImg);
  expect(iImgStart, '找不到图片分支的 FormData').toBeGreaterThan(iVid);
  return { aud: body.slice(iAud, iVid), vid: body.slice(iVid, iImgStart), img: body.slice(iImgStart) };
}

describe('ref-video.html — 三类素材上传都带 consent', () => {
  const b = branches(uploadGroupBody());

  it('三个窗口互不重叠(前提校验:窗口切错就会互相借 consent,断言随之失效)', () => {
    expect(b.aud).toContain('/api/audio-uploads');
    expect(b.aud, '音频窗口里混进了视频端点').not.toContain('/api/video-uploads');
    expect(b.vid).toContain('/api/video-uploads');
    expect(b.vid, '视频窗口里混进了图片端点 —— 上一版的 bug 就是这个').not.toContain('/api/image-uploads');
    expect(b.img).toContain('/api/image-uploads');
    expect(b.img, '图片窗口里混进了视频端点').not.toContain('/api/video-uploads');
  });

  it('音频分支带 consent(v0.9.2 新增:后端已强制,漏了网页端直接 400)', () => {
    expect(b.aud).toContain("fd.append('consent','true')");
  });

  it('视频分支带 consent', () => {
    expect(b.vid).toContain("fd.append('consent','true')");
  });

  it('图片分支带 consent', () => {
    expect(b.img).toContain("fd.append('consent','true')");
  });

  it('授权勾选框仍是提交前置(consent=true 得有据可依,不能凭空断言)', () => {
    // 三处 fd.append('consent','true') 都是硬编码的 —— 之所以成立,是因为页面在提交前
    // 校验了 consentChk。这条链断了,前端就是在替用户做授权声明。
    expect(html).toContain('id="consentChk"');
    expect(html, '提交前不再校验授权勾选 —— 硬编码的 consent=true 就失去依据了')
      .toMatch(/consentChk['"]?\)\.checked/);
    const label = html.slice(html.indexOf('id="consentChk"'), html.indexOf('id="consentChk"') + 400);
    expect(label).toContain('图片');
    expect(label).toContain('视频');
    expect(label).toContain('音频');
  });
});
