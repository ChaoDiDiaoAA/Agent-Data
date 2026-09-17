# backend

`backend/projects/` 保存各项目的版本化程序。当前活动项目包括 Paper Knowledge Engine 和 DataWatch；两者使用 Bun/TypeScript 的确定性 CLI 流程，DataWatch 不调用 LLM 或 MinerU。

| 目录 | 说明 |
| --- | --- |
| [projects/datawatch-data](projects/datawatch-data/README.md) | 获取四个公开 Hugging Face 数据集，保留 CSV、Parquet 和图谱原始文件，支持校验、恢复、Obsidian 和备份；[使用说明](projects/datawatch-data/使用说明.md)；每个数据集只保留最新快照，完整 SHA 记录在清单与 versions.json；原件 D:\paper\DataWatch，状态 D:\agent-data\data\datawatch-data，Obsidian D:\obsidian\data\datawatch-data，备份 D:\agent-data\backups\datawatch-data；不使用 MinerU。 |
| [`projects/paper-knowledge-engine`](projects/paper-knowledge-engine/README.md) | arXiv 检索、PDF 下载、本地 MinerU 解析、Archive 校验和 Obsidian Evidence 发布。 |
| [`projects/flowmate-data`](projects/flowmate-data/README.md) | 未实现项目；不属于 FSD 流程。 |

运行状态不写入代码目录。论文方向状态位于 `D:\agent-data\data\paper-libraries\<libraryId>`，以项目配置为准。
