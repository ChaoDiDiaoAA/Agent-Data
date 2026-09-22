# Paper Knowledge Engine

论文知识引擎是基于 Bun 1.4 / TypeScript 的确定性资料库工具。当前配置了 8 个业务数据与任务状态相互隔离的 paper 方向库；它们复用同一引擎，并共享机器级 arXiv 请求节流与 MinerU 资源锁。

```text
FSD：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Agent Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Multi-Agent Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
LLM Post-Training：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Agent Tool & RSI：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Agent Memory：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Agent & LLM Context：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Skill & Prompt Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
```

本阶段建设可追溯的 L2 资料库，保留 MinerU Markdown、页级文本、来源 PDF 和资源，不调用 LLM。L3 人工知识层在 L2 稳定后实施。

当前活动配置以各目录的 `config/<library-id>/library.yaml` 为准：

| 方向库 | `library_id` | 起始日期 | Track | Current 上限 | Weekly 上限 | 调度 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| FSD 论文知识库 | `fsd` | 2025-06-01 | 8 | 277 | 20 | 启用，每 4 周 |
| Agent Engineering | `agent-engineering` | 2026-01-01 | 15 | 174 | 15 | 启用，每 4 周 |
| Multi-Agent Engineering | `multi-agent-engineering` | 2025-06-01 | 18 | 540 | 18 | 启用，每 4 周 |
| LLM Post-Training | `llm-post-training` | 2025-06-01 | 18 | 630 | 18 | 启用，每 4 周 |
| Agent Tool & RSI | `agent-tool` | 2026-01-01 | 18 | 450 | 12 | 关闭 |
| Agent & LLM Context | `agent-context` | 2026-01-01 | 18 | 450 | 18 | 启用，每 4 周 |
| Skill & Prompt Engineering | `skill-prompt-engineering` | 2026-01-01 | 19 | 475 | 20 | 关闭 |
| Agent Memory | `agent-memory` | 2026-01-01 | 20 | 500 | 20 | 关闭 |

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
5. Agent Tool & RSI（含 LLM 工具后训练）
6. Agent & LLM Context
7. Skill & Prompt Engineering
8. Agent Memory（智能体记忆知识库）
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
bun src/cli.ts --library agent-engineering evidence-renderer-baseline --dry-run --format json --vault-plan-file VAULT_PLAN_FILE --vault-plan-sha256 VAULT_PLAN_SHA256
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

Agent Tool & RSI 的稳定标识为 `agent-tool`，覆盖工具使用、工具生成、LLM 工具后训练和递归自我改进；自动来源仅为 OpenCLI/arXiv。从 `2026-01-01` 开始，18 个 Track 各 25 篇、Current 总上限 450，Weekly 增量上限 12，默认不安装自动调度。后训练 Track 必须同时有工具能力和训练证据；RSI Track 必须明确改进对象与迭代机制。

```powershell
bun src/cli.ts --library agent-tool harvest-plan --mode current --format json
bun src/cli.ts --library agent-tool schedule-config --format json
bun src/cli.ts --library agent-tool run-task --mode current --limit 5 --format json
bun src/cli.ts --library agent-tool run-task --mode weekly --format json
bun src/cli.ts --library agent-tool reconcile
```

Agent Memory 的稳定标识为 `agent-memory`，覆盖运行时记忆、RSI 记忆和 LLM 后训练记忆。20 个 Track 分别覆盖记忆基础、工作/情景/语义/程序性记忆、写入、组织、检索、巩固、共享、安全、评测，以及记忆 SFT、记忆 RL、记忆蒸馏和参数化记忆。自动来源仅为 OpenCLI/arXiv，从 `2026-01-01` 起检索；Current 总上限为 500，每个 Track 的初始分配为 25，Weekly 上限为 20，默认关闭调度。

完整操作边界见 [Agent Memory 操作说明](docs/agent-memory/operations.md)，历史阅读入口见 [基础论文候选](docs/agent-memory/foundational-papers.md)。

```powershell
bun src/cli.ts --library agent-memory harvest-plan --mode current --format json
bun src/cli.ts --library agent-memory schedule-config --format json
bun src/cli.ts --library agent-memory arxiv-check --format json
bun src/cli.ts --library agent-memory run-task --mode current --limit 5 --format json
bun src/cli.ts --library agent-memory run-task --mode weekly --format json
bun src/cli.ts --library agent-memory reconcile
```

Agent & LLM Context 的稳定标识为 `agent-context`，把 Agent Context、RSI Context 和 LLM 后训练 Context 放在同一个独立论文库中。18 个 Track 覆盖上下文组装、检索、压缩、长任务、记忆、工具上下文、隔离安全、反思/经验/递归演化，以及长上下文后训练、检索 grounding、记忆策略、上下文蒸馏、上下文数据和上下文评测。自动来源仅为 OpenCLI/arXiv，从 `2026-01-01` 起检索；Current 总上限为 450，每个 Track 初始分配 25，Weekly 上限为 18。后训练 Track 不要求论文出现 Agent，但必须同时出现上下文主题和后训练方法、数据或评估证据；普通 SFT/DPO/RL、纯 KV cache 优化和金融 RSI 不纳入。

```powershell
bun src/cli.ts --library agent-context harvest-plan --mode current --format json
bun src/cli.ts --library agent-context schedule-config --format json
bun src/cli.ts --library agent-context run-task --mode current --limit 5 --format json
bun src/cli.ts --library agent-context run-task --mode weekly --format json
bun src/cli.ts --library agent-context reconcile
```

Skill & Prompt Engineering 的稳定标识为 `skill-prompt-engineering`，只从 OpenCLI/arXiv 获取 `2026-01-01` 以来的论文，19 个 Track 各 25 篇、Current 总上限 475，Weekly 增量上限 20，默认关闭调度。`pe-*` 是 Prompt Engineering 主题，覆盖提示词设计、上下文学习、推理、优化、安全和评测；`se-*` 是 Skill Engineering 主题，覆盖技能表示、获取、检索、组合、程序性记忆、迁移、自我演化（自进化）和演化评测；`se-rsi` 专门要求 Skill 的递归自我改进对象与迭代机制。

```powershell
bun src/cli.ts --library skill-prompt-engineering harvest-plan --mode current --format json
bun src/cli.ts --library skill-prompt-engineering schedule-config --format json
bun src/cli.ts --library skill-prompt-engineering run-task --mode current --limit 5 --format json
bun src/cli.ts --library skill-prompt-engineering run-task --mode weekly --format json
bun src/cli.ts --library skill-prompt-engineering reconcile
```

详细边界、数据根和恢复顺序见 [Skill & Prompt Engineering 操作说明](docs/skill-prompt-engineering/operations.md)。

选定方向后进入内置任务菜单，前三行是：

```text
论文知识引擎（Bun CLI）
当前方向库：FSD 论文知识库（fsd）
=========================
```

菜单按方向类型显示不同操作；方向列表自动读取 `config/<libraryId>/library.yaml`，所有已配置的 paper 库都显示同一组 MinerU、PDF、Evidence 操作。paper 库菜单还包含 arXiv 网络检查、OpenCLI 准备/修复和方向切换；不会出现 Research 专用的 Backfill 或来源导入菜单。新增 paper 库配齐论文四文件，research 库配齐 research 四文件。直接执行方向命令必须提供 `--library`，不会默认使用 FSD；例如：

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
├─ llm-post-training\
│  ├─ library.yaml            LLM Post-Training 身份、日期、配额、调度
│  ├─ query-matrix.yaml       18 个后训练 Track 的 arXiv 查询
│  ├─ paper-policy.yaml       后训练论文纳入、排除和 Track 优先级
│  └─ categories.yaml         18 个 Track 的 PDF 分类目录映射
├─ agent-tool\
│  ├─ library.yaml            Agent Tool & RSI 身份、日期、配额、调度
│  ├─ query-matrix.yaml       18 个工具/后训练/RSI Track 的 arXiv 查询
│  ├─ paper-policy.yaml       工具能力、后训练和 RSI 纳入规则
│  └─ categories.yaml         18 个 Track 的 PDF 分类目录映射
├─ agent-context\
│  ├─ library.yaml            Agent Context 身份、日期、配额、调度
│  ├─ query-matrix.yaml       Context/RSI/后训练 Context Track 的 arXiv 查询
│  ├─ paper-policy.yaml       Context、RSI 与后训练 Context 纳入规则
│  └─ categories.yaml         Track 的 PDF 分类目录映射
├─ skill-prompt-engineering\
│  ├─ library.yaml            Prompt/Skill 身份、日期、配额、调度
│  ├─ query-matrix.yaml       10 个 Prompt、9 个 Skill Track 的 arXiv 查询
│  ├─ paper-policy.yaml       Prompt、Skill 与 RSI 纳入规则
│  └─ categories.yaml         19 个 Track 的 PDF 分类目录映射
└─ agent-memory\
   ├─ library.yaml            Agent Memory 身份、日期、配额、调度
   ├─ query-matrix.yaml       20 个记忆/RSI/后训练记忆 Track 的 arXiv 查询
   ├─ paper-policy.yaml       记忆机制、RSI 与后训练记忆纳入规则
   └─ categories.yaml         20 个 Track 的 PDF 分类目录映射
```

| 配置 | 职责 |
| --- | --- |
| `config/engine.yaml` | 共享的 arXiv、MinerU、运行时和 Evidence 发布参数 |
| `config/machine.local.yaml` | 本机根路径、可选网络代理、MinerU 安装、模型和设备 |
| `config/fsd/` | `library.yaml` 管日期/配额/调度，`query-matrix.yaml` 管检索，`paper-policy.yaml` 管筛选，`categories.yaml` 管分类 |
| `config/agent-engineering/` | Agent Engineering 的 arXiv Track、论文筛选和 PDF 分类；不读取 FSD 的方向级状态 |
| `config/multi-agent-engineering/` | Multi-Agent Engineering 的 arXiv Track、论文筛选和 PDF 分类；不读取其他方向的方向级状态 |
| `config/llm-post-training/` | LLM Post-Training 的 18 Track 检索、筛选和 PDF 分类；稳定标识为 `llm-post-training`，不读取其他方向的状态 |
| `config/agent-tool/` | Agent Tool、LLM 工具后训练和 RSI 的 18 Track 检索、筛选和 PDF 分类；不读取其他方向的状态 |
| `config/agent-memory/` | Agent Memory、RSI 记忆和 LLM 后训练记忆的 20 Track 检索、筛选和 PDF 分类；不读取其他方向的状态 |
| `config/agent-context/` | Agent Context、RSI Context 和 LLM 后训练 Context 的 18 Track 检索、筛选和 PDF 分类；不读取其他方向的状态 |
| `config/skill-prompt-engineering/` | 10 个 Prompt Track 与 9 个 Skill Track（含 `se-rsi`）的检索、筛选和 PDF 分类；不读取其他方向的状态 |

新增方向时，在 `config/<libraryId>/` 下提供与 `library_kind` 对应的配置文件，并将 `library.yaml` 中的 `library_id` 与目录名保持一致，再通过 `--library <libraryId>` 选择。引擎代码无需复制；数据、PDF 和 Vault 路径按所选方向分别派生。旧配置仅保留在 `tests/fixtures/legacy-config/`，不参与正常运行。

生产 arXiv 请求间隔为 10 秒。所有 paper 方向共享 `data_libraries_root/.arxiv/` 下的机器级请求锁：请求串行、429 冷却共享；各方向的数据库、PDF、Archive、Evidence 和 Vault 仍完全隔离。OpenCLI 适配器源码变更后运行 `bun run opencli:prepare` 重建。

当前 `arxiv.capacity_cooldown_seconds: 900`，paper 库正式发现任务在收到 429 后共享 15 分钟基础冷却，并按连续失败使用 15、30、60 分钟递增。检查点、候选和已完成分片保留；冷却期间再次启动会立即返回原截止时间，不发送新请求。收到 429 时本次任务仍会结束，不在进程内循环重试；冷却结束后手动重新运行同一方向、同一模式的任务即可恢复原 run。仍保留 10 秒请求间隔、跨库串行访问，以及服务器明确返回的更长数值 `Retry-After` 等待。

PDF 下载阶段会区分“版本暂未生成 PDF”和真正的服务故障：arXiv 返回 HTTP 5xx 且响应正文明确包含 `file unavailable` 时，仅延期该论文，优先用同方向 fallback 补位并继续任务，不写入永久排除；arXiv 论文 PDF 不受本地导入的 200 页上限约束，但仍保留 200 MB 文件大小保护；普通 5xx、429 和网络错误仍按重试策略处理，耗尽后保留 run 与 checkpoint 供恢复。

Archive v2 对 MinerU 输出中的 HTML/MathML-like 资源标签执行严格解析；因此正文里的数学比较文本（例如 `<V`）在尚未进入真实 `src/href/srcset` 资源属性时不会再被误判并触发 `unparseable HTML attribute value`。一旦进入资源属性，仍执行严格的 URL、路径和引用校验，避免把损坏或不安全的资源静默发布。

冷却截止时间是最早可尝试时间，不代表上游一定已恢复；没有后台自动恢复，也不应连续高频重试或删除检查点。初次全量任务成功后，日常更新优先使用已有的 `weekly` 增量入口，避免反复从年初扫描。共享门控目前覆盖正式论文任务的发现请求，不覆盖独立网络探针或其他外部程序。

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

Multi-Agent Engineering 从 `2025-06-01` 开始检索，固定覆盖 18 个 Track；每个 Track 分别查询 submitted 与 updated，共 36 个分片。自动发现只通过 OpenCLI/arXiv；`import-local` / `parse-local` 仅处理用户显式提供的本地 PDF，是唯一非-arXiv 摄入路径。

`current` 总上限为 540 篇，各 Track 配额为 30；`weekly` 总上限为 18 篇，按本方向成功水位回溯 48 小时。配额通过共用选篇器执行，去重后计数。调度描述当前以 `2026-08-31` 为锚点，每 4 周的周一 22:30（Asia/Shanghai）运行一次；`weekly` 是增量任务模式名，实际周期以 `schedule-config` 输出为准。

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

`LLM Post-Training（大模型后训练知识库）` 的稳定标识为 `llm-post-training`，从 `2025-06-01` 开始检索。18 个 Track 为：`pt-foundations`、`pt-sft`、`pt-data-curation`、`pt-synthetic-data`、`pt-reward-modeling`、`pt-preference-optimization`、`pt-policy-optimization`、`pt-verifiable-rewards`、`pt-reasoning`、`pt-distillation`、`pt-tool-agent`、`pt-multimodal`、`pt-safety-alignment`、`pt-adaptation`、`pt-efficient-tuning`、`pt-training-systems`、`pt-stability`、`pt-evaluation`。每个 Track 同时查询 submitted 与 updated，共 36 个分片。

`current` 总上限为 630，每个 Track 的 35 是共享选篇器的初始分配目标，空额允许外溢，并非每类硬上限；`weekly` 总上限为 18，使用本库成功水位和 48 小时重叠窗口。自动来源仅为 OpenCLI/arXiv。本地 PDF 只能通过显式 `import-local` / `parse-local` 进入，且不会恢复完整 arXiv 元数据、自动归入上述 18 个 Track 或推进自动发现水位。

### Agent Tool & RSI 当前检索范围与边界

`Agent Tool & RSI（含 LLM 工具后训练）` 的稳定标识为 `agent-tool`，从 `2026-01-01` 开始检索，18 个 Track 同时查询 submitted 与 updated，共 36 个分片。8 个 Agent Tool Track 覆盖工具基础、发现选择、组合规划、协议、生成、工具/技能库、系统评测和安全；7 个 LLM 工具后训练 Track 覆盖训练数据、工具调用 SFT、奖励验证、偏好优化、交互式 RL、蒸馏迁移和后训练评测；3 个 RSI Track 覆盖工具修复、Agent 演化和改进机制的递归优化。

Current 总上限为 450，每个 Track 配置 25；Weekly 增量上限为 12，`weekly_schedule.enabled: false` 表示首期只手动运行。后训练论文必须同时有工具能力和训练证据；RSI 论文必须明确改进对象与迭代机制，不把裸 `RSI`、普通 SFT/DPO/RL 或普通工具调用作为充分证据。自动来源仅为 OpenCLI/arXiv，本地 PDF 仍通过显式 `import-local` / `parse-local` 进入。

### Agent Memory 当前检索范围与边界

`agent-memory` 是 `library_kind: paper`，显示名为 `Agent Memory（智能体记忆知识库）`，从 `2026-01-01` 起通过 OpenCLI/arXiv 自动发现。20 个 Track 同时查询 submitted 和 updated，共 40 个分片：16 个运行时/RSI 记忆主题，以及 4 个 LLM 后训练记忆主题（记忆 SFT、记忆 RL、记忆蒸馏、参数化记忆）。后训练记忆论文不要求出现 Agent，只要标题或摘要明确研究 LLM 的记忆能力、知识保持、记忆操作训练、经验内化、知识编辑或遗忘控制即可。

Current 总上限为 500，每个 Track 各配置 25；Weekly 增量上限为 20，`weekly_schedule.enabled: false` 表示首期只手动运行。`mem-rsi` 要求记忆、经验或技能积累与改进循环同时出现，普通一次性反思不自动视为 RSI。GPU 显存、普通 RAG、无记忆机制的通用 SFT/RL 和一次性自我纠错不会仅凭宽泛术语进入本库。自动来源仅为 OpenCLI/arXiv；历史基础论文通过显式 `import-local` / `parse-local` 导入，不推进自动发现水位。

```text
D:/agent-data/data/paper-libraries/agent-memory
D:/agent-data/backups/paper-libraries/agent-memory
D:/paper/paper-knowledge-engine/agent-memory
D:/obsidian/data/paper-knowledge-engine/agent-memory
```

### Skill & Prompt Engineering 当前检索范围与边界

`skill-prompt-engineering` 是 `library_kind: paper`，显示名为 `Skill & Prompt Engineering（技能与提示词工程知识库）`，从 `2026-01-01` 起通过 OpenCLI/arXiv 自动发现。19 个 Track 同时查询 submitted 和 updated，共 38 个分片；10 个 `pe-*` Track 明确归入 Prompt Engineering，9 个 `se-*` Track 明确归入 Skill Engineering，其中 `se-rsi` 专门研究 Skill 的递归自我改进。

Current 总上限为 475（19 个 Track 各 25）；Weekly 增量上限为 20，`weekly_schedule.enabled: false` 表示首期只手动运行。Prompt 论文必须有提示词或上下文策略证据；Skill 论文必须有可复用能力的表示、获取、检索、组合、记忆、迁移或演化（自进化）证据；RSI 论文还必须明确被改进对象和递归迭代、评估或选择机制。金融技术分析中的 RSI、普通 SFT/DPO/RL 和只有一次反思的论文不会仅凭关键词进入本库。自动来源仅为 OpenCLI/arXiv，历史论文通过显式 `import-local` / `parse-local` 导入，不推进自动发现水位。

```text
D:/agent-data/data/paper-libraries/skill-prompt-engineering
D:/agent-data/backups/paper-libraries/skill-prompt-engineering
D:/paper/paper-knowledge-engine/skill-prompt-engineering
D:/obsidian/data/paper-knowledge-engine/skill-prompt-engineering
```

所有 paper 方向的论文任务都按以下顺序运行：`discovery → 去重/硬筛选 → selection 冻结 → PDF → MinerU → Archive v2 → Evidence/papers/（v3）`。新 `current` 从各方向的 `start_date` 起扫描，`weekly` 使用各自方向库的成功水位和重叠窗口；失败恢复沿用已冻结的任务。论文 v1/v2 作为不同版本保存，同一论文命中多个 Track 不重复计数。

Evidence v3 的历史 receipt 和 publication 身份是不可变的。若确定性 renderer 有意升级（例如把已验证的 `images/...` 引用修正为 `assets/images/...`），旧 receipt 不会被覆盖；需要先用当前 Archive 重建完整 Vault，再生成并安装 hash-pinned renderer baseline：

```powershell
# 先将现有 Vault 做可恢复备份，并让 --source-root 指向独立目录；该目录必须位于所有运行时根目录之外（尤其不能放在 D:\agent-data\backups\paper-libraries\agent-engineering 这个 backupRoot 内）；不要删除旧目录
bun src/cli.ts --library agent-engineering vault-rebuild --dry-run --format json --source-root OLD_VAULT_ROOT > VAULT_PLAN_FILE
bun src/cli.ts --library agent-engineering vault-rebuild --apply --plan-file VAULT_PLAN_FILE --plan-sha256 VAULT_PLAN_SHA256 --source-root OLD_VAULT_ROOT
bun src/cli.ts --library agent-engineering evidence-renderer-baseline --dry-run --format json --vault-plan-file VAULT_PLAN_FILE --vault-plan-sha256 VAULT_PLAN_SHA256 > BASELINE_FILE
bun src/cli.ts --library agent-engineering evidence-renderer-baseline --apply --baseline-file BASELINE_FILE --baseline-sha256 BASELINE_SHA256 --vault-plan-file VAULT_PLAN_FILE --vault-plan-sha256 VAULT_PLAN_SHA256
# 基线安装后，再恢复原 run；不重新发现、不改旧 receipt、不删除 SQLite
bun src/cli.ts --library agent-engineering evidence-publish --run-id RUN_ID
```

其中两个 `SHA256` 必须来自人工审阅后的 canonical JSON 文件。普通 `run-task` 现在会在 discovery 前执行历史 Evidence 预检；若发现同类冲突会立即停止并提示上述恢复入口，不再运行数小时后才在 publish 阶段失败。

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
| `D:/agent-data/data/paper-libraries/agent-tool` | Agent Tool & RSI 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/agent-tool` | Agent Tool & RSI 的备份目标根 |
| `D:/paper/paper-knowledge-engine/agent-tool` | Agent Tool & RSI 的 arXiv PDF 和显式导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/agent-tool` | Agent Tool & RSI Vault；publisher 只拥有 `Evidence/` |
| `D:/agent-data/data/paper-libraries/agent-context` | Agent & LLM Context 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/agent-context` | Agent & LLM Context 的备份目标根 |
| `D:/paper/paper-knowledge-engine/agent-context` | Agent & LLM Context 的 arXiv PDF 和显式导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/agent-context` | Agent & LLM Context Vault；publisher 只拥有 `Evidence/` |
| `D:/agent-data/data/paper-libraries/agent-memory` | Agent Memory 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/agent-memory` | Agent Memory 的备份目标根 |
| `D:/paper/paper-knowledge-engine/agent-memory` | Agent Memory 的 arXiv PDF 和显式导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/agent-memory` | Agent Memory Vault；publisher 只拥有 `Evidence/` |
| `D:/agent-data/data/paper-libraries/skill-prompt-engineering` | Skill & Prompt Engineering 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/skill-prompt-engineering` | Skill & Prompt Engineering 的备份目标根 |
| `D:/paper/paper-knowledge-engine/skill-prompt-engineering` | Skill & Prompt Engineering 的 arXiv PDF 和显式导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/skill-prompt-engineering` | Skill & Prompt Engineering Vault；publisher 只拥有 `Evidence/` |

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

方向库配置、筛选正负例、paper 菜单、MinerU 会话与共享发现检查点的定向验证：

```powershell
bun test --timeout 30000 tests/agent-tool-paper-library.test.ts tests/agent-tool-integration.test.ts tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts
```

Agent Memory 的方向契约与后训练记忆边界：

```powershell
bun test --timeout 30000 tests/agent-memory-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/research-library-config.test.ts
```

Skill & Prompt Engineering 的 Prompt/Skill 分类、RSI 边界和 19 Track 计划：

```powershell
bun test --timeout 30000 tests/skill-prompt-engineering-paper-library.test.ts
```

Multi-Agent 的设计约束见 [设计方案](docs/superpowers/specs/2026-09-06-multi-agent-engineering-design.md)，实施步骤、最终复审和已知测试失败见 [实施与验证记录](docs/superpowers/plans/2026-09-07-multi-agent-engineering-paper-only.md)。

详细操作见 [使用手册](使用手册.md)、[配置说明](config/README.md) 和 [源码结构](src/README.md)。
paper 菜单、MinerU 会话与共享发现检查点的定向验证：

```powershell
bun test --timeout 30000 tests/agent-tool-paper-library.test.ts tests/agent-tool-integration.test.ts tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts
```

Agent Memory 的方向契约与后训练记忆边界：

```powershell
bun test --timeout 30000 tests/agent-memory-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/research-library-config.test.ts
```

Multi-Agent 的设计约束见 [设计方案](docs/superpowers/specs/2026-09-06-multi-agent-engineering-design.md)，实施步骤、最终复审和已知测试失败见 [实施与验证记录](docs/superpowers/plans/2026-09-07-multi-agent-engineering-paper-only.md)。

详细操作见 [使用手册](使用手册.md)、[配置说明](config/README.md) 和 [源码结构](src/README.md)。
