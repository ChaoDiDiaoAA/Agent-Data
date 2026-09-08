# Multi-Agent Engineering（Multi-Agent 工程）知识库目标设计

## 状态

- 设计对象：`multi-agent-engineering` 方向库
- 显示名称：Multi-Agent Engineering（Multi-Agent 工程知识库）
- 原设计日期：2026-09-06
- 范围修订日期：2026-09-07
- 当前状态：已确认的 paper-only 目标方案；实施计划待单独确认
- 适用引擎：现有 `paper-knowledge-engine`

## 范围修订（2026-09-07）

Multi-Agent Engineering 的活动实现参考当前 Agent Engineering：配置为 `library_kind: paper`，自动采集只通过 OpenCLI 获取 arXiv 论文，并完整复用 FSD/Agent 已有的论文发现、筛选、去重、PDF 下载、MinerU、Archive v2、Evidence v3、任务恢复和 CLI 路径。

本方向不建设独立 Research workflow，不自动采集官方文档、规范、仓库、Release、博客、网页或其他来源。保留共享的 `import-local`/`parse-local` 手工 PDF 导入能力；它是用户主动维护入口，不属于自动来源发现。

## 1. 目标

### 1.1 研究目标

系统研究多个具有独立 Context、State 或决策边界的 Agent 如何组成、协作、通信、恢复和被评测，形成可引用、可版本化、可恢复的论文知识库，覆盖：

- Multi-Agent 的定义、边界、系统类型和问题建模
- 层级、Supervisor-Worker、Pipeline、Swarm、Peer-to-Peer、Blackboard 和 Graph 拓扑
- Agent 角色、能力、身份、专业化、能力发现和动态分配
- Agent 生命周期、动态创建/销毁和运行时组合
- 任务拆解、分派、路由、委派、交接和任务契约
- 联合规划、调度、并行执行、资源竞争和关键路径
- 消息、事件、同步/异步通信、Schema、通道和通信协议
- 共享/私有 Context、State、Memory、所有权、一致性、隔离和冲突解决
- 协调、同步、锁、投票、共识和全局计划
- 冲突、竞争、谈判、辩论、激励、对抗和利益对齐
- 结果聚合、交叉审查、Critic/Verifier、裁决和证据合并
- 身份、信任、权限、隔离、数据泄露和 Agent 间 Prompt Injection
- 超时、重试、取消、幂等、部分失败、级联故障、降级和恢复
- Token、Tool、并发、配额、速率、预算、成本、负载和公平性
- 跨 Agent Tracing、消息链路、因果关系、状态快照、审计、调试和 Replay
- 团队级 HITL、人工升级、人工裁决、接管、审批和恢复
- Multi-Agent 评测方法：协作质量、通信成本、重复劳动、状态一致性、故障传播、恢复、安全和整体效率

### 1.2 资料目标

资料分为四层：

~~~text
arXiv PDF 原件
  → Archive v2 可验证事实包
    → Evidence v3 可重建论文资料
      → Knowledge 人工确认的综合知识
~~~

本库研究“如何构建和评测 Multi-Agent 系统”，不收集 Benchmark 数据集、排行榜或单次评测结果。Benchmark 仅在论文用于解释评测协议时保留方法定义和出处。

### 1.3 复用目标

- 共享 FSD/Agent 的 paper 模块，不复制 Multi-Agent 专用采集、下载、解析或发布程序。
- 只用方向配置表达 Multi-Agent 的查询、配额、筛选词和 PDF 分类。
- 保持 FSD、Agent Engineering 和 Multi-Agent Engineering 的运行状态与文件根完全隔离。
- 沿用现有确定性、幂等性、检查点、版本保留和 Evidence 发布约束。

## 2. 非目标

- 不实现可运行的 Multi-Agent 产品或编排 Runtime。
- 不把单个 Agent 的基础实现完整复制到本库；基础概念引用 Agent Engineering。
- 不自动采集官方文档、协议、规范、网页、代码仓库、commit、Release、博客或社区内容。
- 不使用 `source-policy.yaml`、`topic-taxonomy.yaml` 或 `library_kind: research`。
- 不新增 Multi-Agent 专用 Discovery Adapter、Fetcher、Archive 或 Evidence Publisher。
- 不扩展现有 Evidence v3 Schema 来保存拓扑、消息或共享状态的结构化记录；这些综合信息进入人工 Knowledge。
- 不建立跨库 Source Identity、Content Hash 或 Evidence 关联基础设施。
- 不创建第二套任务恢复、锁、SQLite、MinerU 和发布基础设施。
- 不让知识引擎自主执行用户代码、工具或外部 Agent。
- 不让自动发布器创建或覆盖人工 `Knowledge/`。

## 3. 命名、路径与隔离

| 用途 | 目标路径 |
|---|---|
| 方向库标识 | `multi-agent-engineering` |
| 方向库名称 | Multi-Agent Engineering（Multi-Agent 工程知识库） |
| 共享引擎代码 | `D:/agent-data/backend/projects/paper-knowledge-engine` |
| 方向配置 | `D:/agent-data/backend/projects/paper-knowledge-engine/config/multi-agent-engineering` |
| PDF 原件 | `D:/paper/paper-knowledge-engine/multi-agent-engineering` |
| 活跃运行数据 | `D:/agent-data/data/paper-libraries/multi-agent-engineering` |
| 备份根 | `D:/agent-data/backups/paper-libraries/multi-agent-engineering` |
| Obsidian Vault | `D:/obsidian/data/paper-knowledge-engine/multi-agent-engineering` |

所有绝对路径继续由 `machine.local.yaml` 中的根路径和 `libraryId` 派生；业务代码不得硬编码 Multi-Agent 方向名或机器绝对路径。

三个方向只共享代码和配置契约，不共享以下状态：

- `library.sqlite`
- `archive/`、`runs/`、`operations/` 和 `work/`
- PDF 根和分类目录
- 任务水位、冻结选择集、检查点、锁和配额
- Vault、Evidence、发布回执和人工 Knowledge

## 4. 架构决策

### 4.1 采用现有 paper 模块

Multi-Agent Engineering 与 FSD、Agent Engineering 的关系如下：

~~~text
paper-knowledge-engine
  └─ shared paper modules
      ├─ fsd configuration
      ├─ agent-engineering configuration
      └─ multi-agent-engineering configuration
~~~

`PaperLibraryConfig` 是方向配置接入共享 paper 模块的既有接口。每个方向的四个 YAML 文件是该接口的配置适配器。Multi-Agent 已经是第三个真实 paper 方向，不需要再为它引入一层抽象或专用转发模块。

### 4.2 共享执行链路

`current` 和 `weekly` 必须进入与 FSD/Agent 相同的执行链路：

~~~text
loadEngineContext(kind = paper)
  → buildHarvestPlan
    → runHarvestShards (OpenCLI / arXiv)
      → 去重与规则筛选
        → 冻结本次论文选择集
          → downloadAcceptedPdf
            → MinerU
              → Archive v2
                → Evidence v3
~~~

Multi-Agent 方向只提供不同的 Track、查询、配额、筛选词和分类映射。网络策略、arXiv 冷却、重试、检查点、PDF 下载、MinerU 会话、Archive 校验、Evidence 原子替换与索引渲染全部复用现有实现。

### 4.3 与 Agent Engineering 的领域关系

~~~text
agent-engineering
  └─ 单 Agent 的 Harness、Runtime、Loop、Tool、Context、Memory、权限和评测

multi-agent-engineering
  └─ 多 Agent 的拓扑、角色、委派、通信、协调、故障和群体评测
~~~

论文同时覆盖两个领域时，可以被两个方向各自的查询命中；每个方向独立发现、筛选、存储和计数。本阶段不新增跨库去重或关联机制。人工 Knowledge 可以用普通链接引用另一个 Vault 中的相关论文或概念。

User、Account、Tenant、Organization、Team、基础 RBAC/ABAC、资源所有权、配额和审计属于 Agent Engineering。本库只研究这些身份如何参与 Agent 团队的委派、审批、授权、共享状态、人工接管和责任追踪。

## 5. 领域边界与固定 Track

### 5.1 Multi-Agent 系统边界

论文主题只有同时满足以下条件，才应被 Multi-Agent 规则接受：

1. 至少存在两个具有独立 Context、State 或决策边界的 Agent Node。
2. Agent 之间存在委派、消息、共享状态或显式协调关系。
3. 研究问题涉及 Agent 间关系或整体行为，而不只是单个 Agent 的 Tool 调用。

单 Agent 调用多个 Tool、简单并行请求、没有协作关系的模型集合不归入 Multi-Agent。人类用户不是 Agent Node；只有参与团队审批、授权、接管或共享边界时，才作为 Human Oversight 参与者记录。

### 5.2 固定 18 个 Track

| Track ID | PDF 分类目录 | 研究范围 |
|---|---|---|
| `mas-foundations` | `01-MAS-Foundations` | 定义、边界、基本假设、系统类型和问题建模 |
| `mas-topology` | `02-MAS-Topology` | Hierarchy、Supervisor-Worker、Pipeline、Swarm、P2P、Blackboard、Graph |
| `mas-roles-capabilities` | `03-MAS-Roles-Capabilities` | 角色、能力、身份、专业化、能力发现和动态分配 |
| `mas-lifecycle-composition` | `04-MAS-Lifecycle-Composition` | Agent 创建、销毁、休眠、唤醒和运行时组合 |
| `mas-task-decomposition` | `05-MAS-Task-Decomposition` | 子任务建模、依赖、分派和路由 |
| `mas-delegation-handoff` | `06-MAS-Delegation-Handoff` | 委派、交接、契约、预算、取消和失败语义 |
| `mas-planning-scheduling` | `07-MAS-Planning-Scheduling` | 联合规划、调度、并行执行、资源竞争和关键路径 |
| `mas-communication` | `08-MAS-Communication` | 消息、事件、Schema、通道和同步/异步协议 |
| `mas-shared-state-memory` | `09-MAS-Shared-State-Memory` | 共享/私有状态、Memory、所有权、一致性和冲突解决 |
| `mas-coordination-consensus` | `10-MAS-Coordination-Consensus` | 同步、屏障、锁、投票、共识和全局计划 |
| `mas-conflict-negotiation` | `11-MAS-Conflict-Negotiation` | 冲突、竞争、谈判、辩论、激励、对抗和利益对齐 |
| `mas-synthesis-verification` | `12-MAS-Synthesis-Verification` | 聚合、交叉审查、Critic/Verifier、裁决和证据合并 |
| `mas-security-governance` | `13-MAS-Security-Governance` | 身份、信任、权限、隔离、泄露和 Agent 间 Prompt Injection |
| `mas-fault-tolerance` | `14-MAS-Fault-Tolerance` | 超时、重试、取消、幂等、部分失败、级联故障和恢复 |
| `mas-resource-governance` | `15-MAS-Resource-Governance` | Token、Tool、并发、配额、预算、成本、负载和公平性 |
| `mas-observability` | `16-MAS-Observability` | 跨 Agent Trace、因果关系、快照、审计、调试和 Replay |
| `mas-human-oversight` | `17-MAS-Human-Oversight` | 人工升级、裁决、接管、审批和恢复 |
| `mas-evaluation-methodology` | `18-MAS-Evaluation-Methodology` | 协作质量、通信成本、一致性、故障传播、恢复、安全和效率评测 |

未能可靠映射 Track 的手工导入 PDF 使用 `99-Unclassified`。自动 arXiv 任务中的论文必须先通过规则筛选；命中多个 Track 时只选择一个主分类保存 PDF，但保留全部 `matchedTracks`。

## 6. 来源、身份与选择策略

### 6.1 自动来源边界

自动发现唯一允许的外部来源是 arXiv：

- 通过现有 OpenCLI arXiv harvest 实现检索。
- 每个 Track 配置 `categories` 和 `date_modes: [submitted, updated]`。
- 初始日期与 Agent Engineering 对齐为 `2026-01-01`。
- arXiv 摘要页、API 元数据和 PDF 视为同一论文来源链路，不算多来源采集。
- 不为其他域名配置抓取器、允许列表或来源类型配额。

`import-local`/`parse-local` 只接收用户明确提供的本地 PDF，并复用 paper 模块的 `local_pdf` 归档行为。手工导入不参与 arXiv 水位推进，也不构成官方文档、仓库或网页自动采集入口。

### 6.2 论文身份和版本

沿用现有论文身份规则：

~~~text
baseId       = arXiv 论文稳定身份
version      = arXiv v1/v2/... 版本
content hash = Archive 文件完整性与幂等发布依据
~~~

- 同一 `baseId/version` 重复运行不会产生重复 Archive 或 Evidence。
- arXiv 新版本形成新的 `<baseId>-v<version>` 目录，不覆盖旧版本。
- 同一论文命中多个 Track 只按唯一 `baseId/version` 计数一次。
- 任务输出继续区分候选数、接受数、新版本数、归档数和发布数。

### 6.3 初始配额

- `current_task.max_papers: 180`
- 18 个 Track 的 `track_limits` 初始各为 10
- `weekly_schedule.max_papers: 18`
- `overlap_hours: 48`
- `download_after_hard_filter: true`

配额属于方向配置，可在不修改共享代码的前提下调整。Track 限额在身份去重后应用，不能把同一论文的多 Track 命中重复计入配额。

## 7. 配置契约

目标配置目录只包含 paper 方向需要的四个文件：

~~~text
config/multi-agent-engineering/
├─ library.yaml
├─ query-matrix.yaml
├─ paper-policy.yaml
└─ categories.yaml
~~~

- `library.yaml`：声明 `library_kind: paper`、方向身份、起始日期、重叠窗口、Current 配额和 Weekly 调度。
- `query-matrix.yaml`：声明 18 个 Track 的 arXiv 查询、arXiv 分类和 `submitted/updated` 日期模式。
- `paper-policy.yaml`：沿用 FSD/Agent 的筛选接口，配置 Multi-Agent 术语、工程任务词、变体和 Track 优先级。
- `categories.yaml`：声明 18 个 Track 的 PDF 目录和 `99-Unclassified`。

不得创建以下旧 Research 配置：

- `source-policy.yaml`
- `topic-taxonomy.yaml`
- `synthesis-policy.yaml`

Multi-Agent 的研究本体继续由本文和人工 Knowledge 表达，不扩展运行时配置加载器来承载新的结构化本体。

## 8. 运行数据、Archive 和 Vault

### 8.1 方向运行区

~~~text
D:/agent-data/data/paper-libraries/multi-agent-engineering/
├─ library.sqlite
├─ archive/
│  └─ <base-id>-v<version>/
├─ runs/
├─ operations/
└─ work/
~~~

每个 Archive v2 论文包沿用现有文件契约：`source.pdf`、`document.md`、`pages.json`、`content-list.json`、`source.json`、`manifest.json` 和可选 `assets/`。

### 8.2 PDF 原件

~~~text
D:/paper/paper-knowledge-engine/multi-agent-engineering/
├─ 01-MAS-Foundations/
├─ ...
├─ 18-MAS-Evaluation-Methodology/
└─ 99-Unclassified/
~~~

论文 PDF 只按主 Track 保存一份，不因多个 `matchedTracks` 复制到多个目录。

### 8.3 Obsidian Vault

~~~text
D:/obsidian/data/paper-knowledge-engine/multi-agent-engineering/
├─ .obsidian/
├─ Evidence/
│  ├─ papers/
│  │  └─ <base-id>-v<version>/
│  │     ├─ paper.md
│  │     ├─ pages.md
│  │     ├─ source.pdf
│  │     └─ assets/
│  └─ indexes/
│     ├─ authors.md
│     ├─ categories.md
│     ├─ tracks.md
│     └─ years.md
└─ Knowledge/                  # 人工拥有，自动发布器不创建或覆盖
~~~

Evidence 只能由通过校验的 Archive v2 确定性重建。Multi-Agent 不新增拓扑、角色或协调专用索引；18 个 Track 统一出现在共享 `tracks.md` 中。

## 9. 任务模式与 CLI

### 9.1 自动论文任务

- `current`：从上次成功水位或配置起始日期发现 arXiv 新论文和新版本。
- `weekly`：使用独立 Weekly 配额定期补充，仍只查询 arXiv。
- 两种模式都在身份去重后冻结本次选择集，并从同一检查点恢复。

paper 方向不支持 Research `backfill`。若未来需要历史补录，应先设计 paper 方向的显式日期窗口能力，不能借用 Research workflow 或隐式移动 Current 水位。

### 9.2 复用的命令

Multi-Agent Engineering 应与 FSD/Agent 使用同一组 paper 命令：

~~~powershell
bun src/cli.ts --library multi-agent-engineering harvest-plan --mode current --format json
bun src/cli.ts --library multi-agent-engineering mineru-config --format json
bun src/cli.ts --library multi-agent-engineering arxiv-check --format json
bun src/cli.ts --library multi-agent-engineering schedule-config --format json
bun src/cli.ts --library multi-agent-engineering run-task --mode current
bun src/cli.ts --library multi-agent-engineering run-task --mode weekly
bun src/cli.ts --library multi-agent-engineering import-local --path ABSOLUTE_PATH
bun src/cli.ts --library multi-agent-engineering parse-local --base-id BASE_ID
bun src/cli.ts --library multi-agent-engineering evidence-publish --run-id RUN_ID
bun src/cli.ts --library multi-agent-engineering reconcile
~~~

以下 Research 命令不得对该方向开放：

- `source-config`
- `import-source`
- `run-task --mode backfill`

## 10. Evidence 与 Knowledge 内容契约

### 10.1 Evidence v3

自动发布只使用共享论文 Evidence v3 契约，不增加 Multi-Agent 专用字段。每个论文页面至少从 Archive 呈现：

- arXiv `baseId`、版本、标题、作者、分类、发布时间和更新时间
- 主 Track、全部 `matchedTracks`、PDF 哈希和解析器信息
- MinerU 正文、分页文本、PDF 阅读副本和必要资源
- Archive manifest 哈希与可验证来源关系

论文中的 Agent Node、Topology、Delegation、Message、State、Coordination 或 Evaluation 内容保留在正文中，供引用和人工整理；自动发布器不把模型推断伪装成结构化 Evidence。

### 10.2 Knowledge

人工 Knowledge 可以进一步维护：

- Multi-Agent 术语表和系统边界
- 拓扑页、角色卡、委派/通信模式和共享状态矩阵
- 协调、冲突、故障、安全和人工接管模式
- 评测对象、单位、场景、故障模型、判定器、指标和 Replay/Regression 方法
- 跨 Agent Engineering 与 Multi-Agent Engineering 的普通引用

每个 Knowledge 结论必须引用具体 Evidence 论文及可定位内容。未确认的总结标记为 `unverified`，普通 Evidence 发布不能覆盖人工文件。

## 11. 分阶段建设路线

### Phase 0：本设计

- 固定 paper-only 与 arXiv-only 自动采集边界。
- 固定 18 个 Track、PDF 分类、初始配额和手工 PDF 导入例外。
- 明确完整复用 FSD/Agent paper 模块，不建设 Multi-Agent Research workflow。

### Phase 1：方向配置

- 创建 `config/multi-agent-engineering/` 的四个 paper 配置文件。
- 配置 18 个 arXiv Track、筛选策略、PDF 分类和 Weekly 调度。
- 使用现有配置加载器加载为 `PaperLibraryConfig`；除非测试发现真正缺口，不修改加载器接口。

### Phase 2：路由与隔离验证

- 验证方向出现在库选择列表和交互菜单中。
- 验证 `current`/`weekly`、MinerU、本地 PDF 导入和 Evidence 命令进入 paper 分支。
- 验证 Research `backfill`、`source-config` 和 `import-source` 被拒绝。
- 验证 FSD、Agent 和 Multi-Agent 的 SQLite、PDF、Archive、Vault、水位和锁互不交叉。

### Phase 3：共享论文链路验证

- 验证 18 个 Track 生成 `submitted/updated` 共 36 个 harvest shard。
- 验证 Multi-Agent 使用现有 OpenCLI/arXiv 网络、冷却、重试和检查点行为。
- 验证选择冻结、PDF 下载、MinerU、Archive v2 和 Evidence v3 端到端行为。
- 验证同一论文多 Track 命中、重复运行和 arXiv 新版本的计数与版本语义。

### Phase 4：文档与人工 Knowledge

- 更新 README、配置说明和 CONTEXT 中的方向列表、命令、路径和边界。
- 建立人工 Knowledge 的术语、拓扑、协作、故障、安全和评测目录；不修改 Evidence Publisher 的所有权范围。

## 12. 验收门槛

- `multi-agent-engineering` 能以 `library_kind: paper` 被现有加载器识别。
- 方向配置只包含四个 paper YAML 文件，不依赖 Research 配置。
- 所有自动网络发现只使用 OpenCLI/arXiv；不会抓取官方文档、规范、仓库、Release、博客或网页。
- 手工 `import-local`/`parse-local` PDF 继续可用，且不改变 arXiv 水位。
- 18 个 Track 均可生成 arXiv `submitted/updated` shard、参与筛选并映射 PDF 分类。
- Multi-Agent 不新增专用 Harvester、Adapter、Downloader、MinerU、Archive、Publisher 或索引器。
- `current`/`weekly` 使用与 FSD/Agent 相同的 paper 执行路径；Research `backfill` 和来源命令不可用。
- FSD、Agent Engineering 和 Multi-Agent Engineering 的配置、任务、SQLite、路径、水位、锁、Archive、Evidence 和 Knowledge 互不回归。
- 同一 `baseId/version` 重复运行不会产生重复 Archive、PDF 或 Evidence；同一论文多 Track 命中只计数一次。
- arXiv 新版本形成新 Archive/Evidence 版本，不覆盖旧版本。
- Archive v2 通过 manifest/hash 校验，Vault 可由 Archive 确定性重建。
- Evidence v3 只包含共享论文契约，生成 authors/categories/tracks/years 四类索引。
- 任务中断后能够从冻结选择集、下载结果和 Archive 检查点恢复。
- 自动发布器只拥有 `Evidence/`，不会创建或覆盖人工 `Knowledge/`。
- 现有 FSD 和 Agent paper 配置、CLI、harvest、MinerU、Archive 与 Evidence 测试继续通过。

本文只确认目标设计，不授权直接修改运行代码。进入实现前应单独生成实施计划和测试步骤。
