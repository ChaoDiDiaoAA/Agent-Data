# Agent Tool & RSI 操作说明

`agent-tool` 是只收录 arXiv 论文的 paper 方向库，覆盖 Agent Tool、LLM 工具后训练和递归自我改进（RSI）。它从 `2026-01-01` 开始扫描，Current 总上限为 270（18 个 Track 各 15），Weekly 增量上限为 12。`weekly_schedule.enabled` 当前为 `false`，需要手动执行命令。

## 只读检查

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun src/cli.ts --library agent-tool harvest-plan --mode current --format json
bun src/cli.ts --library agent-tool schedule-config --format json
bun src/cli.ts --library agent-tool arxiv-check --format json
bun src/cli.ts --library agent-tool mineru-config --format json
```

正常计划应包含 18 个 Track、36 个分片（18 个 `submitted`、18 个 `updated`）。只读检查不会创建数据库、run、PDF、Archive 或 Evidence。

## 首次小批量

先运行五篇小批量，确认代理、OpenCLI、PDF 下载和 MinerU 均可用：

```powershell
bun src/cli.ts --library agent-tool run-task --mode current --limit 5 --format json
```

结果中的 `candidates`、`accepted`、`newVersions`、`archived` 和 `published` 按唯一 `baseId/version` 计数，不按 Track 命中次数计数。抽查结果时，至少覆盖一个普通工具 Track、一个工具后训练 Track 和一个 RSI Track。

## 日常增量与恢复

```powershell
bun src/cli.ts --library agent-tool run-task --mode weekly --format json
bun src/cli.ts --library agent-tool reconcile
bun src/cli.ts --library agent-tool evidence-publish --run-id RUN_ID
```

失败时保持相同的库、模式和限额重跑，让检查点复用固定选篇。收到 429 时任务按共享 arXiv 规则结束，不删除数据库或检查点，也不连续高频重试。

## 收录边界

后训练 Track 必须同时满足工具能力和训练方法、训练数据或训练效果证据；普通 SFT、DPO 或 RL 论文不会仅凭算法名称进入本库。RSI Track 必须在标题或摘要中明确改进对象（工具、Agent、代码或改进器）以及迭代、评估或选择机制；裸 `RSI` 会被视为歧义词。工具生成、技能积累或普通反思可以作为相关证据，但不会自动等同于递归自我改进。

自动来源仅为 OpenCLI/arXiv。用户明确指定的历史论文可以通过现有 `import-local` / `parse-local` 入口导入，不会改变 arXiv 水位或自动候选计数。

## 数据根

```text
D:\agent-data\data\paper-libraries\agent-tool
D:\agent-data\backups\paper-libraries\agent-tool
D:\paper\paper-knowledge-engine\agent-tool
D:\obsidian\data\paper-knowledge-engine\agent-tool
```

四个根按 `agent-tool` 派生，与其他方向的数据库、PDF、Archive、Evidence 和 Vault 隔离；arXiv 请求节流和 MinerU 资源锁仍在机器级共享。
