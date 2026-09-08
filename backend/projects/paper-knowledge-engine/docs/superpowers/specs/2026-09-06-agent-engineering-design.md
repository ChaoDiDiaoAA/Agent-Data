# Agent Engineering（Agent 工程）知识库目标设计

## 状态

- 设计对象：agent-engineering 方向库
- 显示名称：Agent Engineering（Agent 工程）知识库
- 设计日期：2026-09-06
- 当前状态：历史目标方案；Agent 的活动实现已按 2026-09-07 纸质论文库决策收敛
- 适用引擎：现有 paper-knowledge-engine

## 范围修订（2026-09-07）

Agent Engineering 的活动实现只从 2026-01-01 起通过 OpenCLI 获取 arXiv 论文，并使用与 FSD 相同的 `paper` 配置、发现、去重、PDF 下载、MinerU、Archive v2 和 Evidence v3 流程。本文后续关于官方文档、规范、仓库、Release、本地资料和独立 Research workflow 的内容保留为历史设计记录，不代表当前 Agent 配置或 CLI 行为；通用 `src/research/` 能力仅供未来独立 Research 方向使用。

本设计建立一个与 FSD 并行、并与 Multi-Agent Engineering 兄弟库分离的研究方向库。它复用引擎的方向隔离、任务恢复、操作记录、Archive、Evidence 发布和 Obsidian Vault 管理能力，但不把 Agent 资料限制为论文或 PDF。

## 1. 目标

### 1.1 研究目标

系统研究 Agent 应用的运行时和控制面，形成可引用、可版本化、可恢复的工程知识库，覆盖：

- Agent Harness、Control Loop 和 Orchestration
- Agent Loop：observe/plan/act/reflect、终止条件、循环不变量、重试、递归和失控检测
- Agent Runtime、执行模型和生命周期
- Tool、Tool Calling、Tool Registry
- MCP 的 Tools、Resources、Prompts、Transport 和权限边界
- Context Engineering、Prompt Architecture 和上下文预算
- Memory、State、Session、Checkpoint、Replay
- Guardrails、Policy、权限和安全控制
- 权限与授权：身份、能力、最小权限、作用域、密钥、网络和升级审批
- 多用户与租户治理：User、Account、Tenant、Organization、Team、成员、角色、资源所有权、可见性、配额、成本归属、审计和合规
- HITL、审批、人工接管和异常恢复
- Sandbox、进程/文件/网络隔离和资源限制
- Agent 评测方法：评测目标、测试层级、评测单位、轨迹/任务/会话协议、指标、判定器、人工评审、模型评审、回放、回归、红队和安全评测
- Tracing、Observability、Reliability、成本和性能

### 1.2 产品目标

建立三层资料体系：

~~~
Source 原始来源
  → Evidence 可审计事实
    → Knowledge 人工确认的综合知识
~~~

Evidence 保存来源事实和定位信息；Knowledge 保存概念、比较、设计模式、决策记录和工程检查清单。自动生成的摘要或推断不得直接伪装成 Evidence。

### 1.3 复用目标

- 继续使用一个共享引擎，不复制一套 Agent 专用程序。
- 保留 FSD 的现有行为和数据隔离，不因新方向改写 FSD 的 Archive/Evidence 契约。
- 将采集边界从“论文/PDF”扩展为“多来源研究资料”。
- 所有采集、归档、发布、重试和恢复都具有确定性和幂等性。

## 2. 非目标

- 本阶段不实现可运行的 Agent 产品或 Agent Runtime 本身。
- 不让知识引擎自主执行用户代码、工具或外部 Agent。
- 不把所有网页、仓库和规范转换成 PDF。
- 不把 Benchmark 数据集、排行榜或单次评测结果作为本库的主体采集目标；Benchmark 仅在解释评测方法时作为协议背景引用。
- Multi-Agent 协作、拓扑、委派和群体评测属于 `multi-agent-engineering`，本库只保留必要的基础概念引用。
- 不在 Evidence 区自动写入未经人工审核的结论。
- 不立即引入私有仓库、需要凭证的内部文档或有权限风险的资料源。
- 不创建第二套任务恢复、锁、SQLite 和发布基础设施。

## 3. 命名与路径

| 用途 | 目标路径 |
|---|---|
| 方向库标识 | agent-engineering |
| 方向库名称 | Agent Engineering（Agent 工程知识库） |
| 共享引擎代码 | D:/agent-data/backend/projects/paper-knowledge-engine |
| 方向配置 | D:/agent-data/backend/projects/paper-knowledge-engine/config/agent-engineering |
| PDF 原件 | D:/paper/paper-knowledge-engine/agent-engineering |
| 活跃运行数据 | D:/agent-data/data/paper-libraries/agent-engineering |
| 备份根 | D:/agent-data/backups/paper-libraries/agent-engineering |
| Obsidian Vault | D:/obsidian/data/paper-knowledge-engine/agent-engineering |

所有绝对路径继续从 machine.local.yaml 的根路径和 libraryId 派生；业务代码不得硬编码 agent-engineering 或机器绝对路径。

PDF 原件只用于需要 PDF 的来源，例如论文、技术报告和本地 PDF。官方网页、规范、代码仓库和 Release 使用各自的来源 Archive，不强制占用 PDF 目录。

## 4. 架构决策

### 4.1 采用“通用来源层 + 方向库”

备选方案比较：

| 方案 | 优点 | 主要问题 | 决定 |
|---|---|---|---|
| 复制 FSD 配置和流程 | 初期最快 | 只能自然处理 arXiv/PDF，无法表达仓库和规范版本 | 不采用 |
| 通用来源层，复用现有引擎 | 保留恢复、锁和发布能力，能逐步接入不同来源 | 需要增加来源契约和新 Archive 适配器 | 采用 |
| 另起一套 Agent 引擎 | 自由度最高 | 重复基础设施，长期维护成本和状态分裂 | 不采用 |

### 4.2 来源处理边界

目标流水线：

~~~
Discovery Adapter
  → Source Normalizer
    → Identity / Version Resolver
      → Fetcher
        → Source Archive
          → Evidence Publisher
            → Topic / Index Builder
~~~

适配器负责协议和来源差异；规范化、身份解析、内容哈希、归档、发布和索引由共享深层模块负责。上层任务不应直接处理 HTTP、Git、HTML 或 PDF 细节。

### 4.3 两个知识库的边界

两个知识库共享 `paper-knowledge-engine` 引擎、来源适配器、ResearchSource/SourceVersion 契约、内容哈希和引用格式，但不共享方向级运行状态：

~~~
paper-knowledge-engine
  ├─ agent-engineering
  │   └─ 单 Agent 的 Harness、Runtime、Loop、Tool、Context、Memory、权限和评测
  └─ multi-agent-engineering
      └─ 多 Agent 的拓扑、角色、委派、通信、协调、故障和群体评测
~~~

每个知识库独立拥有配置、SQLite、runs、operations、Archive、PDF 根和 Obsidian Vault。共享代码不等于共享数据；跨库关联通过稳定的 `Source Identity`、`Content Hash`、概念 ID 和来源引用建立。

来源同时覆盖两个领域时，使用“主知识库 + 关联知识库”规则：来源的主要研究问题决定主库，另一库只建立关联 Evidence 或引用，不因跨库关联重复计数。后续可以增加共享的内容寻址缓存，但不把它变成第三个知识库。

## 5. 领域模型

### 5.1 资料领域对象

| 对象 | 含义 |
|---|---|
| ResearchSource | 一个可研究的来源，如论文、规范、文档或仓库 |
| SourceVersion | 来源的具体版本、提交号、Release 或抓取修订 |
| EvidenceArtifact | 来源版本中的原始或规范化文件 |
| CitationLocator | 页码、章节、标题、文件路径、行号或提交号等定位信息 |
| Topic | 主题 Track 和分类标签 |
| Concept | 领域术语及其边界、别名和关系 |
| Pattern | 可复用的架构或工程模式 |
| Decision | 面向本项目的设计判断、取舍和适用条件 |
| Claim | Knowledge 中可被 Evidence 支撑的陈述 |

Claim 必须指向一个或多个 CitationLocator。没有来源定位的内容只能作为待验证笔记，不能进入托管 Evidence。

### 5.2 Agent Runtime 研究模型

~~~
Session
  └─ Run
      └─ Turn
          ├─ Model Call
          ├─ Tool Call
          └─ Human Approval

Run → State Events
Run → Trace Spans / Events
State + Memory + Tool Metadata + Prompt Policy → Context
~~~

边界定义：

- **Harness**：控制循环、上下文组装、模型决策、工具调用、状态提交和策略执行的协调层。
- **Runtime**：执行模型调用、工具、沙箱和任务进程的运行环境。
- **Session**：面向用户或业务目标的交互范围。
- **Run**：一次可恢复、可重放的执行实例；不要与知识引擎的 Harvest Run 混淆。
- **Turn**：一次模型决策周期，可能触发多个工具调用。
- **State**：保证任务能够恢复的权威运行事实。
- **Memory**：经过选择和保留策略处理、可影响未来 Run 的信息。
- **Context**：一次模型调用实际接收的材料，是动态组装结果。
- **Tool**：可被调用的能力；MCP 是承载和发现能力的协议，不是 Memory 或 Session。
- **Guardrail**：在关键边界执行的确定性或策略性校验。
- **HITL**：具备请求、决策、超时、结果和审计信息的人类参与事件。
- **Sandbox**：限制文件、进程、网络、权限和资源的执行环境。
- **Trace**：描述因果链、耗时、成本、输入输出和错误的观测记录，不等于 State。

### 5.3 Identity、Tenancy 与 Governance 模型

~~~
Identity / Subject
  └─ Membership / Role / Policy
      └─ Tenant / Organization / Team
          └─ Owned Resources
              ├─ Session / Run
              ├─ Context / Memory / State
              └─ Tool / Data / Workspace
~~~

边界定义：

- **Identity / Subject**：用户、服务身份、Agent 或其他能够被授权、审计和追责的主体。
- **Tenant / Organization / Team**：资源所有权、数据隔离、成员关系和治理策略的边界。
- **Membership / Role**：主体与组织或团队的关系，以及由此获得的角色和权限集合。
- **Resource Ownership**：Session、Run、Memory、State、Tool、数据和 Workspace 的拥有者、可见范围和共享规则。
- **Governance**：账号生命周期、邀请/移除、配额、成本归属、审计、合规和策略变更。

多用户管理的主体是人、组织和租户，归入 Agent Engineering；Multi-Agent 只研究这些主体如何参与 Agent 团队的审批、授权、共享和接管。

### 5.4 Agent 评测方法模型

评测资料不以“最终得分”为中心，而以可解释、可复现的评测方法为中心：

~~~
Evaluation Target
  → Evaluation Unit
    → Protocol / Fixture / Scenario
      → Observation / Trace
        → Judge / Rubric
          → Metrics / Thresholds
            → Replay / Regression / Decision
~~~

每张评测方法卡至少回答以下问题：

| 维度 | 要回答的问题 |
|---|---|
| 评测对象 | 评测模型、Tool、Prompt、Context、Memory、Guardrail、Agent Loop、Run 还是 Session？ |
| 评测单位 | 观察 step、turn、trajectory、task、session，还是一组运行样本？ |
| 测试方法 | 使用确定性夹具、场景模拟、Trace Replay、故障注入、对抗/红队、人工评审、程序判定还是模型辅助判定？ |
| 观测材料 | 只看最终输出，还是同时检查 Tool Call、Context、State、权限决策、消息、委派、Trace 和副作用？ |
| 判定规则 | 什么算成功、失败、部分成功、违规、不可判定或需要人工升级？阈值和例外是什么？ |
| 指标体系 | 任务达成、输出正确性、Tool 正确性、轨迹效率、可靠性、安全、权限合规、成本、延迟和人工介入如何定义？ |
| 复现与回归 | 如何固定版本、配置、夹具、环境和 Trace，如何重放失败样例并比较修复前后行为？ |

本方向库只保存上述方法定义、协议、判定器、指标和引用定位；测试夹具、运行样本或结果文件只有在用户明确要求且服务于方法复现时才作为附属材料，不形成 Benchmark 数据集或排行榜结果库。

## 6. 研究主题与 Track

第一版固定以下 15 个顶层 Track ID，避免使用模糊的自由标签。Agent Loop、权限、多用户治理和 Agent 评测方法单独建 Track，不隐藏在相邻主题下面。Multi-Agent 主题属于兄弟知识库。Benchmark 只作为评测方法中的一种协议形式，不作为资料采集目标：

| Track ID | 研究范围 |
|---|---|
| harness-control-loop | Harness 架构、编排、控制边界、规划/执行、事件驱动 |
| agent-loop | Observe/Plan/Act/Reflect、循环迭代、终止、重试、递归、循环不变量和失控检测 |
| runtime-execution | Runtime、模型调用、执行生命周期、并发、恢复 |
| tool-mcp | Tool Calling、Schema、Registry、MCP Tools/Resources/Prompts |
| context-prompt | Context Assembly、Prompt 层级、预算、压缩、检索 |
| memory-state-session | Memory、State、Session、Checkpoint、Replay、Branching |
| guardrails-policy | Guardrails、策略、验证、拒绝和审计 |
| permissions-authorization | Agent/Tool 的身份、能力、最小权限、资源作用域、密钥、网络和权限升级 |
| identity-tenancy-governance | User、Account、Tenant、Organization、Team、成员、角色、资源所有权、可见性、配额、成本、审计和合规 |
| hitl-approval | Human-in-the-loop、审批、接管、超时和恢复 |
| sandbox-isolation | Sandbox、文件/进程/网络隔离、资源和密钥边界 |
| testing-evaluation | 单元、组件、集成、端到端、轨迹、回放、对抗和安全测试 |
| agent-evaluation-methodology | Agent 评测方法：评测目标、评测单位、测试层级、轨迹/会话分析、判定器、人工评审、模型评审、回放、回归、红队、安全、成本和延迟 |
| tracing-observability | Tracing、日志、Span/Event、审计、可重放性和观测指标 |
| reliability-operations | 可靠性、幂等、重试、成本、延迟、部署和故障分析 |

来源可同时命中多个 Track，但必须记录主 Track 和辅助 Track，避免“累计去重”时重复计算同一来源。

其中，`testing-evaluation` 关注测试如何执行和验证运行时行为；`agent-evaluation-methodology` 关注如何定义 Agent 的评测对象、评测单位、判定方法和可解释的指标体系，二者允许同一来源同时命中。

每个来源还应附加五个正交维度：

1. 生命周期阶段：请求接入、Session/Run 创建、Context 构建、模型调用、Tool 执行、HITL、State/Memory 提交、Trace、Replay/Eval。
2. 控制边界：生成、执行、持久化、观测、安全。
3. 证据等级：官方规范/源码、论文/技术报告、评测方法/工程案例、工程文章、社区讨论。
4. 测试层级：单元、组件、集成、端到端、轨迹回放、红队/对抗、安全和压力测试。
5. 评测方法维度：评测对象（模型、Tool、Agent Loop、Run 或 Session）、评测单位（step、turn、trajectory、task 或 session）、判定方式（规则、程序、人工或模型辅助）、指标（任务成功、Tool 正确性、轨迹效率、安全、可靠性、成本和延迟）以及回放/回归策略。

权限资料还应记录权限主体、能力、资源作用域、授予条件、拒绝条件、审批点和审计结果。Agent Loop 资料还应记录每次迭代的输入、动作、观察、终止判定和最大迭代边界。

本库研究“如何评测 Agent”，不下载或长期维护 Benchmark 数据集、排行榜和单次评测结果；只有当这些内容用于解释评测方法时，才记录其方法定义、协议和出处。

## 7. 来源范围与版本策略

### 7.1 来源类型

第一阶段支持以下类型：

- paper：arXiv 或其他公开论文
- technical-report：技术报告和研究报告
- official-doc：官方文档
- specification：协议、规范、RFC 或标准
- repository：公开代码仓库的固定 commit/tag
- release：版本发布说明和变更记录
- evaluation-method：Agent 评测方法论文、评测框架文档、测试协议、指标/判定器设计、轨迹回放、回归、红队和安全评测方法
- local-artifact：用户明确导入的本地资料

### 7.2 来源优先级

~~~
官方规范 / 官方文档 / 源码 / Release
    > 论文 / 技术报告
    > 评测方法 / 工程案例
    > 博客 / 社区讨论
~~~

安全、权限、Sandbox、Guardrails 和 Runtime 行为类结论，优先要求一手来源。博客和社区内容可以作为发现线索，但不能单独支撑高风险工程结论。

### 7.3 身份、版本和去重

身份去重和内容去重分开：

~~~
Source Identity = 这是什么来源
Source Version  = 该来源的哪个版本
Content Hash    = 当前内容是否完全相同
~~~

建议身份规则：

- 论文：arxivId + version
- 仓库：规范化仓库 URL + commit 或 tag
- 文档：规范化 URL + 文档版本或可用的修订标识
- 规范：规范名称 + 版本
- Release：项目名称 + Release 版本
- 评测方法：方法名称 + 版本/修订；必要时关联其引用的 Benchmark，但不把数据集或排行榜作为本库主体来源

同一来源的新版必须保留版本关系；相同内容的不同入口可以共享内容哈希，但不能覆盖来源身份和出处。

本库不收集 Benchmark 数据集、排行榜分数或单次评测结果作为主体资料。只有在解释评测方法时，才记录任务定义、评测单位、测试协议、指标、判定器、人工/模型评审、轨迹回放、回归和安全测试方法，并保留出处与版本。

任务输出应分别统计：候选数、接受数、新来源版本数、实际归档数、Evidence 发布数。候选数不等于下载数，也不等于去重后的新资料数。

## 8. 配置目标

目标配置目录：

~~~
config/agent-engineering/
├─ library.yaml
├─ query-matrix.yaml
├─ source-policy.yaml
├─ topic-taxonomy.yaml
└─ synthesis-policy.yaml       # Knowledge 层启用后增加
~~~

职责：

- library.yaml：身份、日期范围、任务配额、调度和来源总策略。
- query-matrix.yaml：论文、技术报告和公开来源的检索 Track。
- source-policy.yaml：来源类型、允许域名、版本规则、内容保留和去重策略。
- topic-taxonomy.yaml：Track、概念、生命周期和控制边界。
- synthesis-policy.yaml：Knowledge 层的人工审核状态、引用要求和发布边界。

现有 FSD 的 paper-policy.yaml 和 categories.yaml 不直接复制到新库；Agent Engineering 需要来源类型和主题本体，而不是只按 PDF 分类目录组织。

## 9. 运行数据和 Vault 布局

### 9.1 方向运行区

~~~
D:/agent-data/data/paper-libraries/agent-engineering/
├─ library.sqlite
├─ archive/
│  └─ sources/
│     ├─ papers/
│     ├─ official-docs/
│     ├─ specifications/
│     ├─ repositories/
│     └─ releases/
├─ runs/
├─ operations/
└─ work/
   ├─ downloads/
   ├─ fetches/
   ├─ parsing/
   ├─ publishing/
   └─ diagnostics/
~~~

每个来源版本的 Archive 应包含来源元数据、规范化内容、必要原始文件、manifest、内容哈希和 provenance。成功任务清理可重建的工作目录，不清理 Archive、Evidence 和外部 PDF 原件。

### 9.2 Obsidian Vault

~~~
D:/obsidian/data/paper-knowledge-engine/agent-engineering/
├─ .obsidian/
├─ Evidence/                    # 发布器排他拥有
│  ├─ sources/
│  │  ├─ papers/
│  │  ├─ official-docs/
│  │  ├─ specifications/
│  │  ├─ repositories/
│  │  └─ releases/
│  └─ indexes/
│     ├─ topics.md
│     ├─ source-types.md
│     ├─ lifecycles.md
│     └─ concepts.md
└─ Knowledge/                   # 用户/人工知识层拥有
   ├─ glossary/
   ├─ topics/
   ├─ patterns/
   ├─ decisions/
   ├─ matrices/
   └─ checklists/
~~~

Evidence 只能由来源 Archive 确定性重建；Knowledge 可引用 Evidence，但不由 Evidence 发布器直接覆盖。

## 10. 任务模式

### Current

用于增量收集：

- 从上次成功水位或配置起始日期发现新来源。
- 优先处理新论文、新版本、文档变更、仓库 Release 和重要 commit。
- 在身份去重后才按配额固定本次来源集合。
- 失败恢复使用相同的固定集合和检查点。

### Weekly

用于定期扩展和更新：

- 按 Track 配额平衡来源类型。
- 更新旧来源版本，同时补充新来源。
- 生成主题覆盖统计和待审清单。
- 不因同一来源命中多个 Track 而重复下载或重复发布。

### Backfill

用于一次性历史补录，例如某个规范、Runtime 项目或论文主题的历史版本。Backfill 必须有独立的任务 ID、范围和配额，不能隐式改变 Current 的成功水位。

## 11. Evidence 内容契约

每个 Evidence 来源页面至少包含：

- 来源身份、版本、类型和规范化 URL
- 发布者/作者、发布时间、抓取时间和内容哈希
- 主题 Track、生命周期阶段和控制边界
- 原文或规范化正文
- 页码、章节、文件路径、行号或 commit 等引用定位
- 与旧版本的版本关系和变更摘要（若存在）
- 指向本地 Archive、原始 PDF、仓库 commit 或官方页面的链接

若来源描述 Agent Loop、权限、测试评估或评测方法，还应保存对应的结构化字段：

- Agent Loop：迭代步骤、状态转换、动作/观察、终止条件、重试策略和最大迭代数。
- 权限：主体、能力、资源作用域、授权来源、审批要求、拒绝行为和审计记录。
- Identity/Tenancy：主体、Tenant/Organization/Team、成员关系、角色、资源所有权、可见性、配额、成本归属和审计要求。
- 测试评估：测试层级、评测单位、夹具/任务、预期行为、判定规则、失败样例和回放入口。
- 评测方法：评测目标、评测对象、测试层级、任务/轨迹/会话协议、指标、判定器、人工/模型评审、回放/回归、红队和安全边界。

Knowledge 页面至少包含：

- 结论或设计判断
- 适用前提和已知限制
- 引用的 Evidence 页面
- 未解决问题和待验证假设
- 最后人工审核状态

Knowledge 中的“结论”必须能够回溯到 Evidence；没有来源的内容标记为 unverified，不得进入已确认模式或决策矩阵。

## 12. 分阶段建设路线

### Phase 0：本设计

- 确认方向库名称和路径。
- 固定术语、主题 Track、来源类型和 Evidence 边界。
- 明确 FSD 继续使用现有论文契约。

### Phase 1：方向库基础

- 增加 agent-engineering 方向配置。
- 扩展配置加载器，使来源型方向可以使用 source-policy 和 topic-taxonomy。
- 创建独立数据根、PDF 根、Archive 根和 Vault 根。
- 验证 FSD 与 Agent Engineering 的状态和路径隔离。

### Phase 2：通用来源 Archive

- 引入通用 ResearchSource/SourceVersion 契约。
- 抽离来源身份、版本、内容哈希、provenance 和 manifest 逻辑。
- 保留 FSD 的 Archive v2 适配器，不做破坏性迁移。

### Phase 3：来源适配器

优先顺序：

1. arXiv 论文和技术报告
2. 官方网页和规范文档
3. Git 仓库、commit 和 Release
4. Agent 评测方法论文/文档、测试框架和本地方法资料导入；不纳入 Benchmark 数据集和排行榜采集

### Phase 4：Evidence 和索引

- 发布来源页面和来源类型索引。
- 发布 Track、生命周期、概念、权限边界、身份/租户治理、测试层级和评测方法索引。
- 增加来源版本变更对账。
- 验证 Vault 可由 Archive 确定性重建。

### Phase 5：Knowledge 层

- 建立术语表、主题页、模式卡、对比矩阵和 ADR。
- 建立 Agent Loop 模式、权限矩阵、身份/租户/角色矩阵、测试策略卡、Agent 评测方法矩阵和指标/判定器矩阵。
- 引入人工审核状态和引用完整性检查。
- 暂不允许未审核的自动总结覆盖人工 Knowledge。

## 13. 验收门槛

- agent-engineering 具有独立配置、SQLite、Archive、runs、operations、PDF 根和 Vault。
- FSD 的现有任务、路径和 Evidence 布局不发生回归。
- 同一来源版本重复运行不会产生重复 Archive 或重复 Evidence。
- 来源更新会形成新版本，不覆盖旧版本事实。
- 文档、规范和仓库不被伪装成论文或 PDF。
- Agent Loop 的迭代、终止、重试和失控边界可以被单独检索和引用。
- 权限结论包含主体、能力、资源作用域、审批和拒绝行为，不只保留一句“支持权限”。
- 多用户治理结论包含主体、Tenant/Organization/Team、成员关系、角色、资源所有权、可见性、配额、成本归属和审计边界。
- Agent 评测方法能够说明评测对象、评测单位、测试层级、协议、指标、判定器、人工/模型评审、回放/回归策略和安全边界；不要求收集 Benchmark 数据集或排行榜结果。
- 每个 Knowledge 结论都能回溯到来源定位。
- 任务中断后能够从固定来源集合、下载结果和 Archive 检查点恢复。
- 运行数据、Archive 和 Vault 文件具备 manifest/hash 校验。
- 只有确认的来源事实进入托管 Evidence；人工 Knowledge 不被普通发布覆盖。
- 能输出候选数、接受数、新版本数、归档数和发布数，避免把多 Track 命中重复计数。

## 14. 待实施前确认

以下内容在进入实现计划前需要最后确认：

1. 第一阶段是否同时采集论文、官方文档、规范和公开仓库；默认按“全部纳入、分批启用”。
2. Knowledge 是否坚持人工审核后发布；默认不把 LLM 自动总结直接写入托管区。
3. 第一批来源适配器是否按 arXiv → 官方文档/规范 → Git 仓库的顺序建设。

本设计不授权直接修改运行代码；完成方案确认后，再单独生成实现计划和测试计划。
