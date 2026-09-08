# 稳定 MinerU API 与确定性 Obsidian 知识库流水线

## Goal

恢复并验收一条不依赖 LLM 的确定性知识库主线：项目通过 OpenCLI 的自有 arXiv 适配器发现论文，下载并复用 PDF，使用本地 MinerU 的任务级固定 API 完成解析，将可验证的解析产物和普通 Wiki 发布到 Obsidian，并能在中断后从原任务检查点继续。

## Background

- 当前生产链路已经具备 OpenCLI/arXiv 发现、确定性筛选、PDF 下载、MinerU Archive、Evidence 发布和 Obsidian 索引，但真实 MinerU 复用、进程退出和三论文恢复场景尚未完成验收。
- 旧方案把交互菜单作为 MinerU API 生命周期所有者；这使 API 清理依赖 `readline` 正常退出，并已暴露 EOF/信号后 pending 的缺陷。
- 当前“固定 API”仅表示固定 loopback 地址，不表示机器级常驻服务。
- MinerU 解析后的 Markdown 已被归一化为 Archive 中的 `normalized/full.md`；当前 Evidence 渲染会将其投影为论文目录中的 `document.md` 并重写资源链接，但这一行为尚需作为正式验收契约。

## Requirements

### 已确认的配置与归档精简（2026-09-05）

- FSD 配置归入 `config/fsd/`，拆为 `library.yaml`、`query-matrix.yaml`、`paper-policy.yaml`、`categories.yaml`；引擎和机器配置共用，旧单文件配置仅作为测试夹具保留。
- 方向选择须贯穿配置快照、CLI 与 MinerU 路径加载；新增方向不读取或写入 FSD 的专属状态。
- 解析 Archive 直接使用 `archive/<baseId>-v<version>/`，去掉 `papers/` 层；PDF 原件和 Obsidian 路径保持不变。
- 保持现有检索、筛选、配额和归档内容格式；只修改布局及相关读写校验，不恢复或迁移已删除的历史数据。

### 已确认的路径调整（2026-09-05）

- 用户已删除旧数据，本次只调整代码、配置与文档；不迁移、不恢复、不启动采集或真实 MinerU 任务。
- Obsidian 仓库：`D:/obsidian/data/paper-knowledge-engine/fsd`。
- 下载 PDF 长期保存目录：`D:/paper/paper-knowledge-engine/fsd`，保留已有分类子目录。
- 内部数据库、Archive、任务和工作文件仍在 `D:/agent-data/data/paper-libraries/fsd`。
- Archive 和 Obsidian 发布目录仍保留各自所需的 PDF 副本，维持可验证、可重建的现有契约；清理内部临时文件不得删除外部下载原件。
- 目录按方向库 ID 派生，不把 fsd 写死到通用代码；在隔离目录验证配置、实际下载落点及路径安全。

本次路径调整验收：

- [x] 配置加载得到上述 PDF、Vault 和内部数据根，旧配置缺省行为仍兼容。
- [x] 隔离测试证明 PDF 落在指定外部分类目录，清理和重建保护原件。
- [x] 类型检查、相关回归和全量测试通过；未创建真实库或启动采集。

验证记录（2026-09-05）：`bun run typecheck` 通过；`bun test --timeout 30000`：1141 通过、4 跳过、0 失败。真实 MinerU 等门控测试未执行；本次未进行真实采集验收。

### R1 — 确定性业务主线

生产主线必须保持：OpenCLI 自有 arXiv 适配器发现 → 确定性筛选 → PDF 下载/校验/去重 → MinerU 解析 → 原子 Archive → Obsidian Wiki 发布。内容生成、摘要、语义分析和其他 LLM 调用不属于本阶段。

### R2 — OpenCLI 可用性

第一次发现前必须自动检查并准备项目固定的 OpenCLI 安装与适配器。准备失败必须返回真实错误；不得静默切换到另一个 arXiv 客户端，也不得要求用户预先执行独立菜单步骤。

### R3 — 任务级固定 MinerU API

每个需要解析的 `current`、`weekly`、本地导入或指定论文操作拥有一个固定 loopback API。该 API 在该操作内被所有论文复用，操作成功、失败或中断后可靠关闭；它不由交互菜单持有，也不在操作结束后常驻。

API 必须拒绝占用端口上的未知服务，不得自动附着；每篇 MinerU 客户端必须显式使用该任务 API，不能回退到每篇启动临时 FastAPI。

### R4 — MinerU 推理配置

影响实际推理的环境参数必须传给执行推理的 FastAPI 服务端，而不只传给上传/轮询客户端。真实验收必须确认配置中的 `processing_window_size: 1` 与 `pipeline_batch_ratio: 1` 生效。

### R5 — 解析产物与 Obsidian Wiki

每篇成功论文必须保留可校验的 MinerU Archive，其中至少包含归一化 Markdown、结构化内容、分页文本、资源文件、身份与哈希清单。

Obsidian 中每篇论文版本必须同时包含：

- 普通 Wiki 入口页及确定性元数据/索引；
- MinerU 解析后的 Markdown 文档；
- Markdown 引用的图片等资源；
- 分页文本与结构化内容，供检索、对账和后续扩展使用。

Archive 是发布输入的事实来源；Obsidian 是可重建的托管投影。Evidence 在本项目中表示确定性发布层，不表示 LLM 推理。

Obsidian 的 `document.md` 以可用性优先：保持 MinerU 正文内容，统一换行并将资源链接重写为 Vault 内路径。不得额外发布一个与其角色重叠的 `mineru-original.md`；需要审计时读取 Archive 中的 `normalized/full.md`。

### R6 — 中断恢复

下载完成后解析中断，再次运行同一任务必须沿用原 `runId`、固定选篇和解析任务清单；复用已下载 PDF，跳过已成功且 Archive 验证通过的论文，只按原顺序重试失败或未解析论文。只有全部 Archive 验证成功后才能发布 Obsidian Wiki。

### R7 — 错误真实性与清理

API 启动、端口冲突、MinerU 业务失败、非 UTF-8 输出、进程树清理失败必须保持可区分错误。若业务成功但 API 清理未确认，公开结果和持久状态都必须是失败，不能同时打印成功 DTO。

### R8 — Bun-only 操作面

`bun src/cli.ts` 保持唯一交互菜单入口。不得恢复 PowerShell 菜单或依赖 PowerShell supervisor 作为运行入口；MinerU 与 OpenCLI 的准备、任务执行和状态反馈由 Bun 路径完成。

### R9 — 累计、原子且可恢复的 Evidence 发布

Evidence 发布必须以“历史已完成来源与当前 run 来源的确定性并集”为目标快照，而不是只发布当前 run。后续 run 新增论文时，已经发布的论文、资源和版本不得丢失；同一 `(baseId, version)` 对应不同 Archive 身份时必须以冲突停止。

系统必须在修改 Vault 或写 publication receipt 之前，先在 SQLite 中为当前 run 预留由发布计划确定的 publication。publication 身份必须同时绑定 `runId` 与累计内容哈希，使不同 run 即使得到相同累计快照也能各自完成并保留独立审计记录。

发布在预留后、安装中、receipt 写入后任一位置中断，再次恢复同一 run 时必须验证并继续同一计划；不得产生未入账的 Vault 修改、重复 publication 或静默覆盖人工文件。既有 publisher v1 完成记录和 receipt 必须继续可验证、可重放，不得为了升级而重写。

## Acceptance Criteria

- [ ] 从缺失 OpenCLI 安装清单的状态启动一次受控发现，系统自动准备后通过项目适配器查询 arXiv；准备失败时没有隐藏回退。
- [ ] 一个真实解析操作只启动一个 MinerU FastAPI、只初始化一次模型，并连续完成至少两个 PDF 请求；每个客户端都带固定 `--api-url`。
- [ ] 真实日志确认 FastAPI 服务端采用配置的单并发、单页窗口和 Batch Ratio 1。
- [ ] 操作正常完成、MinerU 失败、Ctrl+C/终止信号和 API 异常退出后，均无本次操作遗留的 Bun 所有 MinerU/Python 进程或活动安全记录。
- [ ] 一篇真实论文从 OpenCLI/arXiv 到 PDF、Archive、Obsidian 全链路成功；论文目录含 Wiki 入口、MinerU Markdown、资源、分页文本、结构化内容及可验证清单。
- [ ] 三论文恢复测试中，A 已成功、B 失败、C 未开始；恢复保持原 `runId`，发现和下载调用均为零，只解析 B、C，并在全部成功后发布 A、B、C。
- [ ] B 再次失败时不发布 Wiki，任务仍可恢复。
- [ ] 非 UTF-8 子进程输出不会把退出码 0 误判为 supervisor error，真实 stderr 与结构化错误码仍可诊断。
- [ ] 连续两个 run 中，run A 发布论文 A，run B 发布论文 B；最终 Vault、累计索引和 run B receipt 均包含 A+B，A 的托管文件保持不变。
- [ ] 两个不同 run 产生相同累计内容时，二者具有不同 publication ID，第二个 run 可完成且无需重写相同 Vault 内容。
- [ ] 注入“预留失败、预留后中断、部分安装后中断、receipt 后中断”故障时，预留失败不写 Vault/receipt，其余场景恢复后恰有一个完成 publication 且投影与计划一致。
- [ ] 未知人工文件仍阻止托管发布；当前 bootstrap seed、已知旧模板和 publisher v1 完成记录保持兼容，任何近似但非逐字节匹配的模板都不能被自动覆盖。
- [ ] `bun run typecheck` 与完整自动化测试通过；真实两请求 smoke 和受控端到端验收另行显式运行并留存结果。

## Out of Scope

- LLM 摘要、结论分析、语义 Wiki、RAG、GraphRAG 或向量检索。
- L3 人工知识层、主题综合、方法对比和阅读笔记；这些内容必须等本任务的 L2 全部验收完成后，由独立 Trellis 任务实现。
- 机器启动即运行或跨 CLI 操作常驻的 MinerU daemon。
- PowerShell 菜单、PowerShell 进程 supervisor 或其他 arXiv 发现回退。
- 改变论文主题、筛选、配额和分类业务规则。
- 改变 Archive 内容格式或重写 Evidence 的全部数据模型；本任务只升级发布计划、状态机、累计投影和兼容读取边界。

## Deferred Follow-up

L2 完成后创建独立的 L3 任务，在不修改 `01-Evidence` 所有权的前提下增加人工维护的 `02-Knowledge`。L3 首期仍不使用 LLM，内容由用户选择性维护，并通过 Obsidian 链接引用 L2 来源。
