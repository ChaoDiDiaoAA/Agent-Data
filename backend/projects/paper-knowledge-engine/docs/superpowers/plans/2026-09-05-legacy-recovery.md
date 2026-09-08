# 旧根可恢复归档与恢复说明

用户已确认：旧代码先保存 Git，四个旧根采用可恢复归档并清空原位置。本文件是归档后的恢复说明；实际执行状态以同目录 `2026-09-05-real-migration-progress.md` 和外部 `retire-journal.jsonl` 为准。

## 保留内容

| 原位置 | 归档子目录 |
|---|---|
| `D:/agent-data/backend/projects/fsd-code2doc` | `code` |
| `D:/agent-data/data/fsd-code2doc` | `data` |
| `D:/paper/fsd-code2doc` | `pdf` |
| `D:/obsidian/data/fsd-code2doc` | `vault` |

归档根：`D:/agent-data/backups/paper-libraries/fsd/retired-legacy-20260905`。

- 完整保留 57,973 个普通文件、474,704,511 字节及 602 个链接，包括忽略文件、旧依赖、历史诊断和两套旧 Obsidian 设置。
- 链接仅原样保留，未遍历其目标。一些旧测试链接采用绝对路径，归档中可能暂时悬空；移回原位置后恢复原寻址关系。不要递归跟随这些链接复制或清理。
- 这次归档精简的是日常目录，不释放磁盘容量。永久销毁必须另行确认。

外部逐文件清单和移动日志：`D:/agent-data/backups/paper-libraries/fsd/migration-plans/20260905-165920/retire-plan.json`、`retire-journal.jsonl`。计划 SHA-256：`ed388e2ab74a7cb0c739e6d501995697705f1b8de6523c27b1ce2ba8186a10b9`。

## 只恢复旧代码

Git 分支：`codex/fsd-legacy-snapshot-20260905`；提交：`0521fc1f7cb5c5abb4ebcc910cbc1c0ce4345c99`。

它保存旧代码目录当时的非忽略工作内容，包括未提交修改和新增文件。原工作树 HEAD 和 index 没有被这个快照操作改动。需要忽略文件或独立设置时，从上述完整归档取回，不要认为 Git 已保存这些内容。

优先在新的空目录中检出该分支查看，不要对当前脏工作树执行 `reset --hard` 或覆盖式检出。

## 恢复整套旧目录

1. 停止匹配本项目的 CLI、MinerU、OpenCLI 和定时任务，确认没有旧根/新根写入者；不要停止其他项目进程。
2. 按清单核对归档文件哈希、链接目标和四个根的目录身份。确认原位置全部为空且祖先目录不含链接。
3. 将上表四个明确的归档子目录逐个同卷重命名回对应原位置。若任何原位置已被重新创建，停止，不覆盖、不合并、不删除。
4. 新库 `D:/agent-data/data/paper-libraries/fsd` 和 `D:/paper/fsd` 不在回移范围。它们含迁移后新增论文；不要用旧数据库覆盖新数据库。
5. 如需真正切回旧程序，应另行核对历史代码兼容性、入口和调度；恢复目录本身不等于允许旧自动化重新运行。

另有独立的迁移前验证快照 `D:/agent-data/backups/paper-libraries/fsd/20260905-164501`，不受四根归档影响。

旧 Windows 周任务 `agent-data-fsd-code2doc-weekly` 已停用、未删除；其 XML 备份位于上述计划目录的 `legacy-windows-task.xml`。原来每三周周一 22:30 的触发器和 PowerShell 入口均完整保留。不要在旧目录尚未恢复或未决定切回旧程序时重新启用。此前用户明确批准删除的 Codex 自动化 `ai` 与它是两个不同的调度对象。
