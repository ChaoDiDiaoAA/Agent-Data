# Paper Knowledge Engine

论文知识引擎是基于 Bun 1.4 / TypeScript 的确定性资料库工具，当前包含四个业务数据与任务状态隔离的 paper 方向库：**FSD（fsd）**、**Agent Engineering（agent-engineering）**、**Multi-Agent Engineering（multi-agent-engineering）** 和 **LLM Post-Training（大模型后训练知识库，llm-post-training）**。它们复用引擎，并共享机器级 arXiv 请求节流与 MinerU 资源锁。

```text
FSD：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Agent Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Multi-Agent Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
LLM Post-Training：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
```

本阶段建设可追溯的 L2 资料库，保留 MinerU Markdown、页级文本、来源 PDF 和资源，不调用 LLM。L3 人工知识层在 L2 稳定后实施。

## 纯 Bun 入口

在 PowerShell 中进入项目并启动：

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun src/cli.ts
```

启动后先选择方向库，不会自动进入默认方向：

```text
论文知识引擎（Bun CLI）
请选择方向库：
1. FSD 论文知识库
2. Agent Engineering
3. Multi-Agent Engineering
4. LLM Post-Training（大模型后训练知识库）
0. 退出
```

也可显式选择 FSD，跳过选库步骤：

```text
bun src/cli.ts --library fsd
```

Agent Engineering 与 FSD 使用同一套论文工作流，只隔离方向配置、状态、PDF 和 Vault：

```powershell
bun src/cli.ts --library agent-engineering harvest-plan --mode current --format json
bun src/cli.ts --library agent-engineering mineru-config --format json
bun src/cli.ts --library agent-engineering arxiv-check --format json
bun src/cli.ts --library agent-engineering schedule-config --format json
bun src/cli.ts --library agent-engineering run-task --mode current
bun src/cli.ts --library agent-engineering run-task --mode weekly
bun src/cli.ts --library agent-engineering import-local --path D:\papers\agent
bun src/cli.ts --library agent-engineering parse-local --base-id BASE_ID
bun src/cli.ts --library agent-engineering evidence-publish --run-id RUN_ID
bun src/cli.ts --library agent-engineering reconcile
bun src/cli.ts --library agent-engineering opencli-prepare
```

Multi-Agent Engineering 同样复用论文工作流，但隔离方向配置、状态、PDF 和 Vault：

```powershell
bun src/cli.ts --library multi-agent-engineering harvest-plan --mode current --format json
bun src/cli.ts --library multi-agent-engineering mineru-config --format json
bun src/cli.ts --library multi-agent-engineering arxiv-check --format json
bun src/cli.ts --library multi-agent-engineering schedule-config --format json
bun src/cli.ts --library multi-agent-engineering run-task --mode current
bun src/cli.ts --library multi-agent-engineering run-task --mode weekly
bun src/cli.ts --library multi-agent-engineering import-local --path D:\papers\multi-agent
bun src/cli.ts --library multi-agent-engineering parse-local --base-id BASE_ID
bun src/cli.ts --library multi-agent-engineering evidence-publish --run-id RUN_ID
bun src/cli.ts --library multi-agent-engineering reconcile
bun src/cli.ts --library multi-agent-engineering opencli-prepare
```

论文任务的计数单位是去重后的论文身份/版本：`candidates`（候选）、`accepted`（接受）、`newVersions`（新版本）、`archived`（Archive）、`published`（Evidence）。同一论文命中多个 Track 只计一次。

Agent Engineering 的在线发现和自动任务来源只有 arXiv 论文；不从官方文档、规范、仓库或 Release 进行发现。`import-local` / `parse-local` 是与 FSD 复用的显式本地 PDF 入口，只处理用户主动指定的文件，不会加入 arXiv 发现、Track 候选统计或自动任务来源。

Multi-Agent Engineering 的自动获取同样仅通过 OpenCLI/arXiv；显式本地 PDF 导入是唯一的非-arXiv 摄入路径，不会加入 arXiv 水位、Track 候选统计或自动任务来源。

LLM Post-Training 的稳定标识为 `llm-post-training`，自动来源同样仅为 OpenCLI/arXiv。常用只读检查与首期小批量命令如下；完整的恢复、发布和历史 PDF 导入边界见 [后训练库操作说明](docs/llm-post-training/operations.md)，经原始来源核对的历史阅读入口见 [基础论文候选](docs/llm-post-training/foundational-papers.md)。

```powershell
bun src/cli.ts --library llm-post-training harvest-plan --mode current --format json
bun src/cli.ts --library llm-post-training mineru-config --format json
bun src/cli.ts --library llm-post-training arxiv-check --format json
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
bun src/cli.ts --library llm-post-training run-task --mode weekly --format json
bun src/cli.ts --library llm-post-training reconcile
```

选定方向后进入内置任务菜单，前三行是：

```text
论文知识引擎（Bun CLI）
当前方向库：FSD 论文知识库（fsd）
=========================
```

菜单按方向类型显示不同操作；方向列表自动读取 `config/<libraryId>/library.yaml`，FSD、Agent Engineering、Multi-Agent Engineering 和 LLM Post-Training 都是 paper 库，都显示同一组 MinerU、PDF、Evidence 操作。paper 库菜单还包含 arXiv 网络检查、OpenCLI 准备/修复和方向切换；不会出现 Research 专用的 Backfill 或来源导入菜单。新增 paper 库配齐论文四文件，research 库配齐 research 四文件。直接执行方向命令必须提供 `--library`，不会默认使用 FSD；例如：

```text
bun src/cli.ts --library fsd run-task --mode current
bun src/cli.ts --library fsd run-task --mode weekly
bun src/cli.ts --library fsd evidence-publish --run-id RUN_ID
bun src/cli.ts --library fsd reconcile
bun src/cli.ts --help
```

当前任务从方向配置的 `start_date` 开始；周任务按成功水位增量运行。恢复失败任务会复用已固定选篇。每次解析操作共享一个任务级本地 MinerU API，操作结束后回收。

## 配置：共用引擎，方向独立

```text
D:\agent-data\backend\projects\paper-knowledge-engine\config\
├─ engine.yaml                共用运行参数
├─ machine.local.yaml         本机路径、代理、设备
├─ README.md                  配置字段说明
├─ fsd\
│  ├─ library.yaml            身份、日期、配额、调度
│  ├─ query-matrix.yaml       检索方向和查询条件
│  ├─ paper-policy.yaml       纳入、排除、分类优先级
│  └─ categories.yaml         PDF 分类目录映射
├─ agent-engineering\
│  ├─ library.yaml            论文库身份、日期、配额、调度
│  ├─ query-matrix.yaml       15 个 Agent Engineering Track 的 arXiv 查询
│  ├─ paper-policy.yaml       论文纳入、排除和 Track 优先级
│  └─ categories.yaml         PDF 分类目录映射
├─ multi-agent-engineering\
│  ├─ library.yaml            论文库身份、日期、配额、调度
│  ├─ query-matrix.yaml       18 个 Multi-Agent Engineering Track 的 arXiv 查询
│  ├─ paper-policy.yaml       论文纳入、排除和 Track 优先级
│  └─ categories.yaml         PDF 分类目录映射
└─ llm-post-training\
   ├─ library.yaml            LLM Post-Training 身份、日期、配额、调度
   ├─ query-matrix.yaml       18 个后训练 Track 的 arXiv 查询
   ├─ paper-policy.yaml       后训练论文纳入、排除和 Track 优先级
   └─ categories.yaml         18 个 Track 的 PDF 分类目录映射
```

| 配置 | 职责 |
| --- | --- |
| `config/engine.yaml` | 共享的 arXiv、MinerU、运行时和 Evidence 发布参数 |
| `config/machine.local.yaml` | 本机根路径、可选网络代理、MinerU 安装、模型和设备 |
| `config/fsd/` | `library.yaml` 管日期/配额/调度，`query-matrix.yaml` 管检索，`paper-policy.yaml` 管筛选，`categories.yaml` 管分类 |
| `config/agent-engineering/` | Agent Engineering 的 arXiv Track、论文筛选和 PDF 分类；不读取 FSD 的方向级状态 |
| `config/multi-agent-engineering/` | Multi-Agent Engineering 的 arXiv Track、论文筛选和 PDF 分类；不读取其他方向的方向级状态 |
| `config/llm-post-training/` | LLM Post-Training 的 18 Track 检索、筛选和 PDF 分类；稳定标识为 `llm-post-training`，不读取其他方向的状态 |

新增方向时，在 `config/<libraryId>/` 下提供与 `library_kind` 对应的配置文件，并将 `library.yaml` 中的 `library_id` 与目录名保持一致，再通过 `--library <libraryId>` 选择。引擎代码无需复制；数据、PDF 和 Vault 路径按所选方向分别派生。旧配置仅保留在 `tests/fixtures/legacy-config/`，不参与正常运行。

生产 arXiv 请求间隔为 10 秒。FSD、Agent Engineering、Multi-Agent Engineering 等 paper 方向共享 `data_libraries_root/.arxiv/` 下的机器级请求锁：请求串行、429 冷却共享；各方向的数据库、PDF、Archive、Evidence 和 Vault 仍完全隔离。OpenCLI 适配器源码变更后运行 `bun run opencli:prepare` 重建。

连续 HTTP 429 的共享冷却按基础值的 1、2、4 倍递增并封顶：当前配置为 15、30、60 分钟；若响应的 `Retry-After` 秒数更长，则遵守更长的等待时间。成功的 HTTP 请求清零连续限流记录，网络失败不清零。冷却期间其他论文任务立即返回恢复时间，不再静默等待或发送请求；重复启动不会延长已有截止时间。旧版冷却时间戳继续有效，状态损坏会阻止请求而不是忽略冷却。

冷却截止时间是**最早可尝试时间，不是上游恢复承诺**。当前没有后台自动恢复：到期后重新运行同一方向库、同一模式的任务，并保持配置与限额不变，继续使用检查点。不要删除冷却状态、反复切换方向库或高频运行网络探针来重试。初次全量任务成功后，日常更新优先使用已有的 `weekly` 增量入口，避免反复从年初扫描。共享门控目前覆盖正式论文任务的发现请求，不覆盖独立网络探针或其他外部程序。

### FSD 当前检索范围

启用 **8 个检索方向**，每个方向分别查询首次提交（submitted）和更新（updated）日期，共 **16 个检索分片**。

| 方向 | 内容 |
| --- | --- |
| AI-FSD | 功能规格、需求恢复 |
| LLM-Wiki | 代码仓库文档、Wiki |
| AI-TDD | 测试生成、修复 |
| AI-DDD | 领域模型、业务规则 |
| AI-Program-Analysis-AST | 程序分析、AST |
| Code-Translation | 代码翻译、迁移 |
| Verification | 语义等价、行为保持 |
| Evaluation | 评测、基准 |

`categories.yaml` 定义 **12 个分类目录**及 `99-Unclassified` 兜底目录，不表示有 12 个独立检索任务。Legacy-Modernization、Architecture、Data-API、Agent-Skill 目前只有分类映射，没有独立检索任务。LLM-Wiki 是论文研究主题，不代表本工具调用 LLM。

### Agent Engineering 当前检索范围与边界

Agent Engineering 从 `2026-01-01` 开始检索和保存 Agent 应用工程资料，固定覆盖以下 **15 个 Track**：

| Track | 覆盖重点 |
| --- | --- |
| `harness-control-loop` | Harness、编排边界、执行控制面 |
| `agent-loop` | 规划、行动、观察、终止、重试和迭代预算 |
| `runtime-execution` | Agent runtime、执行器、session 运行时和生命周期 |
| `tool-mcp` | Tool contract、工具调用、MCP、发现和协议边界 |
| `context-prompt` | Context engineering、prompt、上下文窗口和压缩 |
| `memory-state-session` | Memory、状态、会话、持久化和恢复 |
| `guardrails-policy` | Guardrails、策略、输入输出约束和安全边界 |
| `permissions-authorization` | 权限、授权、能力、资源范围、审批和审计 |
| `identity-tenancy-governance` | 多用户、身份、租户、组织、团队、角色、可见性和配额 |
| `hitl-approval` | Human-in-the-loop、人工介入、审批和升级 |
| `sandbox-isolation` | Sandbox、隔离、文件系统、网络和进程边界 |
| `testing-evaluation` | Agent 测试、回放、回归、可靠性和测试层级 |
| `agent-evaluation-methodology` | Agent 评测对象、协议、指标、判定器、人工/模型评审和红队方法 |
| `tracing-observability` | Tracing、日志、指标、事件和可观测性 |
| `reliability-operations` | 超时、重试、幂等、恢复、容量和运维 |

Agent Engineering 的 15 个 Track 全部通过 OpenCLI 查询 arXiv，`query-matrix.yaml` 为每个 Track 声明 `categories` 和 `date_modes: [submitted, updated]`。官方文档、规范、仓库、Release 和本地资料不参与自动发现；用户显式指定的本地 PDF 仍可通过 `import-local` / `parse-local` 处理。其他资料类型待未来需要时另建 Research 方向库。

### Multi-Agent Engineering 当前检索范围与边界

Multi-Agent Engineering 从 `2026-01-01` 开始检索，固定覆盖 18 个 Track；每个 Track 分别查询 submitted 与 updated，共 36 个分片。自动发现只通过 OpenCLI/arXiv；`import-local` / `parse-local` 仅处理用户显式提供的本地 PDF，是唯一非-arXiv 摄入路径。

`current` 总上限为 180 篇，各 Track 配额为 10；`weekly` 总上限为 18 篇，按本方向成功水位回溯 48 小时。配额通过共用选篇器执行，去重后计数。调度描述当前以 `2026-08-31` 为锚点，每 4 周的周一 22:30（Asia/Shanghai）运行一次；`weekly` 是增量任务模式名，实际周期以 `schedule-config` 输出为准。

本方向研究多个具有独立 Context、State 或决策边界的 Agent，以及它们之间的委派、通信、共享状态和协调。自动硬筛选从标题与摘要匹配明确的多 Agent 或 Agent 间关系词（如 `multi-agent`、`multiple agents`、`agent-to-agent`），同时要求工程任务词、有效 arXiv 身份与日期，以及已启用的 Track。仅有单 Agent 工具调用、`shared memory` 或普通并行程序术语不足以通过筛选；Track 标签本身也不能替代来源文本证据。该筛选是确定性词法规则，未显式表述多 Agent 的相关论文可能被漏选。

| Track | 覆盖重点 |
| --- | --- |
| `mas-foundations` | 定义、边界、基本假设、系统类型和问题建模 |
| `mas-topology` | Hierarchy、Supervisor-Worker、Pipeline、Swarm、P2P、Blackboard、Graph |
| `mas-roles-capabilities` | 角色、能力、身份、专业化、能力发现和动态分配 |
| `mas-lifecycle-composition` | Agent 创建、销毁、休眠、唤醒和运行时组合 |
| `mas-task-decomposition` | 子任务建模、依赖、分派和路由 |
| `mas-delegation-handoff` | 委派、交接、契约、预算、取消和失败语义 |
| `mas-planning-scheduling` | 联合规划、调度、并行执行、资源竞争和关键路径 |
| `mas-communication` | 消息、事件、Schema、通道和同步/异步协议 |
| `mas-shared-state-memory` | 共享/私有状态、Memory、所有权、一致性和冲突解决 |
| `mas-coordination-consensus` | 同步、屏障、锁、投票、共识和全局计划 |
| `mas-conflict-negotiation` | 冲突、竞争、谈判、辩论、激励、对抗和利益对齐 |
| `mas-synthesis-verification` | 聚合、交叉审查、Critic/Verifier、裁决和证据合并 |
| `mas-security-governance` | 身份、信任、权限、隔离、泄露和 Agent 间 Prompt Injection |
| `mas-fault-tolerance` | 超时、重试、取消、幂等、部分失败、级联故障和恢复 |
| `mas-resource-governance` | Token、Tool、并发、配额、预算、成本、负载和公平性 |
| `mas-observability` | 跨 Agent Trace、因果关系、快照、审计、调试和 Replay |
| `mas-human-oversight` | 人工升级、裁决、接管、审批和恢复 |
| `mas-evaluation-methodology` | 协作质量、通信成本、一致性、故障传播、恢复、安全和效率评测 |

### LLM Post-Training 当前检索范围与边界

`LLM Post-Training（大模型后训练知识库）` 的稳定标识为 `llm-post-training`，从 `2026-01-01` 开始检索。18 个 Track 为：`pt-foundations`、`pt-sft`、`pt-data-curation`、`pt-synthetic-data`、`pt-reward-modeling`、`pt-preference-optimization`、`pt-policy-optimization`、`pt-verifiable-rewards`、`pt-reasoning`、`pt-distillation`、`pt-tool-agent`、`pt-multimodal`、`pt-safety-alignment`、`pt-adaptation`、`pt-efficient-tuning`、`pt-training-systems`、`pt-stability`、`pt-evaluation`。每个 Track 同时查询 submitted 与 updated，共 36 个分片。

`current` 总上限为 180，每个 Track 的 10 是共享选篇器的初始分配目标，空额允许外溢，并非每类硬上限；`weekly` 总上限为 18，使用本库成功水位和 48 小时重叠窗口。自动来源仅为 OpenCLI/arXiv。本地 PDF 只能通过显式 `import-local` / `parse-local` 进入，且不会恢复完整 arXiv 元数据、自动归入上述 18 个 Track 或推进自动发现水位。

FSD、Agent Engineering、Multi-Agent Engineering 与 LLM Post-Training 的论文任务都按以下顺序运行：`discovery → 去重/硬筛选 → selection 冻结 → PDF → MinerU → Archive v2 → Evidence/papers/（v3）`。新 `current` 从各方向的 `start_date` 起扫描，`weekly` 使用各自方向库的成功水位和重叠窗口；失败恢复沿用已冻结的任务。论文 v1/v2 作为不同版本保存，同一论文命中多个 Track 不重复计数。

论文 Archive 和 Evidence 布局如下；`Knowledge/` 始终由人工拥有，自动发布器不会创建或覆盖它：

```text
Archive：
.../<library-id>/archive/<base-id>-v<version>/

Obsidian：
.../<library-id>/Evidence/papers/<base-id>-v<version>/
.../<library-id>/Evidence/indexes/{authors,categories,tracks,years}.md
```

## 数据保存位置

| 根路径 | 内容 |
| --- | --- |
| `D:/agent-data/backend/projects/paper-knowledge-engine` | 共享引擎代码 |
| `D:/agent-data/data/paper-libraries/fsd` | `library.sqlite`、`archive/`、`runs/`、`operations/`、`work/` |
| `D:/agent-data/backups/paper-libraries/fsd` | 备份目标根；执行相应备份操作后才产生内容 |
| `D:/paper/paper-knowledge-engine/fsd` | 下载的原始 PDF，按分类长期保留 |
| `D:/obsidian/data/paper-knowledge-engine/fsd` | FSD 方向 Obsidian Vault；发布器仅拥有 `Evidence/` |
| `D:/agent-data/data/paper-libraries/agent-engineering` | Agent Engineering 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/agent-engineering` | Agent Engineering 的备份目标根；执行相应备份操作后才产生内容 |
| `D:/paper/paper-knowledge-engine/agent-engineering` | Agent Engineering 下载的 arXiv PDF，按 Agent 分类长期保留 |
| `D:/obsidian/data/paper-knowledge-engine/agent-engineering` | Agent Engineering Vault；论文 publisher 仅拥有 `Evidence/papers/` 和论文索引 |
| `D:/agent-data/data/paper-libraries/multi-agent-engineering` | Multi-Agent Engineering 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/multi-agent-engineering` | Multi-Agent Engineering 的备份目标根 |
| `D:/paper/paper-knowledge-engine/multi-agent-engineering` | Multi-Agent Engineering 的 arXiv PDF 和手工导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/multi-agent-engineering` | Multi-Agent Engineering Vault；publisher 只拥有 `Evidence/` |
| `D:/agent-data/data/paper-libraries/llm-post-training` | LLM Post-Training 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/llm-post-training` | LLM Post-Training 的备份目标根 |
| `D:/paper/paper-knowledge-engine/llm-post-training` | LLM Post-Training 的 arXiv PDF 和显式导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/llm-post-training` | LLM Post-Training Vault；publisher 只拥有 `Evidence/`，不创建或覆盖人工 `Knowledge/` |

用户清空旧数据后，以上为重新运行时使用的路径；修改配置不恢复或迁移旧数据。内部 Archive 与 Obsidian 各自保留校验和阅读所需的 PDF 副本，外部下载原件不属于临时清理范围。过去的迁移记录仅作历史证据，不代表数据当前仍存在。在独立工作树验证时，在工作树的项目根执行相同命令，并使用隔离的机器配置。

`Evidence/papers/<baseId>-v<version>/` 只包含 `paper.md`、`pages.md`、`source.pdf` 和 `assets/`；`Evidence/indexes/` 提供作者、类别、Track、年份四个聚合索引。人工笔记放在 `Evidence/` 外。

Multi-Agent Engineering 使用相同的 `Evidence/papers/<baseId>-v<version>/` 布局，以及与 FSD、Agent 共用的 authors、categories、tracks、years 索引。

### 一篇论文的完整路径示例

假设论文编号为 `2609.00001v1`、标题为 `Example Paper`、主分类为 AI-FSD。以下是成功下载、解析、发布后的布局示例，不代表文件已经存在。

```text
下载原件：
D:\paper\paper-knowledge-engine\fsd\01-AI-FSD-Specification\2609.00001v1_Example-Paper.pdf

解析归档：
D:\agent-data\data\paper-libraries\fsd\archive\2609.00001-v1\
├─ source.pdf                 归档 PDF
├─ document.md                MinerU 正文
├─ pages.json                 分页文本
├─ content-list.json          结构化内容
├─ source.json                来源元数据
├─ manifest.json              身份、文件清单与哈希
└─ assets\                    引用资源（有资源时生成）

Obsidian：
D:\obsidian\data\paper-knowledge-engine\fsd\Evidence\papers\2609.00001-v1\
├─ paper.md                   论文信息与 MinerU 正文
├─ pages.md                   分页阅读文本
├─ source.pdf                 Vault 内阅读副本
└─ assets\                    引用资源（有资源时生成）
```

Archive 已去掉 `papers/` 包装层；Obsidian 的 `Evidence/papers/` 保持不变。PDF 下载后按主分类保存，不因命中多个方向而复制到多个分类；Archive 和 Vault 中的 PDF 则分别服务于校验重建和独立阅读。

## 验证

```text
bun install --frozen-lockfile
bun run typecheck
bun test --timeout 30000
```

四库配置、筛选正负例、paper 菜单、MinerU 会话与共享发现检查点的定向验证：

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts tests/research-fsd-isolation.test.ts tests/research-cli.test.ts
```

Multi-Agent 的设计约束见 [设计方案](docs/superpowers/specs/2026-09-06-multi-agent-engineering-design.md)，实施步骤、最终复审和已知测试失败见 [实施与验证记录](docs/superpowers/plans/2026-09-07-multi-agent-engineering-paper-only.md)。

详细操作见 [使用手册](使用手册.md)、[配置说明](config/README.md) 和 [源码结构](src/README.md)。
