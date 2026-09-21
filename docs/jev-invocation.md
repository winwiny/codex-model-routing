# 在本机调用 Jev

本 Skill 直接调用 **TypeSafe 官方 System One API**：模型别名 `jev-latest`，端点 `POST https://api.typesafe.ai/v1/systemone`，认证变量 `TYPESAFE_API_KEY`。不再通过 Vercel AI Gateway，也不读取 `AI_GATEWAY_API_KEY`。

官方契约：[HTTP API](https://docs.typesafe.ai/api)、[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[Confidence](https://docs.typesafe.ai/confidence)。

## 给执行 AI 的步骤

1. 先读已安装的 `typesafe-ai` Skill 和任务需要的实时官方文档。只把边界清楚、确实需要语义理解且已获授权的内容交给 Jev；计算、精确查询、风控与执行继续用代码。
2. 按 [虚构输入样例](../examples/jev-request.json) 准备 JSON：`schemaVersion`、`purpose`、`model`、`state`、`questions`。模型必须为 `jev-latest`，问题类型使用官方的 `choice`、`noul` 或 `score`。
3. 先运行离线检查。它验证运行时、输入 schema 和凭证存在状态，网络请求为 0。
4. 有 API 数据授权时执行一次真实请求，并使用新的私有证据文件。缺凭证、接口失败或证据不足时回退，不通过删减不利选项或放宽阈值制造成功。
5. 最终回复报告本轮请求数、答案、Choice/Score 原始 confidence、Noul 的 `p(true)` 以及复核处理。读取文档、`--check` 和离线测试不计 Jev 调用。

## 本机 MCP：优先入口

客户端暴露 `jev_check`、`jev_evaluate`、`jev_get_record` 时优先使用 MCP。MCP 调用同一套官方 TypeSafe 包装器，将脱敏记录保存在 `%LOCALAPPDATA%/ModelTaskRouting/mcp/records`。原始 `state` 只进入临时文件，调用结束后删除。

- `jev_check`：离线检查，不发模型请求。
- `jev_evaluate`：每次发起一次官方评价请求；输入上限 64 KiB，最多 16 个问题，一次只处理一个请求且每分钟最多 20 次。
- `jev_get_record`：只接受 MCP 发放的 `recordId`，不接受任意文件路径。

MCP 拒绝凭证、私钥、助记词、签名材料等敏感输入。工具不可用时才回退到脚本；同一判断不同时调用两个入口。

## Windows 加密凭证

在 Skill 根目录执行：

```powershell
# 首次配置官方 TypeSafe API key；终端隐藏输入。
powershell.exe -NoProfile -File .\scripts\jev-windows.ps1 -Setup

# 离线检查，不发请求。
powershell.exe -NoProfile -File .\scripts\jev-windows.ps1 -InputPath .\examples\jev-request.json -Check

# 执行一次真实请求，输出到新的私有证据文件。
powershell.exe -NoProfile -File .\scripts\jev-windows.ps1 -InputPath 'D:\private-task\request.json' -OutputPath 'D:\private-task\jev-result-001.json'
```

读取顺序：当前进程 `TYPESAFE_API_KEY` → `%LOCALAPPDATA%\ModelTaskRouting\typesafe.dpapi`。`-CredentialPath` 可以指定用户明确配置的其他 DPAPI 文件。Setup 不覆盖现有凭证。

凭证使用 Windows DPAPI CurrentUser 加密，只注入 Node 子进程环境；不写入全局环境、命令行、模型输入、证据或仓库。同 Windows 用户下的其他程序仍可能解密；DPAPI 文件不能直接复制给其他用户或设备使用。

旧 `%LOCALAPPDATA%\ModelTaskRouting\ai-gateway.dpapi` 是 Vercel 凭证。官方版本不会读取或迁移该文件，也不会把 Vercel key 当成 TypeSafe key。

## 其他环境

通过客户端私密凭证配置设置 `TYPESAFE_API_KEY`：

```bash
node scripts/jev-evaluate.mjs --input /private/task/request.json --check
node scripts/jev-evaluate.mjs --input /private/task/request.json --output /private/task/jev-result-001.json
```

脚本固定官方端点与模型别名，禁止重定向，没有自动重试，超时 25 秒。401 检查官方 key，422 检查请求 schema，429 或 529 按官方建议做受控退避；每次实际重试生成新证据并单独计数。

## 返回与置信度

证据记录输入哈希、schema 版本、用途、官方端点、请求/返回模型、时间、请求次数、答案、概率、confidence、用量及失败状态，不保存原始 `state` 或认证头。

- Choice：保存选项、完整概率分布和官方 `confidence`。
- Score：保存分数、legend、完整概率分布和官方 `confidence`。
- Noul：保存 `noul` 为 `pTrue`；该类型没有独立 confidence，必须报告 N/A。
- Choice/Score 的 `confidence < 0.80` 只是当前未校准的主推理模型复核提醒，不是官方阈值、正确率或执行授权。

官方 API 返回的具体模型可能是版本号，例如 `jev-1.13.0`；请求仍使用稳定别名 `jev-latest`。
