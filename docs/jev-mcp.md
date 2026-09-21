# 本机 Jev MCP

`scripts/jev-mcp-server.mjs` 是 Windows 本地 STDIO MCP Server。它不在本机运行 Jev 模型，而是把 MCP 的结构化参数交给现有 `jev-windows.ps1` 与 `jev-evaluate.mjs`，直接调用 TypeSafe 官方 `POST https://api.typesafe.ai/v1/systemone`，请求模型别名固定为 `jev-latest`。

## 工具

- `jev_check`：检查 Node、输入 schema 与 DPAPI 凭证是否可读；网络请求为 0。
- `jev_evaluate`：执行一次 Choice、Noul 或 Score 判断，返回脱敏证据和 `recordId`。
- `jev_get_record`：按 `recordId` 读取脱敏证据，不允许任意路径。

工具不提供下单、撤单、钱包、签名或任意命令执行能力。模型、官方 API 地址、超时、输入大小与问题数量均由服务器固定。服务器一次只处理一个评价请求，并限制为每分钟最多 20 次，避免客户端循环失控。凭证不进入 MCP 参数、配置、stdout 或审计记录。

## 安装与运行

仓库开发环境：

```powershell
npm ci --ignore-scripts
npm test
node scripts/jev-mcp-server.mjs
```

把 MCP 安装到一个不会随项目清理而消失的本机目录。Codex 用户配置示例（将路径替换为实际安装位置）：

```toml
[mcp_servers.jev]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Tools\jev-mcp\scripts\jev-mcp-server.mjs']
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 45
enabled_tools = ["jev_check", "jev_evaluate", "jev_get_record"]
```

重新启动客户端后查看 MCP 工具列表。客户端位于沙箱、云端、另一 Windows 用户或不支持 STDIO MCP 时，不能据此声称已经接通本机服务。

## 数据与记录

- 临时输入：`%LOCALAPPDATA%/ModelTaskRouting/mcp/tmp`，每次调用后删除。
- 脱敏记录：`%LOCALAPPDATA%/ModelTaskRouting/mcp/records`。
- 凭证：`%LOCALAPPDATA%/ModelTaskRouting/typesafe.dpapi`，由 Windows DPAPI CurrentUser 解密。旧 `ai-gateway.dpapi` 不会被读取。

MCP 层拒绝常见 API Key、私钥、助记词、签名字段和超过 64 KiB 的输入。服务返回成功仍不代表判断正确或获得操作授权；Choice/Score 报原始 confidence，Noul 报 `p(true)`。
