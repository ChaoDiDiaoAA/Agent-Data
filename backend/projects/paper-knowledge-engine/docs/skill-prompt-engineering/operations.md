# Skill & Prompt Engineering 操作说明

`skill-prompt-engineering` 是只收录 arXiv 论文的 paper 方向库，起点为 `2025-01-01`，Current 总上限为 200，Weekly 增量上限为 20。配置把主题分成两个互斥的主题族：`pe-*` 是 Prompt Engineering，`se-*` 是 Skill Engineering；`se-rsi` 专门收录 Skill 的递归自我改进（Recursive Self-Improvement）。

## 主题边界

Prompt 主题（`pe-*`）处理提示词本身及其工程化生命周期：基础、指令设计、上下文学习、推理、自我精炼、自动优化、结构化输出、检索/工具增强、安全和评测。

Skill 主题（`se-*`）处理可复用能力的生命周期：表示、获取、检索、组合、程序性记忆、跨任务迁移、自我演化（自进化）和演化评测。`se-rsi` 还要求论文明确被改进的对象与递归迭代、评估或选择机制；金融技术分析中的 RSI、普通 SFT/DPO/RL 或只有一次反思的论文不会仅凭关键词入选。

两类主题都要求标题或摘要出现语言模型、语言 Agent 或 Agent 的对象证据，以及对应的 Prompt/Skill 工程信号。Track 标签不能替代来源文本证据；同一论文命中多个 Track 时，任务计数仍按唯一 `baseId/version` 去重。

| 主题族 | Track | 主题边界 |
| --- | --- | --- |
| Prompt | `pe-foundations`、`pe-instruction-design`、`pe-in-context-learning`、`pe-reasoning`、`pe-self-refinement` | 提示词基础、指令设计、上下文学习、推理、自我精炼 |
| Prompt | `pe-optimization`、`pe-structured-output`、`pe-grounded-tool-prompting`、`pe-safety`、`pe-evaluation` | 优化、结构化输出、检索/工具增强、安全、评测 |
| Skill | `se-representation`、`se-acquisition`、`se-retrieval`、`se-composition`、`se-procedural-memory` | 技能表示、获取、检索、组合、程序性记忆 |
| Skill | `se-transfer`、`se-self-evolution`、`se-evolution-evaluation`、`se-rsi` | 跨任务迁移、自我演化（自进化）、演化评测、递归自我改进 |

## 只读检查

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun src/cli.ts --library skill-prompt-engineering harvest-plan --mode current --format json
bun src/cli.ts --library skill-prompt-engineering schedule-config --format json
bun src/cli.ts --library skill-prompt-engineering arxiv-check --format json
bun src/cli.ts --library skill-prompt-engineering mineru-config --format json
```

正常计划包含 19 个 Track、38 个分片（19 个 `submitted`、19 个 `updated`）。这些检查不会创建数据库、run、PDF、Archive 或 Evidence。

## 首次小批量与手动周任务

先用小批量确认网络、OpenCLI、PDF 下载和 MinerU：

```powershell
bun src/cli.ts --library skill-prompt-engineering run-task --mode current --limit 5 --format json
```

确认后可手动运行增量任务：

```powershell
bun src/cli.ts --library skill-prompt-engineering run-task --mode weekly --format json
bun src/cli.ts --library skill-prompt-engineering reconcile
bun src/cli.ts --library skill-prompt-engineering evidence-publish --run-id RUN_ID
```

`weekly_schedule.enabled` 当前为 `false`，因此不会注册 Windows、Codex 或其他后台自动调度；`schedule-config` 只用于查看手动任务契约。失败恢复时保持同一库、模式和限额重跑，复用检查点与固定选篇；收到 arXiv 429 时按共享限流规则结束，不删除数据库或检查点。

## 数据根

```text
D:\agent-data\data\paper-libraries\skill-prompt-engineering
D:\agent-data\backups\paper-libraries\skill-prompt-engineering
D:\paper\paper-knowledge-engine\skill-prompt-engineering
D:\obsidian\data\paper-knowledge-engine\skill-prompt-engineering
```

四个根按 `skill-prompt-engineering` 派生，与其他方向的数据库、PDF、Archive、Evidence 和 Vault 隔离；arXiv 请求节流和 MinerU 资源锁仍在机器级共享。

## 配置文件

- `config/skill-prompt-engineering/library.yaml`：起点、Current/Weekly 限额、禁用的调度描述和 19 个 Track。
- `config/skill-prompt-engineering/query-matrix.yaml`：每个 Track 的 arXiv 查询、分类和 `submitted/updated` 两种日期模式。
- `config/skill-prompt-engineering/paper-policy.yaml`：语言模型/Agent 对象证据、Prompt/Skill 工程信号和 RSI 边界。
- `config/skill-prompt-engineering/categories.yaml`：10 个 Prompt 分类、9 个 Skill 分类及 `99-Unclassified` 兜底目录。

定向回归命令：

```powershell
bun test --timeout 30000 tests/skill-prompt-engineering-paper-library.test.ts
```
