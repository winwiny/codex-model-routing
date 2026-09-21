# TypeSafe Jev STDIO MCP

`scripts/jev-mcp-server.mjs` 可在 macOS 与 Windows 运行，和 CLI 共用官方 SDK 核心与平台凭证适配器。

默认只暴露两个工具：

- `typesafe_check`：离线检查 Node、平台和凭证可用性，模型请求为 0。
- `typesafe_evaluate`：调用一次共享核心，返回 `content` 与相同对象的 `structuredContent`。

Server 对 evaluate 实施单并发和滚动 20 次/分钟限制。SDK 内部重试由请求的 `maxRetries` 控制（默认 2、最大 5）；别名不会串联调用 canonical 工具。

默认不创建 state、临时请求或审计目录，也不持久化结果。只有进程所有者明确设置 `JEV_ENABLE_RECORDS=1` 时，才额外暴露 `typesafe_get_record` 并保存“结果-only”的脱敏记录；原始 state 永不进入记录。`JEV_ENABLE_BETA_ALIASES=1` 可临时暴露旧 beta 名 `jev_check` / `jev_evaluate`；旧 `jev_evaluate` 接受 `schemaVersion`、`purpose`、`state`、`questions` 格式，移除本地元数据后经过同一个限流器与核心，调用一次只会执行一次 evaluation。审计也开启时同时暴露 `jev_get_record`。迁移完成后应关闭这些别名。

## 所有客户端使用同一个命令

macOS 安装后的绝对命令：

```text
/Users/<user>/.local/bin/jev-mcp
```

Windows MCP 配置应使用安装器输出的同一组绝对值：

```text
command = C:\Program Files\nodejs\node.exe
args = [C:\Users\<user>\AppData\Local\ModelTaskRouting\jev-bridge\scripts\jev-mcp-server.mjs]
```

把这组 `command` / `args` 原样用于 Codex、Claude Desktop 与 Cursor，不给任何客户端添加密钥参数。不同客户端的配置文件语法可能不同，但启动命令必须相同。终端还可使用安装器生成的 `%LOCALAPPDATA%\ModelTaskRouting\bin\jev-mcp.cmd`。

## 开发期离线冒烟

```sh
node scripts/jev-mcp-smoke.mjs \
  --server scripts/jev-mcp-server.mjs \
  --output /tmp/jev-mcp-smoke.json
```

不加 `--live` 时只列工具并执行 `typesafe_check`，不会调用模型。不要在一般验证中加入 `--live`。
