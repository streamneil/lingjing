// 灵镜 Open API — /connect.sh 一键接入脚本可达性 + 内容(接入页 D1)。
//
// 脚本静态托管在 /connect.sh(prototype/ 由 express.static 挂在 /)。
// 覆盖:200 可达;含 claude mcp add 自动配 + 通用 MCP 配置兜底(Authorization: Bearer)+ 用法/参数校验。

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);

describe('GET /connect.sh', () => {
  it('可达(200)', async () => {
    const r = await client.getRaw('/connect.sh');
    expect(r.status).toBe(200);
  });

  it('含 Claude Code 自动配(claude mcp add)+ 通用 MCP 配置兜底', async () => {
    const body = (await client.getRaw('/connect.sh')).buf.toString('utf8');
    expect(body).toContain('claude mcp add');
    expect(body).toContain('Authorization: Bearer'); // 通用配置块 header
    expect(body).toContain('set -eu'); // 安全:严格模式
    expect(body).toMatch(/command -v claude/); // 检测 claude CLI
  });

  it('缺参数时脚本自带用法提示(静态检查内容含 Usage/用法)', async () => {
    const body = (await client.getRaw('/connect.sh')).buf.toString('utf8');
    expect(body).toMatch(/用法|Usage/);
  });
});
