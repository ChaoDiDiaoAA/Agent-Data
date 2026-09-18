# Agent Memory 操作说明

`agent-memory` 是只收录 arXiv 论文的 paper 方向库，显示名为 `Agent Memory（智能体记忆知识库）`。它覆盖运行时记忆、RSI 记忆和 LLM 后训练记忆。自动起点为 `2026-01-01`，Current 总上限为 200（20 个 Track 各 10），Weekly 增量上限为 20；`weekly_schedule.enabled` 当前为 `false`，需要手动执行命令。

所有命令从项目根目录执行：

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
```

## 只读检查

```powershell
bun src/cli.ts --library agent-memory harvest-plan --mode current --format json
bun src/cli.ts --library agent-memory schedule-config --format json
bun src/cli.ts --library agent-memory arxiv-check --format json
bun src/cli.ts --library agent-memory mineru-config --format json
```

正常计划应包含 20 个 Track、40 个分片（20 个 `submitted`、20 个 `updated`）。只读检查不会创建数据库、run、PDF、Archive 或 Evidence。

## 首期小批量

先运行最多五篇，核对代理、OpenCLI、PDF 下载和 MinerU：

```powershell
bun src/cli.ts --library agent-memory run-task --mode current --limit 5 --format json
```

抽查结果时应覆盖一个运行时记忆 Track、`mem-rsi`，以及一个后训练记忆 Track。后训练记忆论文可以没有 Agent，只要标题或摘要明确包含语言模型对象和记忆能力、知识保持、记忆更新或遗忘证据。

## 日常增量与恢复

```powershell
bun src/cli.ts --library agent-memory run-task --mode weekly --format json
bun src/cli.ts --library agent-memory reconcile
bun src/cli.ts --library agent-memory evidence-publish --run-id RUN_ID
```

失败时用相同的库、模式、日期范围和限额重跑，让检查点复用已固定选篇。收到 429 时按共享 arXiv 规则结束任务；不要删除数据库或检查点，也不要连续高频重试。

## 收录边界

运行时记忆关注写入、组织、检索、巩固、共享、个性化、安全和长期评测。`mem-rsi` 要求记忆、经验或技能积累与后续改进循环同时出现。后训练记忆分为监督训练、RL/偏好优化、蒸馏和参数化记忆四类；普通 SFT、RL、蒸馏、GPU 显存优化、普通 RAG 或没有记忆机制的一次性自我纠错不会仅凭宽泛术语进入本库。

自动来源仅为 OpenCLI/arXiv。历史论文可以通过现有本地 PDF 入口导入，不会改变 arXiv 水位或自动候选计数。

## 数据根

```text
D:\agent-data\data\paper-libraries\agent-memory
D:\agent-data\backups\paper-libraries\agent-memory
D:\paper\paper-knowledge-engine\agent-memory
D:\obsidian\data\paper-knowledge-engine\agent-memory
```

四个根按 `agent-memory` 派生，与其他方向的数据库、PDF、Archive、Evidence 和 Vault 隔离；arXiv 请求节流和 MinerU 资源锁仍在机器级共享。
