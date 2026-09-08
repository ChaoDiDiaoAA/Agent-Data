# 本机工具部署

共享工具部署放在本目录，工具环境和模型不纳入本仓库；本文件仅记录入口。

| 工具 | 位置 | 配置入口 |
| --- | --- | --- |
| MinerU | `D:\agent-data\tools\MinerU` | `backend/projects/paper-knowledge-engine/config/machine.local.yaml` 与同目录的 `engine.yaml` |

MinerU 运行时模型配置文件为 `D:\agent-data\config\mineru.runtime.json`，不提交到 Git。使用方式及进程恢复操作以[论文知识引擎使用手册](../backend/projects/paper-knowledge-engine/使用手册.md)为准。

不要修改上游 MinerU README，不要通过删除锁或运行工件绕过进程安全检查。本次仓库清理不升级工具、不下载模型、不启动解析。
