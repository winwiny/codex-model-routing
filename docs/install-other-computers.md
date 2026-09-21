# 在其他 Windows 电脑安装 Jev MCP

安装包不包含 API Key。每台电脑必须使用自己的 Windows 用户在本机配置 TypeSafe 官方密钥；DPAPI 凭证绑定 Windows 用户，不能从另一台电脑复制后继续使用。

## 自动安装

要求：Windows、Node.js 22+、npm、Codex CLI，以及从 [TypeSafe 控制台](https://console.typesafe.ai/keys) 创建的官方 API Key。

1. 解压安装包，打开 PowerShell，进入解压目录。
2. 运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-jev-mcp-windows.ps1
```

3. 在隐藏提示中输入 `TYPESAFE_API_KEY`。脚本会：
   - 把运行文件复制到 `%LOCALAPPDATA%\ModelTaskRouting\jev-mcp`；
   - 安装锁定版本的生产依赖；
   - 把密钥保存为 `%LOCALAPPDATA%\ModelTaskRouting\typesafe.dpapi`；
   - 注册 Codex STDIO MCP `jev`；
   - 执行一次网络请求为 0 的离线检查。
4. 重启 Codex，确认工具列表含 `jev_check`、`jev_evaluate`、`jev_get_record`。

安装脚本不会覆盖已有安装目录、已有 DPAPI 凭证或已有的 `jev` MCP 配置。遇到已有配置时应先核对，而不是自动删除。

## 密钥配置方式

推荐 Windows 使用 DPAPI：

```powershell
powershell.exe -NoProfile -File "$env:LOCALAPPDATA\ModelTaskRouting\jev-mcp\scripts\jev-windows.ps1" -Setup
```

也可以在启动 MCP 的受控进程环境中提供 `TYPESAFE_API_KEY`。不要把真实密钥写入 Git、README、聊天记录、共享 ZIP、Codex `config.toml` 或 MCP 参数。

以下文件不能跨电脑直接复制：

```text
%LOCALAPPDATA%\ModelTaskRouting\typesafe.dpapi
```

它只能由创建它的 Windows 用户解密。若多台电脑使用同一个 TypeSafe Key，也要在每台电脑上分别通过隐藏输入生成各自的 DPAPI 文件。

## 离线检查

```powershell
powershell.exe -NoProfile -File "$env:LOCALAPPDATA\ModelTaskRouting\jev-mcp\scripts\jev-windows.ps1" `
  -InputPath "$env:LOCALAPPDATA\ModelTaskRouting\jev-mcp\examples\jev-request.json" -Check
```

应看到 `provider=typesafe-direct`、官方端点、`model=jev-latest`、`apiKeyConfigured=true` 和 `requestsAttempted=0`。

离线检查不证明密钥有效。安装后再用虚构、非敏感输入完成一次最小真实调用，并检查审计记录中的返回模型、答案、概率和 confidence。

## 只安装文件

自动化测试或尚未安装 Codex CLI 时，可以跳过密钥与 MCP 注册：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-jev-mcp-windows.ps1 `
  -SkipCredentialSetup -SkipCodexRegistration
```

之后按本文件前面的步骤单独配置密钥和 MCP。
