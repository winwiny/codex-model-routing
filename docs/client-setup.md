# 配置持久化分工规则

Skill 保存方法和通用模板；客户端的持久化指令承载每轮必须遵循的规则。单纯下载或安装 Skill 不等于配置常驻规则，更不等于接通 Jev。以下机制核对于 2026-09-20；实际客户端版本与宿主暴露的配置位置优先，升级后有差异应重新核查官方文档。

## 客户端位置与作用域

| 客户端 | 指令入口 | 作用范围与限制 |
|---|---|---|
| Codex | `CODEX_HOME` 下首个非空 `AGENTS.override.md`，否则 `AGENTS.md`；未设置时默认 `~/.codex` | 用户全局；项目规则还会合并。默认总预算 32 KiB，不能仅检查全局文件就保证完整加载。新建会话核对加载结果。 |
| Antigravity 2.0 / IDE / CLI | `~/.gemini/GEMINI.md` | 全局 Rules；每文件 12,000 字符限制。不能把技能目录当规则目录；本次未验证各客户端界面实际加载。 |
| Accio Work | 当前 Agent 的 `agents/{agentId}/agent-core/AGENTS.md` | **该 Agent 的持久化行为规则**。官方未确认统一账号全局规则文件，亦未公开此相对路径的固定本机根目录；使用宿主配置或用户提供的实际路径。不能遍历所有 Agent 或声称未来新建 Agent 已生效。 |

来源：[Codex 指令发现](https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance)、[Antigravity Rules](https://www.antigravity.google/docs/rules-workflows?tab=ide)、[Accio Agent Core](https://www.accio.com/wow/doc-agent-core-design.html)。路径是文件机制证据，不能据此声称当前设备已经加载规则。

## 从用户要求到写入

1. 区分普通调用与配置请求。用户已经要求安装并启用默认规则、写入全局指令或更新此规则时，已有授权覆盖相应配置，不重复询问；仅克隆或只读审查不触发写入。仅处理用户指定的客户端；本 Skill 不自行配置其他账号、开通 API、修改模型或交易权限。
2. 读取实际目标文件及适用指令，确认作用域与冲突。保留用户原有模型偏好、业务规则和权限；不要把当前项目的套利限制复制进其他行业的全局规则，也不要把主代理身份硬编码为 Codex。
3. 在 Skill 根目录运行以下命令预览。脚本默认不写文件、不打印原有指令内容，只输出路径、状态、大小、哈希等摘要。确认目标与预期一致后，在已有配置授权内添加 `--apply` 执行。预览是本地检查，不是要求用户重复批准。

```bash
python scripts/sync_global_rules.py --client codex
python scripts/sync_global_rules.py --client codex --apply

python scripts/sync_global_rules.py --client antigravity
python scripts/sync_global_rules.py --client antigravity --apply
```

Codex 可用 `--codex-home` 指定实际 Codex Home。隔离测试使用 `--user-home`；它不意味着客户端已改用该目录。不要擅自设置或覆盖用户的 `HOME`、`CODEX_HOME`。

Accio Work 先从当前 Agent 的宿主配置或用户提供的路径确定绝对 Agent Core 目录，核对现有 `AGENTS.md`，再执行（占位路径必须替换）：

```bash
python scripts/sync_global_rules.py --client accio-work --agent-core "/actual/agents/agent-id/agent-core"
python scripts/sync_global_rules.py --client accio-work --agent-core "/actual/agents/agent-id/agent-core" --apply
```

没有 Agent 路径或文件访问能力时导出通用模板，明确“已生成，尚未写入/激活”，交由用户在相应 Agent 或配置界面使用；不能将模板导出当作账号全局配置成功。

```bash
python scripts/sync_global_rules.py --client accio-work --export "accio-work-routing-rules.md"
```

4. 每次实际改写现存文件前保存唯一备份并核验；托管标记间更新，外围字节保留。幂等运行不追加副本、不产生无意义备份。残缺/重复标记拒绝写入。脚本检测到无标记的旧手工 Jev 规则时返回 `unmanaged_rules_needs_merge`：主代理先比对，备份并整合已授权的规则区域，保留自定义要求；无法判断语义冲突才向用户集中说明，不自动删整段或追加冲突副本。
5. 读回核对目标哈希、唯一托管块、原内容保留和备份。检查已有项目/Agent 规则有无冲突；遵守宿主优先级，不为了“全球统一”覆盖它们。规则超预算时调整作用域或移出详细说明，不能靠增大限制声称已完整加载。
6. 告知真实状态：代码/规则已准备、已写哪些路径、哪一作用域、是否已在新会话验证。宿主重载或新会话后检查已加载规则与一次真实最终回复；验证零调用时必须报告 0/N/A。仅凭文件存在不能宣称所有模型、未来会话或其他 Agent 已执行。

没有 Python 时可用客户端本身的文件工具按上述合并、备份和验证规则执行；脚本只是确定性辅助，不应为了安装一段文字强制开通新服务。

## 安装 Skill 本身

- Codex：沿用 README 的 `~/.agents/skills/model-task-routing` 或项目 `.agents/skills/model-task-routing`，不要同时安装同名重复副本。
- Antigravity 2.0 / IDE：官方当前全局技能目录为 `~/.gemini/config/skills/<skill-name>/SKILL.md`，IDE 兼容 `~/.gemini/antigravity/skills/`；CLI 使用 `~/.gemini/antigravity-cli/skills/<skill-name>/SKILL.md`。选当前客户端实际使用的一处，保持整个 Skill 的 assets/docs/scripts 相对结构。[官方 Skills 文档](https://antigravity.google/docs/skills)
- Accio Work：通过 **Skills → Install Local Skill** 安装，并在目标 Agent 配置中选中。账号共享 Skill 与 Agent 私有同名 Skill 有优先级，必须确认目标 Agent 实际加载哪个版本；共享安装不等于所有 Agent 的行为规则已经修改。[官方 Skills Guide](https://www.accio.com/wow/doc-skills-guide.html)

`typesafe-ai` 是可选集成依赖：需要实际使用 Jev 时再按对应客户端安装、读取其实时文档并验证凭证。不要在公共模板保存用户的 API key 或复制当前对话；模板配置不会发出 Jev 请求。无可用 API 时仍可使用原有模型分工并报告 0 次。

## 置信度与报告来源

按模板报告原始数值，不能把 `p(true)`、选项概率、评分当作 confidence。TypeSafe 的 Choice/Score confidence 概括分布集中程度，不保证真实正确率；阈值需要独立标签样本验证。参考 [TypeSafe Confidence](https://docs.typesafe.ai/confidence)、[Vercel 概率与阈值](https://vercel.com/i/jev-probabilities-and-thresholds)。模板里的 0.80 是暂时的主推理模型复核提醒，不是服务官方通用阈值或业务放行门。
