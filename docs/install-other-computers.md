# 在 macOS 与 Windows 安装 Jev Bridge

安装包不包含凭证。要求 Node.js 20+ 与 npm。安装器先复制到同卷 staging、执行 `npm ci`、完整 `npm test` 和 CLI 冒烟，再替换正式目录；失败时保留 failed staging/安装并恢复旧版本。不要复制其他电脑的 Keychain 或 DPAPI 凭证。

## macOS：安装或安全升级

```sh
sh scripts/install-jev-macos.sh
```

默认目标为 `~/.local/share/jev-bridge`，稳定入口为 `~/.local/bin/jev` 与 `~/.local/bin/jev-mcp`。已有安装会先移动为带 UTC 时间的 `.backup-*`，新版本成功后仍保留该备份，便于人工恢复。提交替换前，安装器会实际通过这两个最终 symlink 执行 CLI help 与 MCP list-tools 冒烟；MCP 冒烟不读取凭证、不调用模型。脚本不创建、修改或删除 Keychain 项，只读取仓库文件并安装 npm 依赖。

自定义位置：

```sh
sh scripts/install-jev-macos.sh \
  --install-root /absolute/path/jev-bridge \
  --bin-dir /absolute/path/bin
```

TypeSafe 官方凭证应由用户在“钥匙串访问”中预先新增密码项目：service/name 为 `typesafe-ai-direct`，account 为当前 macOS 短用户名，密码字段保存 API Key。使用 GUI 避免把密钥放到 shell history 或命令行。安装后运行 `jev doctor` 仅做本地检查；不要为普通安装验证使用 `--live`。

## Windows：首次安装或显式升级

首次安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-jev-mcp-windows.ps1
```

已有安装时脚本默认拒绝覆盖。明确升级才使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-jev-mcp-windows.ps1 -Upgrade
```

默认安装到 `%LOCALAPPDATA%\ModelTaskRouting\jev-bridge`，并生成稳定入口 `%LOCALAPPDATA%\ModelTaskRouting\bin\jev.cmd` 与 `jev-mcp.cmd`。升级会保留 `.backup-<UTC>`；staging 或替换失败时恢复旧目录与旧入口。

凭证配置是显式动作。首次安装时可加 `-SetupCredential`，也可以稍后执行：

```powershell
powershell.exe -NoProfile -File "$env:LOCALAPPDATA\ModelTaskRouting\jev-bridge\scripts\jev-windows.ps1" -Setup
```

隐藏输入会写入 DPAPI CurrentUser 文件 `%LOCALAPPDATA%\ModelTaskRouting\typesafe.dpapi`，已存在时不覆盖。该文件只能在创建它的 Windows 用户上下文中解密。

`-RegisterCodex` 也是显式选项；默认不修改任何客户端配置。推荐从安装器 JSON 输出复制 `mcpNodeCommand` 与 `mcpScript`，在 Codex、Claude Desktop、Cursor 三处使用完全相同的绝对启动命令，不添加 API Key 参数。

## 可选环境变量备用

只有 CI 或用户明确设置 `JEV_ALLOW_ENV_CREDENTIAL=1` / CLI `--allow-env` 时才读取 `TYPESAFE_API_KEY`。原生 Keychain/DPAPI 优先。不要把真实密钥放进 Git、共享压缩包、MCP 配置、命令行或日志。

## 离线验证

```sh
npm ci
npm test
node scripts/jev-cli.mjs help
```

Windows 实机还应运行：

```powershell
powershell.exe -NoProfile -File .\tests\jev-windows-compat.tests.ps1
powershell.exe -NoProfile -File .\tests\jev-windows-installer.tests.ps1
```

以上均不调用真实 Jev。只有用户明确授权并配置凭证后，才用 `jev doctor --live` 做连通性验证。
