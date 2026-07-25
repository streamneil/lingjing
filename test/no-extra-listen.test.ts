// 灵镜 测试基建护栏 —— 测试文件不得自己 app.listen(0)。
//
// 背景:helpers.ts 用「每个 app 一个常驻 server」把端口 churn 压到 1,这是 2026-06-25 那轮
// 随机 flake 的解法。但 2026-07-25 复发了一次 —— mcp / job-channel 要给 MCP SDK transport
// 一个真实 URL,helpers 当时没暴露端口,于是各自 app.listen(0),churn 又回来了,
// 全量跑约 20% 概率随机某个文件整体级联失败(连「未登录 → 401」都挂)。
//
// 光靠注释拦不住 —— 上一轮就只留了注释,照样复发。这里用静态检查钉死:
// 要真实端口就 import { serverPort } from './helpers.js',别自己 listen。

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
// helpers.ts 是常驻 server 的唯一持有者,只有它可以 listen。
// 本文件自身豁免:用例标题里带字面量 "app.listen(" 会命中自己(误报,非真调用)。
const ALLOWED = new Set(['helpers.ts', 'no-extra-listen.test.ts']);

describe('测试文件不得自己 app.listen', () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts') && !ALLOWED.has(f));

  it.each(files)('%s 不含 app.listen(', (file) => {
    const src = readFileSync(path.join(TEST_DIR, file), 'utf8');
    // 允许注释里提到 app.listen(讲解历史);只查真实调用行。
    const offending = src
      .split('\n')
      .filter((l) => /\.listen\s*\(/.test(l))
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(offending, `${file} 自己起了 server —— 改用 serverPort(app)(见 helpers.ts 文件头)`).toEqual([]);
  });

  it('helpers.ts 确实导出了 serverPort(护栏指向的替代方案存在)', () => {
    const src = readFileSync(path.join(TEST_DIR, 'helpers.ts'), 'utf8');
    expect(src).toMatch(/export function serverPort\(/);
  });
});
