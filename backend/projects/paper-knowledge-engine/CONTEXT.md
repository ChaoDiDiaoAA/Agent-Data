# 个人论文知识库

本上下文描述从论文来源到 Obsidian 知识库的确定性资料处理领域。本阶段只保存和组织来源事实，不生成 LLM 内容。

## Language

**知识库引擎**:
为多个方向库提供同一套确定性发现、解析与发布能力的软件；它本身不代表任何研究方向。
_Avoid_: FSD 项目、方向 Vault、论文库实例

**方向库**:
围绕一个研究方向独立配置、运行和维护的论文资料库，拥有独立的 Obsidian Vault 与运行状态；不同方向库之间允许存在同一论文的独立副本。
_Avoid_: 01/02 目录、主题标签、共享 Vault 子目录

**方向库标识**:
方向库在任务、状态和迁移协议中的稳定短名称；当前标识为 `fsd`。
_Avoid_: projectId、代码仓库名、Vault 绝对路径

**FSD 方向库**:
当前方向库，收录面向软件开发的 AI-FSD、AI-TDD、DDD、程序分析、代码翻译、验证与评估等子主题。
_Avoid_: AI 软件工程通用库、FSD 引擎、多个子主题 Vault

**知识库主线**:
从论文发现、PDF 获取、文档解析到 Obsidian 发布的一条可恢复处理链。
_Avoid_: AI 流水线、LLM Wiki

**OpenCLI Harvest**:
由项目拥有的 OpenCLI 适配器执行的一次 arXiv 论文发现过程。
_Avoid_: OpenCLI 搜索引擎、通用资源搜索

**固定选篇**:
某次任务在下载前冻结的论文集合；恢复时保持相同成员、顺序和任务身份。
_Avoid_: 当前搜索结果、重新选篇

**解析 Archive**:
一篇论文某一版本经 MinerU 解析、验证后形成的不可变事实包，是后续发布的权威输入。
_Avoid_: Wiki、临时输出目录

**精简 Archive 包**:
Archive v2 中每篇论文版本只长期保存 manifest、来源元数据、唯一 PDF、规范 Markdown、页数据、内容列表和必要资源；成功解析的 MinerU 中间文件不属于长期事实包。
_Avoid_: MinerU 原始工作目录、诊断转储、重复 PDF 与重复图片

**MinerU 文档**:
解析 Archive 中由 MinerU 产生并归一化的完整 Markdown 正文及其资源。
_Avoid_: AI 摘要、Wiki 入口页

**Evidence 发布**:
从已验证解析 Archive 确定性生成并安装到 Obsidian 的托管文件集合。
_Avoid_: LLM Evidence、语义分析

**托管资料区**:
方向库 Vault 中由 Evidence 发布器排他维护的论文资料与紧凑索引区域；人工内容不得写入该区域。
_Avoid_: 01-Evidence、编号方向目录、人工笔记区

**方向运行区**:
一个方向库的活跃机器状态根；当前 FSD 方向使用 `D:/agent-data/data/paper-libraries/fsd`，直接包含数据库、Archive、任务记录和可回收工作区，不再增加 `state/` 包装层。
_Avoid_: 项目数据目录、Vault、备份目录

**工作区**:
方向运行区内可重建、可按生命周期自动回收的临时内容，统一位于 `work/`；测试沙箱与 Evidence 发布 staging 不得伪装成长期状态。
_Avoid_: Archive、备份、人工暂存区

**迁移快照**:
迁移前从权威运行状态生成并验证的有限期恢复副本，存放在活跃方向运行区之外。
_Avoid_: tmp 副本、Evidence staging、长期镜像

**Evidence 布局契约**:
发布器、索引渲染器、验收器和迁移工具共享的版本化路径与文件所有权规则；当前活动版本为 v3，旧版本仅由集中式迁移/历史验证适配器读取。
_Avoid_: 各模块内散落的 01-Evidence 字符串、长期双写布局

**引擎配置**:
所有方向库共享的发现、MinerU、运行时和发布行为配置，位于 `config/engine.yaml`。
_Avoid_: FSD 配置、机器绝对路径、方向查询矩阵

**机器配置**:
当前计算机独有的绝对根路径、MinerU 安装和设备位置配置，位于不提交敏感本机值的 `config/machine.local.yaml`。
_Avoid_: 方向策略、论文筛选规则、运行状态

**方向配置**:
一个方向库的身份、日期范围、Track、查询、筛选、限额、调度和 Vault 目标配置；当前位于 `config/libraries/fsd.yaml`。
_Avoid_: 引擎配置、机器配置、多个散落 YAML

**论文资料页**:
一篇论文版本在托管资料区中的可阅读入口，包含来源元数据、导航和 MinerU Markdown，并链接来源 PDF、页级引用文本与资源。
_Avoid_: Archive、JSON 调试产物、人工阅读笔记

**Wiki 入口**:
Obsidian 中组织一篇论文版本的元数据、来源链接、MinerU 文档链接和分类索引的导航页。
_Avoid_: MinerU 原文、自动摘要

**任务级 MinerU API**:
只属于一次解析操作、在该操作内被多篇论文共享的本地解析服务。
_Avoid_: 单篇临时 API、机器级常驻服务、菜单级服务

**人工知识层**:
在 L2 资料库稳定后由用户选择性维护的主题、对比、阅读笔记和研究判断集合；它引用 Evidence 来源但不由 Evidence 发布器管理。
_Avoid_: 自动生成 Wiki、Evidence 发布、LLM Wiki

**Agent Engineering 方向库**:
以 Agent Harness、Runtime、Agent Loop、Tool、MCP、Context、Prompt、Memory、State、Session、Guardrails、HITL、Sandbox、Tracing、身份/租户治理和 Agent 评测方法为研究范围的单 Agent 工程方向库；当前稳定标识为 agent-engineering，活动检索来源限定为 2026-01-01 起的 arXiv 论文。Multi-Agent 协作主题属于兄弟方向库。
_Avoid_: Agent 产品库、某个具体 Agent 框架、运行中的 Agent 服务、Multi-Agent 协作系统

**Identity / Tenancy / Governance**:
围绕 User、Account、Tenant、Organization、Team、成员关系、角色、资源所有权、可见性、配额、成本归属、审计和合规建立的多用户治理边界。
_Avoid_: 只描述 Tool 权限、只描述 Agent 间角色、没有主体和资源归属的“用户管理”

**Multi-Agent Engineering 方向库**:
以多个具有独立 Context、State 或决策边界的 Agent 组成的系统为研究范围；当前稳定标识为 multi-agent-engineering，活动实现是仅通过 OpenCLI/arXiv 自动获取论文的 paper 库。它复用 FSD/Agent 的 PDF、MinerU、Archive v2 和 Evidence v3 路径，并保留用户显式触发的本地 PDF 导入。
用户参与 Agent 团队的审批、授权、共享状态和人工接管属于本库的交叉主题，但基础用户、租户和组织定义引用 Agent Engineering。
_Avoid_: 单 Agent 的多个 Tool、简单并行请求、没有协作关系的模型集合、Research 多来源工作流

**LLM Post-Training 方向库**:
大模型后训练方向库研究预训练之后的学习方法及其数据、奖励、系统与评测；稳定标识 `llm-post-training`；与 Agent 运行时工程和 Multi-Agent 编排分开，允许交叉论文各库独立保存。
_Avoid_: 通用预训练语料/架构研究、仅做推理加速的部署工作、把 Tool 或 Multi-Agent 编排本身当作后训练方法

**Agent 方向论文来源**:
Agent Engineering 与 Multi-Agent Engineering 的活动自动来源都限定为 2026-01-01 起的 arXiv 论文。`import-local`/`parse-local` 是用户显式提供本地 PDF 的共享维护入口，不属于自动来源发现；官方文档、规范、仓库、Release、博客和网页不进入这两个方向的自动任务。
_Avoid_: 多来源 Research 方向、自动网页抓取、把本地导入计入 arXiv 水位

**来源版本**:
研究来源在特定 arXiv version、文档修订、仓库 commit/tag、规范版本或 Release 版本下的不可变身份；新版来源不得覆盖旧版事实。
_Avoid_: 当前网页快照、没有版本的 URL、内容相同就合并

**Harness**:
Agent 的控制循环、上下文组装、模型决策、工具调用、状态提交和策略执行的协调层。
_Avoid_: 模型本身、单个工具、完整业务应用

**Agent Runtime**:
执行模型调用、工具、沙箱和任务进程的运行环境；它与 Harness 协调层相关但不等同。
_Avoid_: Agent 产品 UI、某个具体厂商实现

**Agent Session**:
面向用户或业务目标的一组交互；一个 Session 可以包含多个可恢复的 Run。
_Avoid_: 单个 HTTP 请求、知识引擎 Harvest Run

**Agent Run**:
Agent Session 中一次具有固定目标、状态、Trace 和恢复边界的执行实例。
_Avoid_: 论文采集任务、单个 Model Turn

**Agent Context**:
为某次模型调用从 Session、Run、State、Memory、Tool 元数据和 Prompt 策略动态组装的输入材料。
_Avoid_: 永久 Memory、完整 Session 历史、Prompt 模板本身

**Agent Memory**:
经过选择、保留和治理、可影响未来 Run 的信息；它不等同于当前 Run 的权威 State。
_Avoid_: 全量日志、Trace、临时 Context

**Agent Trace**:
描述 Agent 执行因果链、模型调用、工具调用、审批、耗时、成本和错误的观测记录。
_Avoid_: State、审计结论、Memory

**Agent Loop**:
Agent Run 内不断执行观察、计划、行动、结果处理和终止判定的控制循环；研究时必须记录迭代边界、终止条件、重试和失控防护。
_Avoid_: 单次 Model Turn、完整 Harness、无限自动循环

**权限边界**:
Agent、用户、工具或进程对能力、资源、文件、网络、密钥和外部副作用的主体—能力—作用域—条件关系。
_Avoid_: 泛称安全、只写“有权限控制”、Sandbox 本身

**Agent 测试评估**:
对 Agent 的单元、组件、集成、端到端、轨迹回放、对抗、安全和压力行为进行验证与度量的研究对象。
_Avoid_: 单一最终分数、只测模型回答、未经协议说明的 Demo

**Agent 评测方法**:
研究如何评估 Agent 的目标、评测单位、测试层级、协议、指标、判定器、人工/模型评审、轨迹回放、回归、红队和安全边界；本库不以 Benchmark 数据集、榜单分数或单次结果为主体。
_Avoid_: 只收集排行榜、单一最终分数、未经协议说明的 Demo

**Multi-Agent System**:
由多个具备独立角色或能力边界的 Agent 通过委派、消息、共享/私有状态和协调协议共同完成任务的系统。
_Avoid_: 单个 Agent 的多个 Tool、简单并行请求、没有协作关系的模型集合

**Multi-Agent 评测方法**:
针对 Agent 间交互和整体系统行为，定义评测层级、评测单位、场景/故障模型、协作与通信指标、状态一致性、故障传播、安全、成本和 Replay/Regression 方法；不等同于收集 Benchmark 数据集或排行榜分数。
_Avoid_: 只看最终答案、只测单个 Agent、只记录一个团队总分

**Benchmark（方法语境）**:
作为一种可重复评测协议的统称；在本库中只记录其任务定义、指标和协议引用，不采集或维护其数据集和榜单结果。
_Avoid_: Benchmark 数据集仓库、排行榜快照、单次分数
