# Jev 本机调用

本仓库的 CLI 与 STDIO MCP 共用 `scripts/jev-core.mjs`。核心固定使用官方 `@typesafe-ai/sdk@0.6.0`、官方模型别名 `jev-latest` 和 TypeSafe 直连；没有另一套手写 HTTP 实现。Node.js 要求 20 或更新版本。

## CLI

安装后用 stdin 传 JSON，密钥不会出现在参数中：

```sh
jev doctor
jev evaluate < request.json
```

`doctor` 默认只检查 Node 与凭证是否可用，`requestsAttempted` 固定为 0；只有用户明确执行 `jev doctor --live` 才会发送一条最小测试请求。`evaluate` 接受官方结构：顶层 `state` 可以是 string、object、array 或 null；`instructions` 与各项 `criteria` 同样接受官方 EntryType 语义。问题类型为 `noul`、`choice`、`score`；旧 `boolean` 输入会在发送前标准化为 `noul`。

请求最多 64 KiB、16 个问题。疑似 API Key、密码、私钥、签名、助记词等材料会在创建 SDK Client 之前拒绝。错误只输出稳定 code，不转发可能含敏感材料的 SDK 异常正文。

## 凭证顺序

- macOS：读取当前用户 Keychain 的 generic password，service 固定为 `typesafe-ai-direct`。
- Windows：读取 `%LOCALAPPDATA%\ModelTaskRouting\typesafe.dpapi`，使用 DPAPI CurrentUser 解密。
- 环境变量：只在 `--allow-env`、`JEV_ALLOW_ENV_CREDENTIAL=1` 或 CI 环境中作为备用；原生凭证优先。

不要把 `TYPESAFE_API_KEY` 写进 MCP 参数、客户端配置、README、日志、记录或命令行。Windows 的 `jev-windows.ps1` 仍用于隐藏输入创建 DPAPI 凭证，也兼容旧的文件输入调用方式。

Windows MCP 内部的 DPAPI helper 只在 Node 父进程提供一次性标记且 stdout 已重定向时解密；明文通过父子进程的私有捕获管道返回内存，不写文件、不进入命令行，父进程也不会转发该 stdout。单独从终端执行 helper 会拒绝输出。这里的“私有管道”不表示明文从未经过 stdout，而是明确限制为不面向用户的重定向管道。

## 请求示例

```json
{
  "state": {"ticket": "Charged twice; please refund the duplicate."},
  "questions": {
    "category": {
      "type": "choice",
      "instructions": {"task": "Choose the ticket category."},
      "criteria": {"billing": null, "technical": null, "other": null}
    },
    "refund_requested": {
      "type": "noul",
      "instructions": ["Did the customer explicitly request a refund?"],
      "criteria": {"true": "Explicit request", "false": null}
    },
    "urgency": {
      "type": "score",
      "instructions": "Score stated urgency only.",
      "criteria": [null, {"level": "near-term deadline"}, ["immediate", "blocking"]]
    }
  }
}
```

Jev 返回 typed judgments 和概率，不返回推理文本，也不执行分类结果。Choice/Score 的 confidence 与 Noul 的 p(true) 应原样报告；是否复核、阈值和后续动作由代码或主代理决定。
