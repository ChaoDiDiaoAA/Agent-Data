# FSD 方向库自动化

自动化复用论文知识引擎的纯 Bun CLI 与三层 YAML 配置，不建立第二套采集、解析或发布逻辑。当前只有 Windows 周任务，见 [weekly/README.md](weekly/README.md)。

代码根为 `D:\agent-data\backend\projects\paper-knowledge-engine`，FSD 方向库必须显式选择：

```text
bun src/cli.ts --library fsd run-task --mode weekly
```

配置依次来自 `config/engine.yaml`、`config/machine.local.yaml` 和 `config/libraries/fsd.yaml`。计划任务身份为 `paper-knowledge-engine-fsd-weekly`。

周任务成功的定义是 Archive 已验证且 Evidence 已发布、对应 run 已 `completed`。它不启动 Web，不调用 LLM，也没有额外的生成完成条件。调度安装、状态和删除均通过 Bun 脚本显式执行，不使用 PowerShell 菜单外壳。
