// 灵镜 生成来源徽章 — 前端接线(prototype 静态资源静态检查)。
//
// 后端把 job.channel 发出来了,前端还得真的显示。这层的两个失败模式:
//   1. LJChannelLabel 映射写错(mcp/rest 显错字,或 web/老数据误显徽章打扰用户)
//   2. 漏接某一页 —— 记录卡在 10 个页面各写各的,漏一个该页就静默没徽章,没人会发现
// 本项目无 DOM 测试框架(88 个测试全是后端),这里沿用 connect-script.test 的手法:
// 直接对静态资源做内容检查 + 把纯函数抠出来 eval 跑分支。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proto = (f: string) => readFileSync(path.join(ROOT, 'prototype', f), 'utf8');

// shell.js 是浏览器 IIFE(碰 document/location),整份 eval 不了 → 抠出目标函数单独跑。
function loadChannelLabel(): (ch: unknown) => string {
  const src = proto('shell.js');
  // 缩进不写死(shell.js 被格式化过也要能抠出来);抠不到就报清楚是哪种情况。
  const m = src.match(/window\.LJChannelLabel\s*=\s*(function\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\})\s*;/);
  if (!m) throw new Error('shell.js 里抠不出 LJChannelLabel —— 被改名/删除,或函数体形状变了');
  return new Function(`return ${m[1]}`)() as (ch: unknown) => string;
}

describe('LJChannelLabel 来源徽章文案', () => {
  const label = loadChannelLabel();

  it('mcp → 「MCP 创建」', () => {
    expect(label('mcp')).toBe('MCP 创建');
  });

  it('rest → 「API 创建」', () => {
    expect(label('rest')).toBe('API 创建');
  });

  it('web / 老数据(null|undefined)→ 空串(不显徽章,不打扰网页用户)', () => {
    expect(label('web')).toBe('');
    expect(label(null)).toBe('');
    expect(label(undefined)).toBe('');
  });

  it('未知渠道 → 空串(后端将来加新 channel 也不会显出裸值)', () => {
    expect(label('cli')).toBe('');
  });
});

// 记录卡分散在各工具页,漏接一页 = 该页永远不显徽章。逐页断言接线在,防回归。
describe('各记录卡页面已接来源徽章', () => {
  const PAGES = [
    'ai-image.html', 'ai-image-edit.html', 'text2video.html', 'img2video.html',
    'ref-video.html', 'video-edit.html', 'ai-music.html', 'tts.html',
    'assets.html', 'create.html',
  ];

  it.each(PAGES)('%s 调用 LJChannelLabel', (page) => {
    expect(proto(page)).toContain('LJChannelLabel');
  });

  // ai-music / tts 的 head() 把徽章并进时间戳,靠调用方传 job.channel;漏传就永远是空。
  it.each(['ai-music.html', 'tts.html'])('%s 的 head() 每个状态分支都传了 job.channel', (page) => {
    // 实参里有 var(--amber) 这种嵌套括号,正则配不干净 → 按行找 head( 调用点。
    const calls = proto(page).split('\n').filter((l) => l.includes('head(') && l.includes('job.createdAt'));
    expect(calls.length).toBe(3); // 排队/生成中、已完成、失败
    for (const call of calls) expect(call).toContain('job.channel');
  });
});
