# LLM Post-Training 操作说明

本说明只适用于 `LLM Post-Training（大模型后训练知识库）`，稳定标识为 `llm-post-training`。所有命令都从仓库根 `D:\agent-data\backend\projects\paper-knowledge-engine` 执行，并显式携带 `--library llm-post-training`。不要调用 `package.json` 中省略 `--library` 的快捷脚本。

## 配置与隔离边界

本库是 `library_kind: paper`，自动来源仅为 OpenCLI/arXiv。18 个 Track 各查询 submitted 和 updated 日期，共 36 个检索分片。Current 总上限为 180，18 个 Track 各配置 10 作为共享选篇器的初始分配目标；某些 Track 未用完的名额可以外溢给其他符合规则的候选，因此 10 不是每类硬上限。Weekly 总上限为 18，使用本库成功水位和 48 小时重叠窗口。

机器根与稳定标识共同派生以下路径：

```text
运行数据：D:\agent-data\data\paper-libraries\llm-post-training
备份目标：D:\agent-data\backups\paper-libraries\llm-post-training
PDF 原件：D:\paper\paper-knowledge-engine\llm-post-training
Vault：   D:\obsidian\data\paper-knowledge-engine\llm-post-training
```

SQLite、Archive、runs、operations、selection manifest、水位、锁、PDF、Vault 和发布回执均与其他方向库隔离。Evidence 发布器只管理 `Evidence/`，不会创建或覆盖人工 `Knowledge/`。

## 首期查看与运行顺序

先查看确定性的检索计划和 MinerU 配置：

```powershell
bun src/cli.ts --library llm-post-training harvest-plan --mode current --format json
bun src/cli.ts --library llm-post-training mineru-config --format json
```

`harvest-plan` 应显示 18 个 Track、36 个分片和 Current 180。`mineru-config` 用来核对 MinerU 版本、模型、设备、Archive 输出根和本库模型锁路径；它不会启动 MinerU 或下载模型。

随后可做 arXiv 网络探针：

```powershell
bun src/cli.ts --library llm-post-training arxiv-check --format json
```

该命令会实际访问配置的 arXiv API 路由，但不创建论文任务或写入收录状态。只有探针可达后才进入真实试运行。

首期 5 篇试运行使用：

```powershell
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
```

`--limit 5` 只限制最终选篇、下载和解析规模。发现阶段仍按 36 个分片各自的查询预算检索，以免小批量试运行改变检索覆盖。试运行完成后，省略 `--limit` 再启动一个新的 current，才会使用默认总上限 180；不得修改已完成或已冻结 run 的 selection manifest。

手动增量使用：

```powershell
bun src/cli.ts --library llm-post-training run-task --mode weekly --format json
```

`weekly` 不接受 `--limit`，其规模由方向配置的 Weekly 18 控制。`run-task` 没有本计划使用的 `--resume` 参数。任务未完成时，以相同 library、mode、日期覆盖和限额重复原命令，程序会根据检查点恢复；selection 一旦冻结，恢复继续使用原选篇和原限额，不会因后来修改命令而扩容。

首期不注册 Windows 或 Codex scheduler。`weekly_schedule.enabled: true` 只保留手动 weekly 入口；没有为 `paper-knowledge-engine-llm-post-training-weekly` 注册计划任务，才是本期自动调度关闭的依据。不要调用默认仍按 FSD 装载配置的 `automation/weekly/install-weekly-task.ts`。

## 发布恢复与只读对账

解析完成但 Evidence 发布中断时，从该库真实运行输出或 `runs/` 记录取得 runId，再执行：

```powershell
bun src/cli.ts --library llm-post-training evidence-publish --run-id REAL_RUN_ID
```

`REAL_RUN_ID` 必须来自实际输出或本库运行记录；不要虚构 ID，也不要使用其他方向库的 runId。只读对账使用不带任何修复选项的命令：

```powershell
bun src/cli.ts --library llm-post-training reconcile
```

## 历史 PDF 的人工导入

[基础论文候选清单](foundational-papers.md) 是人工 provenance 记录，不是自动发现结果。导入前为每个已人工选定的 PDF 分别执行预览，确认解析后的绝对路径、文件列表，以及返回的模型、目标输出根和本地导入策略：

```powershell
bun src/cli.ts --library llm-post-training import-local --path D:\absolute\path\selected-paper.pdf --preview
```

`--preview` 只扫描和列出候选文件，不读取 PDF 来检查页数、文件大小或 SHA-256。确认文件列表与目标配置后，仍按单文件绝对路径正式导入；正式导入阶段才会执行页数上限、大小上限、PDF 内容有效性和内容哈希检查：

```powershell
bun src/cli.ts --library llm-post-training import-local --path D:\absolute\path\selected-paper.pdf
```

不要直接把整个历史资料文件夹交给 `--path`，以免未选论文进入系统。真实绝对路径应在候选清单的人工导入记录中逐文件补充；文档中的路径只是占位示例。

本地导入以 PDF 内容哈希生成 `local-...` 身份，并使用共享默认 Track `Local-PDF`。它不会自动恢复完整 arXiv 元数据，不会自动归入本库 18 个主题，也不会推进或伪装 arXiv 自动发现水位。原始 URL、arXiv ID、拟选版本、真实提交/更新时间与生成的 `local-*` 身份之间的对应关系只能作为人工 provenance 保存在候选清单中；不要伪造数据库字段，也不要修改全局 `Local-PDF` 默认值来模拟主题分类。

## 可复现验证

文档和方向契约的定向验证在隔离临时根中运行，不会修改生产 SQLite、Archive、PDF 或 Vault：

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts tests/research-fsd-isolation.test.ts
bun run typecheck
```

纯文档核对不需要执行 `run-task`、scheduler installer、PDF 导入或模型训练。
