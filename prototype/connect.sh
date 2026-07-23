#!/usr/bin/env sh
# 灵镜 Open API —— Agent 一键接入脚本。
#
# 用法:
#   curl -fsSL https://<你的域名>/connect.sh | sh -s -- <MCP_URL> <API_KEY>
# 例:
#   curl -fsSL https://ai.example.com/connect.sh | sh -s -- https://ai.example.com/mcp lj_sk_xxx
#
# 做什么:检测到 Claude Code(claude CLI)就自动把灵镜 MCP 配好;否则打印通用 MCP 配置块,
# 任何 MCP 兼容 Agent(OpenClaw / Cursor / Codex …)复制即用。脚本不内嵌任何密钥,密钥由你运行时传入。

set -eu

MCP_URL="${1:-}"
API_KEY="${2:-}"
SERVER_NAME="lingjing"

usage() {
  echo "用法(Usage): curl -fsSL <域名>/connect.sh | sh -s -- <MCP_URL> <API_KEY>"
  echo "例(Example): sh -s -- https://ai.example.com/mcp lj_sk_xxxxxxxx"
}

if [ -z "${MCP_URL}" ] || [ -z "${API_KEY}" ]; then
  echo "✗ 缺少参数:需要 MCP_URL 和 API_KEY。" >&2
  usage >&2
  exit 1
fi

case "${API_KEY}" in
  lj_sk_*) : ;;
  *) echo "✗ API_KEY 格式不对(应以 lj_sk_ 开头)。" >&2; exit 1 ;;
esac

# 密钥打码(只显前 12 位),避免在终端/日志里回显完整密钥。
masked="$(printf '%s' "${API_KEY}" | cut -c1-12)"

# 通用 MCP 配置块(任何 MCP Agent 手动粘贴用)。
print_generic() {
  echo ""
  echo "把下面这段加进你的 Agent 的 MCP 配置(OpenClaw / Cursor / Codex 等通用):"
  echo "----------------------------------------------------------------------"
  cat <<EOF
{
  "mcpServers": {
    "${SERVER_NAME}": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${API_KEY}" }
    }
  }
}
EOF
  echo "----------------------------------------------------------------------"
  echo "  - Cursor:  写入 ~/.cursor/mcp.json 或项目 .cursor/mcp.json"
  echo "  - Codex:   写入 ~/.codex/config.toml 的 [mcp_servers.${SERVER_NAME}] 段"
  echo "  - OpenClaw / 其它:按其 MCP(Streamable HTTP)配置位置粘贴上面 JSON"
}

if command -v claude >/dev/null 2>&1; then
  echo "▶ 检测到 Claude Code,正在配置 MCP「${SERVER_NAME}」(密钥 ${masked}…)…"
  # 幂等:已存在先移除再添加(忽略移除时的 not-found 错误)。
  claude mcp remove "${SERVER_NAME}" >/dev/null 2>&1 || true
  claude mcp add --transport http "${SERVER_NAME}" "${MCP_URL}" --header "Authorization: Bearer ${API_KEY}"
  echo "✓ 已接入 Claude Code。在会话里用 generate_image / generate_video / get_job 等工具即可。"
  echo "  (校验:claude mcp list)"
else
  echo "ℹ 未检测到 Claude Code(claude CLI)。"
  print_generic
fi
