# agent-data

本仓库统一管理本地项目代码与公共说明。运行数据、PDF、模型和 Obsidian 内容不提交到 Git。

## Git 分工

- `main`：公共目录调整、维护，以及已经验收合并的项目成果。
- `paper-knowledge-engine`：论文知识引擎后续开发；完成并确认后合并到 `main`。
- 分支作用于整个仓库，不按目录自动隔离。提交前检查范围，不夹带其他任务的修改。

## 项目入口

当前活动项目包括 [Paper Knowledge Engine](backend/projects/paper-knowledge-engine/README.md) 和独立的 [DataWatch 数据获取](backend/projects/datawatch-data/README.md)。两者都使用 Bun / TypeScript；DataWatch 不调用 LLM 或 MinerU。

Paper Knowledge Engine 是不调用 LLM 的确定性论文资料流水线：

```text
OpenCLI / arXiv → 规则筛选 → PDF → 本地 MinerU → Archive v2 → Obsidian Evidence v3
```

当前配置了 8 个彼此隔离的方向库：

| 方向库 | 稳定标识 | 主题 |
| --- | --- | --- |
| FSD 论文知识库 | `fsd` | 软件工程、程序分析、代码迁移与验证 |
| Agent Engineering | `agent-engineering` | Agent 应用工程、运行时、权限、测试与运维 |
| Multi-Agent Engineering | `multi-agent-engineering` | 多 Agent 协作、委派、通信、治理与评测 |
| LLM Post-Training | `llm-post-training` | SFT、偏好优化、RL、蒸馏、安全与后训练评测 |
| Agent Tool & RSI | `agent-tool` | 工具使用/生成、工具后训练与递归自我改进 |
| Agent & LLM Context | `agent-context` | Context 工程、上下文后训练与 RSI Context |
| Skill & Prompt Engineering | `skill-prompt-engineering` | Prompt 与可复用 Skill 的获取、组合、演化和评测 |
| Agent Memory | `agent-memory` | 运行时记忆、后训练记忆与 RSI 记忆 |

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun src/cli.ts
```

启动后选择方向库；直接执行任务必须明确传入 `--library <library-id>`，例如：

```powershell
bun src/cli.ts --library agent-context run-task --mode current
```

各方向的检索范围、当前配额和完整命令见[项目 README](backend/projects/paper-knowledge-engine/README.md)与[使用手册](backend/projects/paper-knowledge-engine/使用手册.md)。

| 位置 | 职责 |
| --- | --- |
| [backend/projects/datawatch-data](backend/projects/datawatch-data/README.md) | 四个公开 Hugging Face 数据集的确定性获取、校验、菜单和文档（[使用说明](backend/projects/datawatch-data/使用说明.md)）；每个数据集只保留最新快照，完整 SHA 位于清单、运行记录、versions.json 和备份清单；原件位于 D:\paper\DataWatch，状态位于 D:\agent-data\data\datawatch-data，Obsidian 副本位于 D:\obsidian\data\datawatch-data，备份位于 D:\agent-data\backups\datawatch-data |
| `backend/projects/paper-knowledge-engine` | 论文知识引擎代码、方向配置、测试和文档 |
| `data/paper-libraries/<library-id>` | 各方向的 SQLite、Archive、运行记录与工作目录，不纳入 Git |
| `backups/paper-libraries/<library-id>` | 各方向的可恢复备份，不纳入 Git |
| `D:\paper\paper-knowledge-engine\<library-id>` | 各方向的原始 PDF |
| `D:\obsidian\data\paper-knowledge-engine\<library-id>` | 各方向的 Obsidian Vault 内容 |
| `tools/MinerU` | 本机 MinerU 环境与模型，不纳入 Git |
| `backend/projects/flowmate-data` | 尚未实现的项目及历史脚本，不属于论文流程 |

旧 FSD 代码已有历史分支 `codex/fsd-legacy-snapshot-20260905`（`0521fc1`）。旧目录移除记录保留在 Git 中，不再作为日常入口。
