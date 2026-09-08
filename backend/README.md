# backend

`backend/projects/` 保存各项目的版本化程序。当前活动项目为 Paper Knowledge Engine，FSD 是其中一个方向，使用 Bun/TypeScript 的确定性 CLI 流程；不调用 LLM。

| 目录 | 说明 |
| --- | --- |
| [`projects/paper-knowledge-engine`](projects/paper-knowledge-engine/README.md) | arXiv 检索、PDF 下载、本地 MinerU 解析、Archive 校验和 Obsidian Evidence 发布。 |
| [`projects/flowmate-data`](projects/flowmate-data/README.md) | 未实现项目；不属于 FSD 流程。 |

运行状态不写入代码目录。论文方向状态位于 `D:\agent-data\data\paper-libraries\<libraryId>`，以项目配置为准。
