# Weekly Evidence task

`run-weekly-task.ts` 从论文知识引擎代码根调用 `bun src/cli.ts --library fsd run-task --mode weekly`。Windows 计划任务身份为 `paper-knowledge-engine-fsd-weekly`。一个成功的周任务仅在 PDF 已存档、MinerU Archive 已通过校验、确定性 Evidence 已发布且 SQLite run 为 `completed` 时结束。

在 `D:\agent-data\backend\projects\paper-knowledge-engine` 中安装、检查或卸载 Windows 任务计划条目：

```text
bun automation/weekly/install-weekly-task.ts
bun automation/weekly/install-weekly-task.ts --action Status
bun automation/weekly/install-weekly-task.ts --action Uninstall
```

任务配置来自 `config/engine.yaml`、`config/machine.local.yaml` 和 `config/fsd/` 下的四个方向配置文件。无人值守入口显式指定 `--library fsd`，不依赖默认方向或交互菜单。更新时保留已有任务身份/设置，不读取或写入 Obsidian `.obsidian`。失败 run 保留恢复证据；Evidence 冲突修复后以同一 run ID 执行 `bun src/cli.ts --library fsd evidence-publish --run-id <run-id>`，无需重新开始周采集。
