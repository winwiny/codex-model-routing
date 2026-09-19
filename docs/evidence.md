# 设计依据与验证边界

核对日期：2026-09-19。本文只采用 OpenAI 官方发布和帮助文档，用于解释本 Skill 的候选路由规则，不把型号名称、单项跑分或单价换算成“智商”、固定能力等级或最优策略。

## 官方证据

[GPT-5.6 发布页](https://openai.com/index/gpt-5-6/)提供了同一张表中的三模型结果：

| 评测 | Sol | Terra | Luna | 可支持的判断 |
|---|---:|---:|---:|---|
| SWE-Bench Pro | 64.6% | 63.4% | 62.7% | 三者都具备较强代码修复能力，分差不足以单独决定路由 |
| DeepSWE v1.1 | 72.7% | 69.6% | 67.2% | 长程工程任务整体呈 Sol、Terra、Luna 梯度 |
| Internal Research Debugging Evaluation | 68.3% | 67.8% | 50.8% | 不确定调试中 Terra 明显更接近 Sol |
| OpenAI MRCR v2，8-needle，256K–512K | 91.5% | 89.6% | 41.3% | 长上下文任务不能只依据 SWE-Bench 的小分差选择 Luna |

[GPT-6 Astra 发布页](https://openai.com/index/gpt-6-astra/)提供 Astra 与 Sol 的同表对照：

| 评测 | Astra | Sol | 可支持的判断 |
|---|---:|---:|---|
| Terminal-Bench 4.0 | 57.9% | 37.3% | Astra 更适合困难的终端代理任务 |
| DeepSWE v1.1 | 74.1% | 72.7% | 两者都能承担长程工程任务，Astra 略高 |
| Internal Database Migration Tasks | 63.9% | 42.7% | Astra 可直接执行高不确定、跨步骤任务，不应只用于最终验收 |

官方的任务示例也支持按不确定性和范围路由：[Work/Codex 使用指南](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex)将 Astra 用于困难缺陷和陌生问题，将 Terra 用于日常代码修改，将 Luna 用于聚焦、重复或短小编辑。[GPT-5.6 价格性能说明](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/)给出的编码工作流示例，是先由 Sol 消除不确定性并制定方案，再由 Luna 实施定义清楚的修改、编写和运行测试、评估结果。这说明 Luna 可以编码和验证，适用边界主要来自任务是否清楚、局部和易验收。

据此，Skill 将 Luna、Terra、Sol、Astra 分别作为明确且可验证的实现与测试、需理解项目的日常开发、复杂工程、高不确定或陌生端到端任务的默认起点。Astra 同时适合主代理的方案决策和最终验收，但这些职责不排除使用 Astra 执行子代理处理困难任务。

## 验证边界

- GPT-5.6 发布页只明确说明 Artificial Analysis Coding Agent Index 中 Sol 的 80 分使用 `max`。上述 GPT-5.6 表格没有公开 Terra、Luna各分数对应的 reasoning effort，不能据此推断 `low` 或 `medium` 的表现。
- GPT-6 Astra 发布页的表格按每个模型在各 reasoning effort 中的最高分报告。它适合比较已展示模型的能力上沿，不能证明 Astra `medium`、Sol `high` 或任一指定档位会复现表中分数。
- 不同版本的同名基准不可直接横比，例如 Terminal-Bench 2.1 与 4.0。本文未复现官方内部评测，不能将其当成本仓库的实测结果。
- 发布跑分不包含本地仓库规则、提示词、工具权限、代理交接和验收流程的全部影响。更高 reasoning effort 可能增加用量，也不保证结果更好。
- API 单价、输出 token 数和订阅额度不是整项任务成本。任务成本还包括输入、推理、工具调用、主代理与子代理、交接、失败重试和人工验收；因此本文不写死价格或节省比例。
- 当前路由是基于官方证据形成的候选规则，不是全局最优证明。实际项目应以完成质量和总任务成本校准，允许直接选择更强模型或在失败后升级。

## 后续对照实验

- 对照模型和档位时使用同一任务、同一起始代码状态、同一工具权限与同一上下文材料。
- 预先固定验收标准、测试命令和最大尝试次数，避免事后改变成功定义。
- 分别记录交付质量、总用量、墙钟耗时、失败次数、返工次数和最终是否通过验收。
- 将主代理、子代理、交接、验证和重试都计入任务总量，不只记录执行代理的输出。
- 没有足够的重复样本和可信用量数据时，只报告观察结果，不宣称已经验证节省额度、时间或成本。
