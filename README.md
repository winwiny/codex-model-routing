# codex-model-routing
A skill for task-based model routing, Jev judgments, and persistent client instructions.

按任务的明确程度、上下文复杂度和验收风险选择模型与思考档位。支持按需委派，也支持“主代理分析验收、全部编码交给子代理”的工作方式。

包含模型分工指令、Jev 调用说明、通用规则模板与可选的配置脚本。普通使用不需要安装依赖；配置辅助脚本用 Python 标准库，Jev 调用脚本用 Node.js 22+，无需 `npm install`。克隆不会自行修改客户端规则、切换模型或开通 API。

## 一次配置，后续会话沿用

把完整 Skill 交给支持本地技能的客户端后，可以这样要求：

```text
使用 model-task-routing，为当前客户端配置持久化默认规则：主推理模型负责复杂推理，Jev 负责适合的语义判断，代码负责计算和流程；每轮回复报告 Jev 使用记录与原始置信度。按客户端实际入口合并，保留已有规则并验证作用域。Accio Work 仅配置当前 Agent，不能声称账号全局。
```

| 客户端 | 持久化入口 |
|---|---|
| Codex | 实际 `CODEX_HOME` 的 `AGENTS.md` 或生效的 `AGENTS.override.md` |
| Antigravity | `~/.gemini/GEMINI.md` 全局 Rules |
| Accio Work | 当前 Agent 的 `agent-core/AGENTS.md`，需要实际路径证据 |

安装位置、预览/写入命令、备份、重复安装与旧规则合并见 [客户端配置说明](docs/client-setup.md)。支持的是宿主指令机制，不能保证所有模型都严格执行；配置后应在新会话核对加载结果。其他设备从 GitHub 安装时只得到已推送版本，不会收到你的未提交修改或凭证。

## 如何实际调用 Jev

AI 读取 [本机调用说明](docs/jev-invocation.md)，准备必要输入。客户端已经配置本机 Jev MCP 时，优先使用 `jev_check` / `jev_evaluate` / `jev_get_record`；否则调用随 Skill 附带的脚本。MCP 安装、工具与安全边界见 [本机 Jev MCP](docs/jev-mcp.md)。模型固定为官方别名 `jev-latest`，直接调用 TypeSafe 的 `POST https://api.typesafe.ai/v1/systemone`，不替换主代理的聊天模型。认证走 `TYPESAFE_API_KEY` 或 Windows 本机加密凭证；公共仓库不含密钥。

```bash
node scripts/jev-evaluate.mjs --input examples/jev-request.json --check
node scripts/jev-evaluate.mjs --input examples/jev-request.json --output /absolute/private-path/jev-result.json
```

第一条离线检查不会调用模型；第二条在凭证与授权具备时发送一次真实请求。`--output` 指向任务的私有证据目录，不能覆盖旧记录。脚本会保存答案、原始 confidence、用量、失败与复核状态；不会执行 Jev 选择的业务动作。

## 快速安装

需要 Git，以及支持本地 Skills 的 Codex 环境。以下两种安装范围任选一种，不要重复安装同名 Skill。

### 个人安装：所有项目可用

macOS / Linux / Git Bash：

```bash
mkdir -p "$HOME/.agents/skills"
git clone https://github.com/winwiny/codex-model-routing.git "$HOME/.agents/skills/model-task-routing"
```

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force -Path "$HOME/.agents/skills" | Out-Null
git clone https://github.com/winwiny/codex-model-routing.git "$HOME/.agents/skills/model-task-routing"
```

安装完成后应存在 `~/.agents/skills/model-task-routing/SKILL.md`。如果目标目录已经存在，先确认它是否是本仓库的旧版本；不要覆盖自己的修改。

### 项目安装：只在当前项目使用

在项目根目录运行：

```bash
git clone https://github.com/winwiny/codex-model-routing.git .agents/skills/model-task-routing
```

这里得到的是一个独立的 Git 克隆；不会自动把 Skill 纳入外层项目的版本管理。

Codex 通常会自动发现 Skill；如果没有显示，重启 Codex 后再查看。目录位置与发现机制参见 [Codex 官方 Skills 文档](https://developers.openai.com/codex/skills)。

## 使用

在支持 `$` 提及 Skill 的 Codex 输入框中输入：

```text
$model-task-routing
帮我修改移动端咨询弹窗。先判断任务难度，再选择合适的子代理实现并验证。
```

也可以在 Skills 列表中选择 **model-task-routing**。支持隐式匹配的环境会根据任务内容决定是否加载；安装并不意味着每个任务都强制启用。

首次试用可以只检查分工，不改业务代码：

```text
使用 model-task-routing。分别说明“修改页脚文字”“开发常规页面交互”“定位跨前后端故障”应该交给哪个模型、使用什么思考档位。这次只说明计划，不启动执行代理。
```

如果希望项目默认采用这套规则，可自行把下面这句加入项目的 `AGENTS.md`；安装命令不会代为修改它：

```text
涉及编码委派与模型分工时，使用已安装的 model-task-routing Skill，采用按需委派模式。根据任务明确程度、上下文复杂度和验收风险选择执行方式。
```

## 执行模式

- **按需委派（公共默认）**：简单修改可以直接由当前主代理完成；有独立执行价值时才安排子代理，避免小任务的交接成本。
- **全部编码委派**：具体编码、修复和测试代码都由子代理完成；主代理负责分析、决策和验收，仍可直接编写文档或进行只读调查。

模式只是自然语言约定，不是 Codex 配置参数。用户或项目已有的明确要求优先，不会因为安装新版而取消原来的“主代理不写代码”约定。

如果偏好全部委派，可以用下面这句替换上面的 `AGENTS.md` 示例：

```text
使用 model-task-routing 的全部编码委派模式。主代理负责分析、决策和最终验收，不亲自编码；包括小修改在内的具体编码均交给当前任务内合适的子代理。普通讨论、文档整理和只读核查不强制委派。
```

## 模型选择起点

| 模型 | 工作范围 | 建议思考档位 |
|---|---|---|
| 当前主代理，用户偏好时选 Astra | 需求分析、方案决策、范围控制、最终验收 | 简单 low；一般 medium；困难 high |
| GPT-5.6 Luna | 要求明确、上下文有限、可独立验证的实现、修复与测试 | 简单修改 low；涉及逻辑 medium |
| GPT-5.6 Terra | 需理解现有项目、有局部不确定性或较多相关上下文的日常开发 | medium |
| GPT-5.6 Sol | 多模块问题、复杂故障、技术拆解与组织验证 | medium / high |
| GPT-6 Astra 执行子代理 | 陌生系统、疑难根因、复杂迁移或失败代价高的任务 | medium / high |

Luna 不限于改文字；要求清楚、可验证的编码与测试也可以交给它。Terra 适用于上下文和判断需求增加的任务。Sol 可以直接编码，也可以按需组织独立子任务；特别困难的任务允许直接选择 Astra 子代理。

不要求四个模型逐层转交，也不根据文件数量机械分配。主代理已经想清楚的方案，无需再让 Sol 重复分析。上表是待验证的默认起点，未证明是各任务的最优模型或档位。

普通讨论、文档整理和只读核查可直接完成。发现理解错误或超出能力时立即重新分配；连续两次修复未通过只是复盘提醒，不要求凑满两次，也不自动归因为模型能力。详细规则见 [SKILL.md](SKILL.md)。

## 设计依据

官方编码与长上下文测试支持按任务类型区分模型，而不是统一按“智商”排序。发布分数不能直接证明 low / medium 的表现；单价也不等于整个任务的成本。

参见 [设计依据与验证边界](docs/evidence.md)，其中列出了官方数据、链接、核对日期，以及尚需实测的部分。跑分资料独立存放，日常加载 Skill 时不必读取。

## 环境要求与边界

- 模型名称是这份 Skill 的默认配置，不保证所有账号或客户端都能使用。按环境实际提供的模型 ID 和思考档位执行。
- 自动委派需要当前环境支持子代理及模型选择。没有这些能力时，Skill 可以辅助制定分工，但不能凭指令创建不存在的工具；全部委派模式下报告受阻，不静默改成主代理编码。
- 主代理不是 Astra 时，不会自动切换；当前环境和用户指令决定实际模型。
- 保留项目已有 `AGENTS.md`、权限要求和用户改动；Skill 不授予发布、发送消息或其他额外操作的权限。
- 不保证固定比例的 token 或费用节省。应比较完成并验收整个任务的总消耗、耗时与返工，而不只看单个模型价格。

## 更新

个人安装：

```bash
git -C "$HOME/.agents/skills/model-task-routing" pull --ff-only
```

项目安装：

```bash
git -C .agents/skills/model-task-routing pull --ff-only
```

如有本地修改或更新冲突，先检查并保留自己的内容，不要强制覆盖。更新 Skill 文件不等于已更新常驻规则；用户要求同步规则时重新执行预览和合并。已有托管块仅在块内替换，无变化不重复写入；原有自定义规则须保留。

## 卸载

删除安装时创建的 `model-task-routing` 目录前保留自己的修改。曾配置常驻规则的，还需在实际客户端指令文件中只移除本 Skill 的托管块及相关引用，保留其他内容；移除 Skill 不会自动清空规则或删除本机凭证。需要撤销当前 Windows Jev 凭证时，单独处理已确认的 DPAPI 文件，不删除整个客户端目录。

## 验证与反馈

本版本通过 Skill 元数据格式检查。安装目录与更新命令经过隔离目录验证；对按需执行、强制委派受阻、Luna 实现测试、Astra 执行疑难任务四种情形完成了规则一致性走查。尚未完成跨客户端自动触发测试或模型成本对照实验。

新增规则同步脚本通过 Python 隔离测试；Jev 调用器与 MCP 桥接层包含 CLI 入口、官方问题格式、Windows 常见 JSON 编码、敏感输入拒绝、临时输入清理和审计记录读取测试。Windows DPAPI 包装器支持系统 PowerShell 5.1 与 PowerShell 7。迁移到官方 TypeSafe API 后，需要配置官方密钥并完成一次最小真实请求，才能声称当前凭证与网络链路已经接通。三个客户端的文件适配在隔离目录验证；未完成 Antigravity / Accio Work 的 MCP 客户端加载测试。单次调用不证明固定节省比例或业务判断准确率。

欢迎通过 Issues 或 Pull Requests 提交问题与改进。报告时请说明客户端、可用模型、任务类型和预期行为，不要提交密钥、个人聊天记录或业务私密数据。

## License

[MIT](LICENSE) © 2026 winwiny。社区项目，与 OpenAI 无隶属关系。
