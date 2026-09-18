# 论文知识引擎配置

活动配置按引擎、机器、方向分层；每个方向有独立目录。配置必须符合严格字段校验，未知字段和未知方向库会报错。

| 配置类 | 文件 | 所有权 |
| --- | --- | --- |
| 引擎配置 | `engine.yaml` | 所有方向共用的发现、MinerU、运行时和 Evidence 行为 |
| 机器配置 | `machine.local.yaml` | 本机绝对根路径、MinerU 安装、模型和设备 |
| 方向配置 | `fsd/library.yaml` | FSD 身份、名称、日期、配额与调度 |
| 检索配置 | `fsd/query-matrix.yaml` | FSD 检索方向、查询、arXiv 分类和日期模式 |
| Agent 论文检索配置 | `agent-engineering/query-matrix.yaml` | Agent Track、查询、arXiv 分类和日期模式 |
| 筛选配置 | `fsd/paper-policy.yaml` | FSD 纳入、排除条件和分类优先级 |
| 分类配置 | `fsd/categories.yaml` | FSD PDF 分类目录映射 |
| Agent 筛选配置 | `agent-engineering/paper-policy.yaml` | Agent 论文纳入、排除条件和分类优先级 |
| Agent 分类配置 | `agent-engineering/categories.yaml` | Agent PDF 分类目录映射 |
| Multi-Agent 方向配置 | `multi-agent-engineering/library.yaml` | Multi-Agent 身份、名称、日期、配额与调度 |
| Multi-Agent 论文检索配置 | `multi-agent-engineering/query-matrix.yaml` | Multi-Agent Track、查询、arXiv 分类和日期模式 |
| Multi-Agent 筛选配置 | `multi-agent-engineering/paper-policy.yaml` | Multi-Agent 论文纳入、排除条件和分类优先级 |
| Multi-Agent 分类配置 | `multi-agent-engineering/categories.yaml` | Multi-Agent PDF 分类目录映射 |
| 后训练方向配置 | `llm-post-training/library.yaml` | LLM Post-Training 身份、名称、日期、配额与调度 |
| 后训练论文检索配置 | `llm-post-training/query-matrix.yaml` | 18 个后训练 Track、查询、arXiv 分类和日期模式 |
| 后训练筛选配置 | `llm-post-training/paper-policy.yaml` | 模型对象词、后训练信号、排除条件和分类优先级 |
| 后训练分类配置 | `llm-post-training/categories.yaml` | 18 个 Track 的 PDF 分类目录映射 |
| Agent Tool 方向配置 | `agent-tool/library.yaml` | Agent Tool、LLM 工具后训练和 RSI 身份、日期、配额与调度 |
| Agent Tool 检索配置 | `agent-tool/query-matrix.yaml` | 18 个工具/后训练/RSI Track、查询、arXiv 分类和日期模式 |
| Agent Tool 筛选配置 | `agent-tool/paper-policy.yaml` | 工具能力、后训练和 RSI 纳入规则与分类优先级 |
| Agent Tool 分类配置 | `agent-tool/categories.yaml` | 18 个 Track 的 PDF 分类目录映射 |
| Agent Context 方向配置 | `agent-context/library.yaml` | Agent Context、RSI Context 和 LLM 后训练 Context 身份、日期、配额与调度 |
| Agent Context 检索配置 | `agent-context/query-matrix.yaml` | 18 个上下文、RSI 和后训练 Context Track、查询、arXiv 分类和日期模式 |
| Agent Context 筛选配置 | `agent-context/paper-policy.yaml` | 上下文主题、RSI 与后训练 Context 纳入规则和分类优先级 |
| Agent Context 分类配置 | `agent-context/categories.yaml` | 18 个 Track 的 PDF 分类目录映射 |
| Agent Memory 方向配置 | `agent-memory/library.yaml` | Agent Memory 身份、名称、日期、配额与调度 |
| Agent Memory 检索配置 | `agent-memory/query-matrix.yaml` | 20 个记忆、RSI 和后训练记忆 Track、查询、arXiv 分类和日期模式 |
| Agent Memory 筛选配置 | `agent-memory/paper-policy.yaml` | 记忆机制、RSI 与后训练记忆纳入规则和分类优先级 |
| Agent Memory 分类配置 | `agent-memory/categories.yaml` | 20 个 Track 的 PDF 分类目录映射 |
| Skill & Prompt 方向配置 | `skill-prompt-engineering/library.yaml` | Prompt/Skill 身份、日期、配额与手动周任务描述 |
| Skill & Prompt 检索配置 | `skill-prompt-engineering/query-matrix.yaml` | 10 个 Prompt、9 个 Skill Track、查询、arXiv 分类和日期模式 |
| Skill & Prompt 筛选配置 | `skill-prompt-engineering/paper-policy.yaml` | Prompt、Skill 与 RSI 纳入规则和分类优先级 |
| Skill & Prompt 分类配置 | `skill-prompt-engineering/categories.yaml` | 19 个 Track 的 PDF 分类目录映射 |

`bun src/cli.ts` 先显示方向选择，不默认选择 `fsd`；`bun src/cli.ts --library fsd` 显式选库。paper 方向的任务菜单 `10` 准备或修复 OpenCLI，`11` 切换方向；Research 菜单仍以 `10` 切换方向。直接执行方向命令必须指定 `--library`。方向列表读取 `config/<libraryId>/library.yaml`，`display_name` 用于选库和任务菜单，状态由 `library_id` 隔离。新增方向提供与 `library_kind` 对应的四文件契约。旧版配置已移至 `tests/fixtures/legacy-config/`，只供兼容测试，不参与活动配置的覆盖或合并。

FSD 当前启用 8 个检索方向，各包含 submitted、updated 两种日期模式，共 16 个分片；PDF 映射为 12 类加未分类兜底，分类映射不等于独立检索任务。

## 引擎配置

`engine.yaml` 的 `engine_name` 固定为 `paper-knowledge-engine`。

- `arxiv`：分页、请求间隔、超时、重试和容量冷却。生产请求间隔为 10 秒；所有 paper 方向库的正式发现任务共享机器级 arXiv 请求锁（位于 `data_libraries_root/.arxiv/`），串行发送 API 请求。当前 `capacity_cooldown_seconds: 0` 关闭本地额外冷却，旧检查点和共享本地冷却不再阻止恢复；仍保留检查点及服务端明确给出的数值 `Retry-After` 等待。429 立即结束当前任务，不自动循环，可手动重新执行同一任务。设为正整数可恢复按基础值 1、2、4 倍递增的本地冷却。独立网络探针和外部程序不在此门控范围内；取消冷却不保证上游可用。
- `runtime`：进程清理、诊断超时和输出大小上限。
- `mineru`：后端、请求并发、处理窗口、推理批量、API 和本地导入边界。
- `evidence`：固定 v3 发布契约。

```yaml
evidence:
  schema_version: 3
  root: Evidence
  paper_root: papers
  index_roots:
    authors: indexes/authors.md
    categories: indexes/categories.md
    tracks: indexes/tracks.md
    years: indexes/years.md
  publisher_version: 3
```

`pipeline_batch_ratio` 支持 1、2、4、8、16，通过 MinerU 的 `MINERU_VIRTUAL_VRAM_SIZE` 兼容设置约束 Pipeline 内部批量；当前为 1。`max_concurrency` 控制请求并发，`processing_window_size` 控制处理页窗口，二者当前也为 1。`vlm_batch_size`、`vlm_cache_max_entry_count` 只作用于 VLM。

`task_timeout_seconds` 同时约束 Bun 客户端和 MinerU 结果等待；`result_download_timeout_seconds` 只控制结果下载。`api_startup_timeout_seconds` 单独约束任务级 API 的启动就绪时间。每个解析操作共享一个本地 API，退出时清理。所有使用同一 `source_root` 的 Paper Knowledge Engine 和 Flowmate 会话还会共享 `source_root` 上一级的 `.fsd-mineru-resource.lock`，在 API 会话全生命周期内串行化 GPU 模型；锁被其他项目持有时返回 `MINERU_RESOURCE_BUSY`，不要手工删除运行中锁文件。

`local_import` 控制递归、文件数、PDF 页数、文件大小和默认 Track。MinerU Markdown 与页文本引用的本地资源先归一化进 Archive，再按 Evidence v3 路径发布。

`research_evidence` 是独立的 research 发布契约：schema 版本为 1，根目录为 `Evidence/sources`，并固定生成 `indexes/topics.md`、`indexes/source-types.md`、`indexes/lifecycles.md` 与 `indexes/concepts.md`。它不替换也不放宽现有 paper 的 Evidence v3 `papers/` 契约。

## 机器配置

共享代码目标根：`D:/agent-data/backend/projects/paper-knowledge-engine`。

```yaml
roots:
  data_libraries_root: "D:/agent-data/data/paper-libraries"
  backup_libraries_root: "D:/agent-data/backups/paper-libraries"
  pdf_libraries_root: "D:/paper/paper-knowledge-engine"
  vaults_root: "D:/obsidian/data/paper-knowledge-engine"
```

所选 `fsd` 的运行根为 `D:/agent-data/data/paper-libraries/fsd`，数据库为根内 `library.sqlite`，Archive 为 `archive/`，临时工作为 `work/`，任务历史为 `runs/` 和 `operations/`。备份根为 `D:/agent-data/backups/paper-libraries/fsd`。

PDF 原件下载到 `D:/paper/paper-knowledge-engine/fsd/<分类>/`；Obsidian 打开 `D:/obsidian/data/paper-knowledge-engine/fsd`。两者都由配置根加方向库 ID 派生，不把 `fsd` 写死在通用代码中。内部 Archive 和 Vault 仍保留现有契约要求的 PDF 副本。

`pdf_libraries_root` 是独立 PDF 根；未配置时兼容旧配置，下载仍位于内部 `work/downloads`。显式配置时应与内部数据、备份、Vault 根分开，避免临时清理或发布覆盖原件。配置更新本身不会迁移或恢复文件。MinerU 安装、版本/commit、模型目录和 GPU 选择也由机器配置管理。

### arXiv API 与 HTTP 代理

`network.http_proxy` 仍是 PDF 下载代理；OpenCLI 发现可以单独选择路由：

```yaml
network:
  http_proxy: "http://127.0.0.1:7897"
  opencli_proxy_mode: configured   # configured | direct | inherit
  arxiv_api_base: "https://arxiv.org/api/query"
```

端口仅为示例，请填写已经运行的代理地址；引擎不会扫描端口或启动代理。允许 HTTP/HTTPS 代理源地址（末尾 `/` 可选），拒绝凭据、其他路径、查询、片段、控制字符和非法端口。不需要时删除 `http_proxy` 或整个 `network`，不要填写空字符串或 `null`。不要提交自己的机器配置值。

`arxiv_api_base` 只允许 `https://arxiv.org/api/query` 和 `https://export.arxiv.org/api/query`，省略时默认使用 `export.arxiv.org`。`opencli_proxy_mode` 省略时，有 `http_proxy` 就是 `configured`，没有就是 `inherit`。在本机配置中推荐使用 `configured`，让 OpenCLI 与 PDF 下载复用已验证的 `http_proxy`；只有 `arxiv-check` 已确认直连稳定时才使用 `direct`。`direct` 会清除 OpenCLI 子进程中的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 大小写别名并设置 `NO_PROXY=*`，PDF 仍使用 `http_proxy`。`inherit` 保留父进程的代理环境。

未来的 Research 方向库加载时，会把解析后的 arXiv API 主机校验为 `source-policy.yaml` 的允许域名，以及所有启用 `paper`/`technical-report` 的 Track 域名。该校验不适用于 Agent Engineering 或 Multi-Agent Engineering，因为两者都是 paper 库，使用下方论文配置中的 `categories` 字段。

Research 的 `query-matrix.yaml` 中，包含 `paper` 或 `technical-report` 的 Track 必须配置非空的 `arxiv_categories`，例如：

```yaml
- id: agent-loop
  query: agent observe plan act reflect termination retry
  arxiv_categories: [cs.AI, cs.CL, cs.PL, cs.SE]
  source_kinds: [paper, technical-report, official-doc, evaluation-method]
```

引擎加载配置时会校验分类格式和非空约束，arXiv adapter 会将分类排序后传给 OpenCLI 的 `--categories`。因此不会再以空分类启动 `arxiv harvest`；修改或删除分类会在任务开始前给出具体配置文件和字段错误。

浏览器能打开 `https://arxiv.org/` 不等于 Bun/OpenCLI 进程能访问 API 主机；浏览器可能使用另一套系统代理、PAC 或 DNS。修改前从同一 Bun 运行时执行：

```powershell
bun src/cli.ts --library fsd arxiv-check --format json
```

探针只发一条 `max-results=1` 的元数据请求，不创建任务、checkpoint、PDF、Archive 或 Evidence。`reachable` 表示可访问，`rate-limited` 表示收到了 429，`unreachable` 表示连接或传输失败。不要在同一任务中自动来回切换代理和直连；路由在一次 OpenCLI 调用开始前固定。

代理不会写入系统设置或父进程环境；成功、失败和并发库调用均无全局环境改写。MinerU 健康检查始终直连，MinerU 子进程在继承的 `NO_PROXY` 排除项中补入回环地址，保证本地 API 不经过代理。

Windows 下，OpenCLI 和 MinerU 在子进程环境构造边界统一使用大写键，移除大小写别名冲突；显式代理覆盖所有继承的同名别名，MinerU 的 `NO_PROXY` 条目也会去重。非 Windows 保留大小写兼容键，不改写父进程环境。

健康检查每次请求最多 1 秒，且不超过剩余启动期限；响应正文上限为 16 KiB。请求结束、失败、超时、会话取消或服务进程退出时销毁连接，并清理请求定时器和取消监听。

## 方向配置

### Agent Engineering 方向库

`agent-engineering` 是 `library_kind: paper`，与 FSD 使用完全相同的四个论文文件：`library.yaml`、`query-matrix.yaml`、`paper-policy.yaml` 与 `categories.yaml`。它固定从 `2026-01-01` 起通过 OpenCLI 查询 arXiv，不再使用 `source-policy.yaml`、`topic-taxonomy.yaml`、`max_sources` 或 `import-source`。

Agent Engineering 的 15 个固定 Track 是：`harness-control-loop`、`agent-loop`、`runtime-execution`、`tool-mcp`、`context-prompt`、`memory-state-session`、`guardrails-policy`、`permissions-authorization`、`identity-tenancy-governance`、`hitl-approval`、`sandbox-isolation`、`testing-evaluation`、`agent-evaluation-methodology`、`tracing-observability`、`reliability-operations`。每个 Track 在 `query-matrix.yaml` 中配置 `categories` 和 `date_modes: [submitted, updated]`，再由 `paper-policy.yaml` 做规则筛选和分类优先级控制；`categories.yaml` 只负责 PDF 分类目录映射。

Agent 与 FSD 的菜单和任务命令相同：

```text
bun src/cli.ts --library agent-engineering harvest-plan --mode current --format json
bun src/cli.ts --library agent-engineering mineru-config --format json
bun src/cli.ts --library agent-engineering arxiv-check --format json
bun src/cli.ts --library agent-engineering run-task --mode current|weekly
bun src/cli.ts --library agent-engineering import-local --path ABSOLUTE_PATH
bun src/cli.ts --library agent-engineering parse-local --base-id BASE_ID
bun src/cli.ts --library agent-engineering evidence-publish --run-id RUN_ID
bun src/cli.ts --library agent-engineering reconcile
```

Agent 任务的 JSON 结果固定包含论文任务的 `runId`、`mode`、`resumed`、`status` 以及 `counters`：

```json
{
  "counters": {
    "candidates": 0,
    "accepted": 0,
    "newVersions": 0,
    "archived": 0,
    "published": 0
  }
}
```

五个计数均按唯一论文 `baseId/version` 计算，不按 Track 命中次数、HTTP 请求次数或 OpenCLI 返回条目次数计算。Agent Engineering 的运行根、PDF 根和 Vault 根分别按 `agent-engineering` 派生，不与 `fsd` 的数据库、Archive、Evidence 或锁交叉。

### Multi-Agent Engineering 方向库

`multi-agent-engineering` 是 `library_kind: paper`，与 FSD/Agent 使用相同的四个论文文件：`library.yaml`、`query-matrix.yaml`、`paper-policy.yaml` 与 `categories.yaml`。它固定从 `2025-06-01` 起通过 OpenCLI/arXiv 自动发现论文；Current 上限为 540、每个 Track 初始配额为 30、Weekly 上限为 18、增量重叠窗口为 48 小时。

`weekly_schedule` 当前以 `2026-08-31` 为锚点，`interval_weeks: 4`，周一 22:30（Asia/Shanghai）执行。`weekly` 表示增量模式，实际调度周期由配置决定；查看 `schedule-config` 不会安装或触发计划任务。

`paper-policy.yaml` 的技术匹配词限定为明确的多 Agent、复数 Agent 或 Agent 间关系表述，例如 `multi-agent`、`multiple agents`、`collaborative agents`、`agent-to-agent`。`program_structure_terms: []`，避免普通 `shared memory`、`communication protocol` 等结构词单独满足技术匹配条件。共用筛选器从标题和摘要获取证据，并同时校验工程任务词、arXiv 身份、日期及已启用 Track；不能只凭 Track 标签纳入。修改词表时须运行 `tests/multi-agent-paper-library.test.ts`，保留 Multi-Agent 正例及单 Agent、普通并行程序两个负例。

固定的 18 个 Track 是：`mas-foundations`、`mas-topology`、`mas-roles-capabilities`、`mas-lifecycle-composition`、`mas-task-decomposition`、`mas-delegation-handoff`、`mas-planning-scheduling`、`mas-communication`、`mas-shared-state-memory`、`mas-coordination-consensus`、`mas-conflict-negotiation`、`mas-synthesis-verification`、`mas-security-governance`、`mas-fault-tolerance`、`mas-resource-governance`、`mas-observability`、`mas-human-oversight`、`mas-evaluation-methodology`。每个 Track 同时配置 submitted、updated 日期模式，共 36 个检索分片。

自动发现只通过 OpenCLI/arXiv。手工 `import-local` / `parse-local` 保持可用，仅处理用户显式指定的本地 PDF，不改变 arXiv 水位或自动候选计数。Research 的 `source-config`、`import-source` 与 `run-task --mode backfill` 对本方向不可用。

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

Multi-Agent 任务使用相同的五个唯一论文计数：`candidates`、`accepted`、`newVersions`、`archived` 和 `published`；均按唯一 `baseId/version` 计数，不按 Track 命中次数计算。

### LLM Post-Training 方向库

`llm-post-training` 是 `library_kind: paper`，显示名为 `LLM Post-Training（大模型后训练知识库）`，复用同一组 `library.yaml`、`query-matrix.yaml`、`paper-policy.yaml` 和 `categories.yaml`。自动起点为 `2025-06-01`，增量重叠窗口为 48 小时；自动发现只通过 OpenCLI/arXiv。

固定的 18 个 Track 是：`pt-foundations`、`pt-sft`、`pt-data-curation`、`pt-synthetic-data`、`pt-reward-modeling`、`pt-preference-optimization`、`pt-policy-optimization`、`pt-verifiable-rewards`、`pt-reasoning`、`pt-distillation`、`pt-tool-agent`、`pt-multimodal`、`pt-safety-alignment`、`pt-adaptation`、`pt-efficient-tuning`、`pt-training-systems`、`pt-stability`、`pt-evaluation`。每个 Track 配置 `date_modes: [submitted, updated]`，共 36 个分片。

Current 总上限为 630，18 个 Track 各配置 35；这 35 是共享选篇器的初始分配目标，去重后的空额可以外溢，不是每类硬上限。Weekly 总上限为 18。`weekly_schedule.enabled: true` 保留增量调度描述。本库的 SQLite、Archive、runs、operations、水位、锁、PDF、Vault 和发布回执全部由机器根加 `llm-post-training` 派生，与其他方向隔离：

```text
D:/agent-data/data/paper-libraries/llm-post-training
D:/agent-data/backups/paper-libraries/llm-post-training
D:/paper/paper-knowledge-engine/llm-post-training
D:/obsidian/data/paper-knowledge-engine/llm-post-training
```

只读检查和实际操作顺序见 [后训练库操作说明](../docs/llm-post-training/operations.md)。定向回归命令为：

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts tests/research-fsd-isolation.test.ts
```

### Agent Tool & RSI 方向库

`agent-tool` 是 `library_kind: paper`，显示名为 `Agent Tool & RSI（含 LLM 工具后训练）`。它复用四个 paper 配置文件，从 `2026-01-01` 起通过 OpenCLI/arXiv 自动发现。18 个 Track 分为 8 个 Agent Tool、7 个 LLM 工具后训练和 3 个 RSI 方向，每个 Track 同时配置 `submitted`、`updated`，共 36 个分片。

Current 总上限为 450，每个 Track 各 25；Weekly 增量上限为 12，`weekly_schedule.enabled: false` 表示首期手动运行。后训练 Track 要求工具能力与训练证据同时出现，RSI Track 要求明确的改进对象与迭代机制，不把裸 `RSI`、普通 SFT/DPO/RL 或普通工具调用作为充分证据。本库的 SQLite、Archive、runs、operations、水位、锁、PDF、Vault 和发布回执全部由机器根加 `agent-tool` 派生：

```text
D:/agent-data/data/paper-libraries/agent-tool
D:/agent-data/backups/paper-libraries/agent-tool
D:/paper/paper-knowledge-engine/agent-tool
D:/obsidian/data/paper-knowledge-engine/agent-tool
```

操作顺序和边界见 [Agent Tool & RSI 操作说明](../docs/agent-tool/operations.md)，定向回归命令为：

```powershell
bun test --timeout 30000 tests/agent-tool-paper-library.test.ts tests/agent-tool-integration.test.ts
```

### Agent Memory 方向库

`agent-memory` 是 `library_kind: paper`，显示名为 `Agent Memory（智能体记忆知识库）`。它从 `2026-01-01` 起通过 OpenCLI/arXiv 自动发现，固定覆盖 20 个 Track，并为每个 Track 配置 `submitted`、`updated` 两种日期模式，共 40 个分片。16 个 Track 研究运行时记忆与 RSI 记忆，4 个 Track 研究 LLM 后训练记忆：记忆 SFT、记忆 RL、记忆蒸馏和参数化记忆。

后训练记忆 Track 不要求论文出现 Agent，但标题或摘要必须同时提供语言模型对象证据和具体记忆/知识保持/遗忘或记忆操作证据；普通 SFT、RL、蒸馏、GPU 显存优化和普通 RAG 不会仅凭宽泛词进入本库。`mem-rsi` 需要同时出现累积经验、记忆或技能与改进循环证据，普通一次性反思不自动归为 RSI。

Current 总上限为 500，各 Track 配置 25；Weekly 上限为 20，`weekly_schedule.enabled: false` 表示首期只手动运行。四个配置文件共同约束身份、查询、筛选和 PDF 分类，运行根、PDF 根与 Vault 根按 `agent-memory` 派生，历史论文仍通过显式本地 PDF 入口补充。

```powershell
bun src/cli.ts --library agent-memory harvest-plan --mode current --format json
bun src/cli.ts --library agent-memory schedule-config --format json
bun src/cli.ts --library agent-memory run-task --mode current --limit 5 --format json
bun src/cli.ts --library agent-memory run-task --mode weekly --format json
bun src/cli.ts --library agent-memory reconcile
```

方向回归测试：

```powershell
bun test --timeout 30000 tests/agent-memory-paper-library.test.ts tests/llm-post-training-integration.test.ts
```

### Agent & LLM Context 方向库

`agent-context` 是 `library_kind: paper`，显示名为 `Agent & LLM Context（上下文知识库）`。它从 `2026-01-01` 起通过 OpenCLI/arXiv 自动发现，固定覆盖 18 个 Track，并为每个 Track 配置 `submitted`、`updated` 两种日期模式，共 36 个分片。主题分为 Agent Context 工程、RSI Context，以及 LLM 后训练 Context 六类：长上下文、检索 grounding、记忆策略、上下文蒸馏、上下文数据和上下文评测。

后训练 Context Track 不要求论文出现 Agent，但标题或摘要必须同时提供语言模型对象、上下文主题和后训练方法/数据/评估证据；普通 SFT、DPO、RL、纯 KV cache 优化和金融 RSI 不会仅凭宽泛词进入本库。RSI Track 要求上下文或记忆与反思、经验反馈或递归演化同时出现。

Current 总上限为 450，各 Track 配置 25；Weekly 上限为 18，`weekly_schedule.enabled: true` 保留增量调度描述。四个配置文件共同约束身份、查询、筛选和 PDF 分类，运行根、PDF 根与 Vault 根按 `agent-context` 派生。

```powershell
bun src/cli.ts --library agent-context harvest-plan --mode current --format json
bun src/cli.ts --library agent-context schedule-config --format json
bun src/cli.ts --library agent-context run-task --mode current --limit 5 --format json
bun src/cli.ts --library agent-context run-task --mode weekly --format json
bun src/cli.ts --library agent-context reconcile
```

方向回归测试：

```powershell
bun test --timeout 30000 tests/agent-context-paper-library.test.ts
```

### Skill & Prompt Engineering 方向库

`skill-prompt-engineering` 是 `library_kind: paper`，显示名为 `Skill & Prompt Engineering（技能与提示词工程知识库）`。它从 `2026-01-01` 起通过 OpenCLI/arXiv 自动发现，固定覆盖 19 个 Track，并为每个 Track 配置 `submitted`、`updated` 两种日期模式，共 38 个分片。前 10 个 `pe-*` Track 只归入 Prompt Engineering；后 9 个 `se-*` Track 只归入 Skill Engineering，包含技能获取、组合、迁移、自我演化（自进化）和评测，`se-rsi` 负责 Skill 的递归自我改进。

Current 总上限为 475（19 个 Track 各 25）；Weekly 上限为 20，`weekly_schedule.enabled: false` 表示首期只手动运行。Prompt 论文需要提示词或上下文策略证据；Skill 论文需要可复用能力的表示、获取、检索、组合、程序性记忆、迁移或演化证据；RSI 论文还需要明确被改进对象和递归迭代、评估或选择机制。金融技术分析中的 RSI、普通 SFT/DPO/RL 和一次性反思不会仅凭宽泛词进入本库。四个配置文件共同约束身份、查询、筛选和 PDF 分类，运行根、PDF 根与 Vault 根按 `skill-prompt-engineering` 派生：

```text
D:/agent-data/data/paper-libraries/skill-prompt-engineering
D:/agent-data/backups/paper-libraries/skill-prompt-engineering
D:/paper/paper-knowledge-engine/skill-prompt-engineering
D:/obsidian/data/paper-knowledge-engine/skill-prompt-engineering
```

只读检查和实际操作顺序见 [Skill & Prompt Engineering 操作说明](../docs/skill-prompt-engineering/operations.md)。定向回归命令为：

```powershell
bun test --timeout 30000 tests/skill-prompt-engineering-paper-library.test.ts
```

FSD 继续是 `library_kind: paper`，并始终使用四个论文文件：`library.yaml`、`query-matrix.yaml`、`paper-policy.yaml`、`categories.yaml`。论文执行、MinerU、本地 PDF 导入与现有 Evidence v3 只接受此 paper 配置分支。

`fsd/library.yaml` 中：

- `library_id: fsd`，`display_name: FSD 论文知识库`。
- `start_date: "2026-01-01"` 是新 current 任务的权威起点。
- `overlap_hours` 用于 weekly 增量窗口；显式日期参数覆盖默认窗口。
- `current_task` 控制总上限及各 Track 配额；检索条件由 `fsd/query-matrix.yaml` 的 `tracks` 定义，硬过滤由 `fsd/paper-policy.yaml` 定义，PDF 分类目录由 `fsd/categories.yaml` 定义。
- `weekly_schedule.task_name` 为 `paper-knowledge-engine-fsd-weekly`；周期、日期、时区和配额也从此处读取。

```text
bun src/cli.ts --library fsd harvest-plan --mode current --format json
bun src/cli.ts --library fsd schedule-config --format json
bun src/cli.ts --library fsd mineru-config --format json
```
