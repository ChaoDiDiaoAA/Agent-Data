# 项目程序

每个项目把源码、配置、脚本与测试放在本目录；运行资料放在 `D:\agent-data\data\<项目名>`，不得混用。

| 项目 | 程序 | 资料 | 当前状态 |
| --- | --- | --- | --- |
| [datawatch-data](datawatch-data/README.md) | `backend/projects/datawatch-data` | `D:\agent-data\data\datawatch-data`；原件 `D:\paper\DataWatch`；Obsidian `D:\obsidian\data\datawatch-data`；备份 `D:\agent-data\backups\datawatch-data` | 四个公开 Hugging Face 数据集的获取、校验、Obsidian 发布与备份；每个数据集只保留最新快照，完整 SHA 位于清单和 versions.json；[使用说明](datawatch-data/使用说明.md)；不使用 MinerU。 |
| [paper-knowledge-engine](paper-knowledge-engine/README.md) | `backend/projects/paper-knowledge-engine` | `data/paper-libraries/<libraryId>` | 活动 Bun/TS 确定性 Evidence 流水线；启动先选择方向。 |
| [flowmate-data](flowmate-data/README.md) | `backend/projects/flowmate-data` | `data/flowmate-data` | 尚未实现。 |

不要把 `node_modules`、虚拟环境、模型、PDF、Archive 或 SQLite 提交到项目源码目录。
