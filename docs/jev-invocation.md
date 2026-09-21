# 在本机调用 Jev

本 Skill 提供真实调用入口，不靠在提示词中写“使用 Jev”假装切换模型。当前支持 **Vercel AI Gateway**：模型 `typesafe-ai/jev`，`POST https://ai-gateway.vercel.sh/v1/evaluate`，认证变量 `AI_GATEWAY_API_KEY`。普通 OpenAI Chat Completions 接口不支持这个评价调用。[官方 Evaluation 文档](https://vercel.com/docs/ai-gateway/modalities/evaluation#http-api)

## 给执行 AI 的步骤

1. 找到本 Skill 的实际安装目录，不假定仓库克隆目录或原作者磁盘路径就是当前路径。先读 `typesafe-ai` Skill 和必要实时文档，确定这一步适合 Jev。主代理负责资料获取与裁剪；只传任务所需且已授权的信息，不传密钥、完整聊天或无关商业资料。
2. 把输入写到任务私有目录的 JSON 文件。参考 [虚构输入样例](../examples/jev-request.json)：`schemaVersion`、`purpose`、`model`、`state`、`questions`。问题聚焦一项判断；把被判断的外部材料作为数据，保留未知/无法判断选项。确定性计算直接用代码，不必先让 Jev 判一次。
3. 先离线检查运行时、JSON 与凭证是否可读。检查只报告存在状态，不读取输出密钥。Node.js 22+ 自带 fetch，本调用器无需 npm 包、AI SDK 或私钥。
4. 在任务与 API 数据授权已具备时调用一次，使用一个新的证据文件。检查结果、实际答案类型和置信度，不把 HTTP 200 或模型高分当作业务成功。缺凭证、接口失败或证据不足时回退；不要为了获得成功删除数据保留策略或换目的地址。
5. 最终回复引用本次证据，按全局规则报告调用次数、答案、原始置信度和复核处理。离线 `--check`、读取文档、模拟测试与旧记录均不是本轮 Jev 调用。

## 本机 MCP：优先入口

客户端工具列表中存在 `jev_check`、`jev_evaluate`、`jev_get_record` 时，优先使用本机 MCP。它把参数按 JSON Schema 交给同一套 Windows DPAPI 包装器，调用固定的 `typesafe-ai/jev` 与 Vercel `/v1/evaluate`，并把脱敏记录保存在 `%LOCALAPPDATA%/ModelTaskRouting/mcp/records`。原始 `state` 只写入临时文件，调用后删除；审计记录只保留输入哈希、用途、答案、概率/置信度、用量与错误状态。

- `jev_check`：离线检查，不发模型请求，不计 Jev 调用。
- `jev_evaluate`：每次调用发起一次评价请求；输入上限 64 KiB、最多 16 个问题、一次只处理一个评价请求且每分钟最多 20 次，不接受凭证、私钥、助记词和签名材料。
- `jev_get_record`：只接受 MCP 发放的 `recordId`，不接受任意文件路径。

MCP 不改变判断边界：确定性计算与交易执行仍由代码负责，Jev 只做边界清楚的语义判断。工具不存在、启动失败或客户端不支持 MCP 时再使用下面的脚本入口；不要为同一判断同时调用两个入口。

## Windows：建议使用同用户加密凭证包装器

Windows 自带 PowerShell 5.1（`powershell.exe`）或 PowerShell 7（`pwsh`），以及 Node.js 22+。在 Skill 根目录执行；不要求其他客户端能找到 Codex 私有目录里的 `pwsh`：

```powershell
# 仅首次尚无可用凭证、且用户要求配置时运行；在本地隐藏输入密钥。
powershell.exe -NoProfile -File .\scripts\jev-windows.ps1 -Setup

# 离线检查，不发请求。
powershell.exe -NoProfile -File .\scripts\jev-windows.ps1 -InputPath .\examples\jev-request.json -Check

# 真正调用一次；输出改为当前任务的私有绝对路径。
powershell.exe -NoProfile -File .\scripts\jev-windows.ps1 -InputPath 'D:\private-task\request.json' -OutputPath 'D:\private-task\jev-result-001.json'
```

读取顺序：当前进程 `AI_GATEWAY_API_KEY` → `%LOCALAPPDATA%\ModelTaskRouting\ai-gateway.dpapi`。`-CredentialPath` 可指定用户明确配置的其他 DPAPI 文件。Setup 不覆盖旧凭证；已有凭证不重复询问。需要替换失效凭证时由用户明确要求后保留旧文件再配置，不能自动换 key 或购买额度。

凭证以 Windows DPAPI CurrentUser 加密保存，只在调用时放入 Node 子进程环境；不写入全局用户环境，不传到命令行、模型输入、证据或仓库。DPAPI 不能防止同 Windows 用户权限下的恶意程序；它也不支持将文件直接复制到另一用户或另一设备当作已配置凭证。执行 AI 不要用 `Get-Content` 打印凭证、从旧聊天扫描密钥或把密钥粘进脚本。

Accio Work / Antigravity 若与 Codex 运行于同一 Windows 用户且可访问脚本、凭证和网络，可调用同一包装器。沙箱、虚拟机、云端或其他用户未必可访问这些资源；先检查实际执行环境，不因为电脑相同就声称都已接通。

## 其他对话报告“无法使用”时

先保存实际执行命令、错误码与执行环境。若客户端暴露 Jev MCP，先调用 `jev_check`；否则运行包装器的 `-Check`。不凭环境变量为空、没有 Jev 内置模型或旧对话未加载规则就判定接口不可用。Jev 是本机 MCP/脚本调用的网关服务，不需要出现在主代理的内置模型列表中。

- **找不到 pwsh / ScriptRequiresUnmatchedPSVersion**：新版包装器支持 Windows PowerShell 5.1。使用系统 `powershell.exe`；PATH 缺失时使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 的绝对路径。不修改客户端权限或全局 PATH。
- **Node 直调显示 apiKeyConfigured=false**：Node 本身只读进程环境，不读 DPAPI 文件。Windows 应通过 `jev-windows.ps1 -Check` 检查，这与没有可用凭证不是同一个结论。
- **input_json_or_encoding_invalid / input_schema_invalid**：前者为文件格式或编码，后者为请求字段。脚本接受 UTF-8（有/无 BOM）及带 BOM 的 UTF-16LE；不能把格式错误说成 Jev 服务不可用。
- **output_parent_missing / output_already_exists**：先在当前任务范围内创建输出父目录，选一个未使用的文件名；不覆盖已有证据。`input_not_readable` 则核对输入路径及权限。
- **文件访问、DPAPI 解密或网络被拒绝**：报告实际边界。不同 Windows 用户、沙箱、虚拟机和云端不能沿用“当前会话可用”的结论；不绕过拒绝或把密钥复制到模型上下文。

离线检查只证明入口、输入与凭证可读，不证明网关网络正常；仅在排障需要且已有授权时再做一次最小真实请求。`-Check` 与格式失败均不计 Jev 推理次数。

## 其他环境：使用环境变量

通过客户端的私密凭证配置或用户本机终端设置 `AI_GATEWAY_API_KEY`，不把真实值放入给 AI 的命令或版本控制。脚本不把 `TYPESAFE_AI_API_KEY` 混用为 Vercel key，也不扫描 `.env`、浏览器或聊天记录找凭证。

```bash
node scripts/jev-evaluate.mjs --input /private/task/request.json --check
node scripts/jev-evaluate.mjs --input /private/task/request.json --output /private/task/jev-result-001.json
```

脚本固定网关地址与模型，禁止重定向，没有自动重试；超时 25 秒。若输入显式包含 `providerOptions`，原样传递已有策略，失败时不删除策略重试。401/403 检查认证和权限，429 检查限额或等待；任何另行重试都生成新证据并计数。服务的用量、费用与路由保留实际返回值；未返回不估算。

## 返回与置信度

证据记录输入哈希、schema 版本、用途、时间、请求/成功/失败次数、实际模型、答案、原始概率/置信度、用量和复核状态；不记录原始 `state` 或认证头。仍应将结果放在任务私有目录，因为问题名和输出本身也可能涉及业务信息。

- Choice / Score：从实际答案的 `confidence` 或 `providerMetadata.typesafe.confidence[questionId]` 读取原值，缺失为 null/N/A，不用最大选项概率冒充。
- Boolean：读 `probability`，记录为 `pTrue`，confidence=null/N/A。低 p(true) 表示偏向“否”，不能因此触发 Choice 的低置信度规则。
- `<0.80` 只是临时、未校准的主推理模型复核提醒。`not_flagged` 仅代表未触发这个数值提醒；不是允许执行的信号。错误、字段缺失、未知答案仍须按证据判断。

若业务本身使用 AI SDK，需要 7+ 的 `experimental_evaluate`；传自建 gateway 时用 `gateway.evaluationModel('typesafe-ai/jev')`，同样读取 provider metadata。不为调用本脚本要求安装 AI SDK。[SDK 与 HTTP 官方契约](https://vercel.com/docs/ai-gateway/modalities/evaluation)、[概率与置信度区别](https://vercel.com/i/jev-probabilities-and-thresholds)
