# codex-model-routing
A Codex skill for task-based model selection, reasoning effort, and agent delegation—balancing quality, cost, and speed.

按任务难度选择模型和思考档位：主代理负责分析、决策和验收，子代理负责具体编码。避免每项工作都经过多层转交，也避免让小模型反复处理超出能力的任务。

这是一个纯指令型 Skill，不需要安装依赖或运行安装脚本。它不会自动修改 Codex 配置、切换当前模型或开通模型权限。

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
涉及编码委派与模型分工时，使用已安装的 model-task-routing Skill。主代理负责分析、决策和最终验收，具体编码按任务难度交给子代理。
```

## 默认分工

| 模型 | 工作范围 | 建议思考档位 |
|---|---|---|
| GPT-6 Astra | 需求分析、方案决策、范围控制、最终验收 | medium；困难问题 high |
| GPT-5.6 Luna | 明确的小修改、固定规则的批量处理 | low / medium |
| GPT-5.6 Terra | 常规页面、交互、功能开发与测试 | medium |
| GPT-5.6 Sol | 多模块问题、复杂故障、技术拆解与组织验证 | medium / high |

小任务可以直接交给 Luna；日常开发交给 Terra；复杂问题交给 Sol。Sol 可以直接编码，也可以按需组织独立子任务，不要求四个模型逐层转交。

普通讨论、文档整理和只读核查由主代理直接完成。连续修复仍未通过时，先判断缺信息还是能力不足，再补证据或升级模型。详细规则见 [SKILL.md](SKILL.md)。

## 环境要求与边界

- 模型名称是这份 Skill 的默认配置，不保证所有账号或客户端都能使用。按环境实际提供的模型 ID 和思考档位执行。
- 自动委派需要当前环境支持子代理及模型选择。没有这些能力时，Skill 可以辅助制定分工，但不能凭指令创建不存在的工具；它会说明限制，不冒充已调用指定模型。
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

如有本地修改或更新冲突，先检查并保留自己的内容，不要强制覆盖。

## 卸载

删除安装时创建的 `model-task-routing` 目录即可。若曾手动在 `AGENTS.md` 中加入引用，也需自行移除。操作前保留自己的修改。

## 验证与反馈

本版本通过 Skill 元数据格式检查。安装目录与更新命令经过隔离目录验证；尚未完成跨客户端自动触发测试或模型成本对照实验。

欢迎通过 Issues 或 Pull Requests 提交问题与改进。报告时请说明客户端、可用模型、任务类型和预期行为，不要提交密钥、个人聊天记录或业务私密数据。

## License

[MIT](LICENSE) © 2026 winwiny。社区项目，与 OpenAI 无隶属关系。
