# 论文知识引擎源码

唯一产品可执行入口为 `bun src/cli.ts`，启动先选方向库；可加 `--library fsd` 显式选库。当前 paper 任务菜单 `10` 准备或修复 OpenCLI，`11` 切换方向；Research 菜单 `10` 切换方向。直接执行方向命令必须指定 `--library`，无默认 FSD；引擎不生成 LLM 内容。

| 模块 | 职责 |
| --- | --- |
| `cli.ts`、`cli/` | 薄入口、纯 Bun 菜单、帮助、命令路由和进度 |
| `discovery/` | OpenCLI 安装验证、arXiv 发现计划与检查点 |
| `mineru/` | 本地任务级 API、解析、规范化、Archive 产出与清理 |
| `library/` | 任务编排；`selection/`、`sources/`、`operations/`、`schedule/`、`state/` 管理对应能力 |
| `evidence/` | Archive v2 验证、Evidence v3 发布、索引与 Vault 验证 |
| `runtime/` | 子进程、锁、互斥、取消与进程回收 |
| `maintenance/` | 离线迁移、Vault 重建、对账与历史维护 |
| `shared/`、`types/` | 三层配置、方向身份、路径、清单和公共契约 |

依赖从 CLI 指向业务能力；业务模块不导入 CLI 表现代码。进程监督器由 CLI 内部路由调用，导入模块不执行进程操作。

## 数据与配置边界

配置入口 `shared/engine-context.ts` 加载 `config/engine.yaml`、`config/machine.local.yaml` 和方向配置。paper 方向从 `config/<libraryId>/` 加载 `library.yaml`、`query-matrix.yaml`、`paper-policy.yaml`、`categories.yaml`；Research 方向使用其独立的四文件契约。当前 paper 方向包括 `fsd`、`agent-engineering`、`multi-agent-engineering`、`llm-post-training`、`agent-tool`、`agent-context`、`skill-prompt-engineering` 和 `agent-memory`。完整配置文件集合由 `shared/config-files.ts` 定义，操作策略快照绑定所选方向的四个文件。所选 `libraryId` 从 CLI 传到操作和状态层。

所有 paper 方向共用发现检查点、选篇、PDF 下载、任务级 MinerU 会话、Archive v2 和 Evidence v3 实现。Multi-Agent、Agent Tool、Agent Context、Agent Memory 和 Skill & Prompt 的领域差异位于方向 YAML 中：`library/selection/paper-policy.ts` 从标题和摘要匹配配置词表；Agent Tool 的后训练方向要求工具能力词与训练主题查询同时命中，Agent Context 的后训练方向要求上下文主题与后训练证据同时出现，Agent Memory 的后训练方向要求记忆主题与语言模型对象证据同时出现，Skill & Prompt 的 `pe-*` 与 `se-*` 分别约束 Prompt 和 Skill 证据，`se-rsi` 要求明确改进对象和迭代词。扩展这些方向应通过配置及共享接口完成。

当前 Archive 路径为 `archive/<baseId>-v<version>/`，与 Vault 的 `Evidence/papers/<baseId>-v<version>/` 分别维护。修改归档路径必须同步检查写入、任务清单、发布读取、对账、迁移目标和 Vault 重建；历史输入格式不随当前目标变化。

代码目标根为 `D:/agent-data/backend/projects/paper-knowledge-engine`。方向运行根 `D:/agent-data/data/paper-libraries/<libraryId>` 直接包含 `library.sqlite`、`archive/`、`runs/`、`operations/`、`work/`；快照位于 `D:/agent-data/backups/paper-libraries/<libraryId>`。目录按需创建；路径配置不会恢复用户已删除的数据。

PDF 原件下载到 `D:/paper/paper-knowledge-engine/<libraryId>/<分类>/` 并长期保留。正常发布只使用通过验证的 Archive v2，并只拥有 `D:/obsidian/data/paper-knowledge-engine/<libraryId>/Evidence`。每篇版本发布 `paper.md`、`pages.md`、`source.pdf` 和 `assets/`；四个索引为聚合 Markdown。回执保存在运行区，人工文件和 `.obsidian/` 位于发布边界之外。

解析和发布分开恢复：`evidence-publish --run-id RUN_ID` 从已验证 Archive 继续发布。迁移与重建使用 dry-run 清单 SHA-256 绑定 apply，不通过普通任务隐式迁移。

## 历史兼容扫描例外

`shared/historical-compatibility.ts` 集中保存旧项目身份、原始迁移源路径和旧版 Evidence 标识，用于历史清单验证与离线迁移。此文件是活动旧名称扫描的唯一源码例外；历史测试仍验证原路径和原始投影字节。不要修改这些常量来掩盖迁移输入。

```text
bun src/cli.ts --help
bun run typecheck
bun test --timeout 30000
```
