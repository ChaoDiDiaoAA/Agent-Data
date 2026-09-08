# agent-data

本仓库统一管理本地项目代码与公共说明。运行数据、PDF、模型和 Obsidian 内容不提交到 Git。

## Git 分工

- `main`：公共目录调整、维护，以及已经验收合并的项目成果。
- `paper-knowledge-engine`：论文知识引擎后续开发；完成并确认后合并到 `main`。
- 分支作用于整个仓库，不按目录自动隔离。提交前检查范围，不夹带其他任务的修改。

## 项目入口

当前活动项目是 [Paper Knowledge Engine](backend/projects/paper-knowledge-engine/README.md)，使用 Bun / TypeScript，不调用 LLM。FSD 是其中一个论文方向。

```text
OpenCLI / arXiv → PDF → 本地 MinerU → Archive → Obsidian Evidence
```

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun src/cli.ts
```

启动后选择方向库；直接执行任务必须明确传入 `--library fsd`。详细操作见[使用手册](backend/projects/paper-knowledge-engine/使用手册.md)。

| 位置 | 职责 |
| --- | --- |
| `backend/projects/paper-knowledge-engine` | 活动项目代码、配置、测试和文档 |
| `data/paper-libraries/fsd` | FSD 状态与解析归档，不纳入 Git |
| `backups/paper-libraries/fsd` | 可恢复备份，不纳入 Git |
| `D:\paper\paper-knowledge-engine\fsd` | FSD 原始 PDF |
| `D:\obsidian\data\paper-knowledge-engine\fsd` | FSD Obsidian 内容 |
| `tools/MinerU` | 本机 MinerU 环境与模型，不纳入 Git |
| `backend/projects/flowmate-data` | 尚未实现的项目及历史脚本，不属于论文流程 |

旧 FSD 代码已有历史分支 `codex/fsd-legacy-snapshot-20260905`（`0521fc1`）。旧目录移除记录保留在 Git 中，不再作为日常入口。
