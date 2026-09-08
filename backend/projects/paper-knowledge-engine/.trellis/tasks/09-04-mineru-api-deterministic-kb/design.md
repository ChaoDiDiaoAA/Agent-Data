# 稳定 MinerU API 与确定性 Obsidian 知识库流水线 — Design

## 1. Design objective

保持现有确定性业务主线，只重新划定 MinerU API 生命周期并补齐可观察、可恢复和真实验收边界：

```text
OpenCLI arXiv adapter
  → deterministic discovery and selection
  → verified PDF store
  → one operation-scoped MinerU API
  → immutable parse Archive
  → managed Obsidian publication
```

该设计不引入 LLM、语义生成或机器级常驻服务。

## 2. Boundaries and ownership

### 2.1 OpenCLI discovery boundary

OpenCLI 是项目拥有的适配器执行边界，实际来源是 arXiv Atom API。第一次 discovery shard 前运行幂等的 installation preflight；缺失清单时自动准备，无法准备时终止并暴露真实错误。不得回退到隐藏的第二套 arXiv 客户端。

### 2.2 Operation-scoped MinerU API

`executeOperation()` 是 MinerU API 的唯一生命周期所有者：

- `current`、`weekly`、`import`、`import-local`、`parse-local` 各自获得一个 session；
- session 对象可在操作开始时创建，但 Python API 延迟到第一次 `session.run()` 才启动，因此发现和下载阶段不占用 GPU；
- 同一操作的全部论文串行复用同一固定 URL；
- `evidence-publish`、`reconcile`、`bootstrap` 不创建 session；
- 操作成功、失败、取消或 API 崩溃都在 `executeOperation()` 的 `finally` 中释放；
- 交互菜单只触发和取消 operation，不拥有或跨 operation 复用 MinerU session。

固定地址来自严格校验的 `apiHost/apiPort`，生产 URL 必须是该 origin。启动前独占探测端口；端口被占用即返回明确冲突，不附着未知服务。

### 2.3 Process split

一个 operation 启动至多一个 `python.exe -m mineru.cli.fast_api`。每篇论文仍使用一个短生命周期官方 `mineru` 客户端负责上传、轮询和下载，但必须显式传入 operation session 的 `--api-url`，因此不会再启动每篇临时 FastAPI。

服务端进程获得所有影响推理的环境设置，包括设备、模型源、并发、processing window 和 pipeline batch ratio。客户端环境只承担客户端行为，不得成为推理配置的唯一承载者。

## 3. Data flow and contracts

### 3.1 Frozen task inputs

选篇在下载前写入 `selection-manifest.json`；下载完成后写入 `mineru-jobs.json`。两份清单一旦冻结，恢复不得重新发现或重排。

### 3.2 Parse Archive

每篇成功 parse attempt 原子发布一个不可变 Archive，至少包含：

- `normalized/full.md`；
- `content_list.json`、分页文本和分页结构；
- Markdown/结构化内容引用的 assets；
- PDF 身份、MinerU 模型/方法身份、attempt 身份；
- 文件大小与 SHA-256 清单。

Archive 是发布与恢复的权威事实来源。成功记录只有在 Archive 原子安装和验证完成后才能写入。

### 3.3 Obsidian managed projection

每篇论文版本在 `01-Evidence/sources/papers/<baseId>/v<version>/` 下发布：

- `index.md`：Wiki 入口、来源、身份和索引链接；
- `document.md`：从 Archive `normalized/full.md` 生成的 MinerU 正文投影；
- `assets/`：正文引用资源；
- `pages.md`、`pages.json`、`content_list.json`；
- `manifest.json`：发布文件身份。

`document.md` 只允许统一换行和资源链接改写，不允许添加总结、结论或建议。Archive 保持权威，Obsidian publication 可通过 receipt 安全重放或重建。

## 4. Resume state machine

恢复使用原 operation/job 和原 `runId`：

1. 有固定选篇但下载未完成：遍历固定选篇，复用已验证 PDF，只补缺失下载。
2. 有 `mineru-jobs.json`：跳过 discovery 和 download。
3. 对每个 job：成功且 Archive 验证通过则跳过；failed/interrupted/missing 则按清单顺序执行。
4. 任一 parse 再次失败：停止本批，不发布 Obsidian，保持 `canResume=true`。
5. 全部 Archive 验证通过：一次性发布 A/B/C 等全部选篇，并完成 receipt/run。

不得在一次失败的单篇请求内自动重放；重试发生在显式恢复 operation 中。

## 5. Cancellation and cleanup

菜单和非交互命令共享 operation AbortSignal。SIGINT/SIGTERM 只触发 abort，不直接 `process.exit()`；活动 operation 负责停止客户端并在 `finally` 清理 API process tree。菜单输入 EOF 必须结束菜单，但由于菜单不拥有 MinerU session，不能阻挡 API 释放。

清理采用 fail-closed：如果业务结果成功但 API 进程树清理未确认，持久状态和公开输出都为 `PROCESS_CLEANUP_UNCONFIRMED` 失败；不得随后调用成功结果回调或打印成功 DTO。

## 6. Observability and errors

正常输出至少区分：OpenCLI preflight、discovery、selection、PDF reuse/download、API start/ready/reuse/stop、每篇 parse、Archive verify、Obsidian publish 和 resume checkpoint。

错误保持结构化类别：OpenCLI preparation、API port in use、API startup timeout/unavailable、MinerU process/business error、invalid artifact、cleanup unconfirmed。stderr 采用容错 UTF-8 解码并继续排空，原始字节计数仍执行上限。

## 7. Compatibility and migration

- 保留旧方案 Tasks 1–5 中已经验证的配置、容错解码、显式 `--api-url`、session 状态机和 parse routing。
- 替换旧 Task 6 的菜单级 session 所有权；`executeOperation()` 的 operation 所有权保留并收紧。
- 保留现有 Archive/Evidence 未提交工作，不覆盖用户修改；先按路径和测试归属审计后再分批提交。
- 旧 `docs/superpowers/...mineru-session-service` 计划作为历史输入，最终标注由本 Trellis task 接管，不能再作为执行进度源。

## 8. Rollback shape

每个实施步骤独立提交且只包含声明文件。若真实 MinerU smoke 失败，停止在真实批量任务之前，保留自动化修复并记录日志；不得通过恢复每篇临时 API、附着未知端口或降低清理规则绕过失败。

## 9. Verification layers

1. 单元/契约：session ownership、server env、URL、错误优先级、Archive/Obsidian renderer。
2. 集成：三论文固定清单恢复、OpenCLI 自动准备、publication replay。
3. 真实 MinerU：一个 API、一次模型初始化、两个请求、Batch Ratio 1、清理无残留。
4. 受控端到端：一篇真实 arXiv 论文进入 Obsidian；随后一次受控多篇中断验证恢复。

## 10. Post-L2 evolution

本设计完成的是 L2 确定性结构化资料 Wiki。只有所有 L2 acceptance criteria 通过后，才创建独立 Trellis 任务设计 L3 人工知识层：`01-Evidence` 继续由程序管理并可重建，`02-Knowledge` 由用户维护主题页、方法对比、阅读笔记和研究判断，自动发布不得覆盖它。L3 首期不依赖 LLM；未来任何 LLM 辅助必须作为更晚的独立决策。

## 11. Cumulative Evidence publication state machine

### 11.1 Decision and alternatives

采用“累计不可变发布计划 + 写前数据库预留 + run 绑定 publication 身份”的方案。

未采用的方案：

- 每个 run 只对 Vault 做增量补丁：表面写入较少，但中断恢复、旧文件归属、索引重建和人工文件判定会分散到多个调用点，无法形成一个可验证事务。
- 每次从 Archive 全量替换 Vault、完成后再登记数据库：内容可重建，但进程在替换后、登记前退出会留下未入账投影，现有故障已证明该顺序不安全。
- 继续使用只由内容决定的 publication ID：不同 run 得到相同快照时会争用同一数据库主键，不能表达“两个任务分别确认了同一发布内容”。

本方案保持 Archive 格式不变，把复杂性封装在一个 Evidence 发布协调器中。调用方只提交 `runId` 和路径上下文，不得自行安排 plan、reserve、apply、complete 的顺序。

### 11.2 Deep module boundary

新增一个深模块 `publishRunEvidence()` 作为所有正常发布路径的唯一入口，其公开职责是：

```ts
publishRunEvidence({
  runId,
  stateRoot,
  tempRoot,
  vaultRoot,
  store,
  lastSuccess,
  onProgress,
}): Promise<EvidencePublicationResult>
```

模块内部依次完成历史来源收集、Archive 复验、累计计划生成、SQLite 预留、Vault 安装、receipt 写入以及数据库完成/失败转换。`src/evidence/publisher.ts` 只承担计划渲染和事务安装，不向 CLI 暴露可被错误排序的低层步骤。

正常任务、本地 PDF 导入、指定论文和菜单 6 的失败 run 恢复都调用该协调器。历史迁移可保留自己的 inventory 适配器，但进入发布状态机后必须使用相同的写前预留与完成规则。测试不得再把“先调用 publisher、后 reserve”当作有效用法。

### 11.3 Deterministic cumulative source set

当前 run 的来源由冻结的 `mineru-jobs.json`、成功 parse attempt 和逐文件验证通过的不可变 Archive 共同确定。历史来源由 SQLite 中所有 completed Evidence publications 的 source rows 枚举，但文件内容仍必须从对应 Archive 重新读取和验证，不能信任现有 Vault 作为输入。

累计来源集按 `(baseId, version)` 合并并按 `baseId`、`version` 稳定排序：

- 相同键与相同 Archive manifest SHA-256 视为同一来源；
- 相同键对应不同 Archive manifest SHA-256 或不同规范化源身份时，以 `EVIDENCE_CONFLICT` 停止；
- 保留所有已经发布的论文版本，不自动删除旧版本；
- 当前 run 的全部来源必须出现在累计计划中；
- 当前 run 没有增加新来源、累计内容与前次相同时，仍为该 run 创建独立 publication 审计记录，Vault 可验证后零写入重放。

历史集合的顺序不得依赖 SQLite 未指定顺序。completed publication 以 `completed_at`、`run_id` 形成确定性顺序，source union 最终仍以来源键排序。

### 11.4 Pure publication plan and identity

在任何外部写入之前生成不可变 `EvidencePublicationPlan`。计划至少包含：

- `schemaVersion` 和 `publisherVersion`；
- 当前 `runId`；
- 稳定排序的累计来源身份；
- 将被管理的相对目标路径、字节哈希和整体 `contentSha256`；
- 可选的已完成 predecessor publication 身份；
- 由 run 与内容共同确定的 `publicationId`。

`contentSha256` 继续由规范化的累计目标文件清单计算。新 publication 使用 publisher v2 身份：

```text
publicationId = "evidence-" + sha256(canonical({
  runId,
  contentSha256,
  publisherVersion: 2
})).slice(0, 32)
```

因此同一 run、同一内容可幂等重放；不同 run、相同内容获得不同 publication ID。已完成的 publisher v1 receipt 不重写：若目标 run 已有合法 v1 完成记录，按原身份验证并重放；新 run 一律使用 v2。

计划类型可供状态层持久化必要身份，但目标字节集合保持 publisher 内部实现细节，避免调用方绕过校验直接写 Vault。

### 11.5 Reserve-before-write transitions

发布顺序固定为：

```text
verified inputs
  → pure plan
  → SQLite reserved
  → stage / journal / Vault install / receipt
  → SQLite completed
```

状态规则：

1. 计划生成和 Archive 复验只读，不修改 Vault、receipt 或 publication rows。
2. `reserveEvidencePublication(plan identity, sources)` 必须在第一个 Vault/receipt 写入之前原子完成。
3. 相同 run 已有 `reserved` 且计划身份相同：先恢复 journal，再继续 apply。
4. 相同 run 已有 `failed` 且计划身份相同：允许显式重新预留并继续。
5. 相同 run 已有 `completed` 且计划身份相同：验证数据库、receipt 和 Vault 后返回 replay。
6. 相同 run 对应不同计划身份：以 plan drift 冲突停止，不能覆盖原记录。
7. apply 失败时将 publication 标为 `failed` 并保留 run 的可恢复性；异常详情仍经过公开错误白名单。

崩溃恢复边界：

- 预留后、写 Vault 前退出：恢复沿用 reserved 计划并开始安装；
- 部分 Vault 安装后退出：journal 恢复备份或继续同一计划，不能生成第二个 publication；
- Vault 完成、receipt 前退出：由 journal 和计划哈希验证后补写 receipt；
- receipt 完成、SQLite complete 前退出：验证 receipt/Vault 后只补状态转换。

预留冲突或数据库写失败发生在外部文件写入前，因此必须留下零 Vault、零 receipt 变更。

### 11.6 Installed Vault and predecessor validation

每次发布都构建完整累计目标快照，但只安装新增或字节变化的托管文件。发布前把现有 `01-Evidence` 分类为：

- canonical bootstrap seed；
- 与当前计划逐字节相同；
- 与已完成 predecessor 计划逐字节相同；
- conflict。

predecessor 快照必须从已完成 publication 的 source rows 和已验证 Archives 重新渲染，不读取 Vault 来“猜测”期望内容。第二个正常 run 因而能识别旧论文文件是 predecessor 的托管内容，而不是 unknown manual file。根索引和累计索引可被新计划替换；旧论文的版本目录必须保持字节不变，新论文只增加目录和索引条目。

任何不属于 bootstrap、current 或 predecessor 精确目标集的文件仍视为人工/未知文件并阻止发布。已知旧 bootstrap 模板只有逐字节命中时可迁移；任何一字节修改都保留并报冲突。L2 不执行自动删除或 prune，因此新累计计划必须是 predecessor 来源集合的超集。

### 11.7 Persistence and schema

优先复用现有“一 run 一 publication”约束及 `evidence_publication_sources`，不为可推导数据增加列。StateStore 增加只读方法枚举 completed publications 及其 source identities，并增加能校验 publication ID、content hash 和 source rows 的幂等预留转换。

只有实现时确认现有表无法表达 `reserved/failed/completed` 转换或 publisher version 时，才新增最小向前迁移；不得为了缓存 predecessor 快照复制 Archive 清单。predecessor 默认从 completed publications 的确定性顺序推导。

数据库事务至少保证 publication row 与对应 source rows 同时预留；不得出现有 publication 无 sources、或 sources 指向未预留 publication 的中间状态。

### 11.8 Receipts and compatibility

publisher v2 receipt 仍位于 state root，并包含 `runId`、`publicationId`、`publisherVersion`、`contentSha256`、累计来源身份和目标文件哈希。receipt 必须在 Vault 事务安装成功后原子写入；数据库 `completed` 只在 receipt 与 Vault 再验证成功后写入。

兼容规则：

- 既有 v1 completed publication/receipt 可作为 v2 的 predecessor；
- 对已有 v1 run 的重放沿用 v1 publication ID，不生成替代 receipt；
- 新 v2 run 不改写历史 receipt，不改变 Archive，不删除历史 Vault 来源；
- 不认识的未来 publisher version 必须 fail closed。

### 11.9 Errors and public diagnostics

以下错误使用稳定结构化类别，并由 CLI 输出可定位但不泄密的细节：Archive 身份冲突、plan drift、predecessor/Vault 不匹配、未知人工文件、reservation conflict、journal recovery failure、receipt mismatch。

公开详情只允许枚举过的安全短语和经过规范化的 Vault 相对路径；不得透传任意异常消息、绝对敏感路径、Authorization header 或子进程原始内容。reservation 失败的诊断必须明确指出“未修改 Vault”。

### 11.10 Test-first acceptance matrix

实施按以下失败测试驱动，每项通过后才能在实施清单打钩：

1. bootstrap 新建内容与 canonical renderer 输出逐字节相等。
2. 三个已知 legacy template 分别允许精确迁移；各自一字节修改均冲突；迁移中断可回滚。
3. 注入 reservation 拒绝时，Vault 和 receipt 没有任何写入。
4. 分别在 reserve 后、首个文件安装后、receipt 后中断；恢复后只有一个 completed publication，文件与计划逐字节一致。
5. run A 发布论文 A，run B 发布论文 B；最终 Vault 与 run B receipt 包含 A+B，A 文件哈希不变。
6. 两个 run 产生相同累计内容；publication ID 不同，第二次完成且 Vault 零内容变化。
7. unknown manual file 保留且阻止发布。
8. 已完成 publisher v1 receipt 继续验证和 replay，并可作为 v2 predecessor。
9. 正常任务、本地导入、指定论文、菜单 6 恢复都通过同一协调器的契约测试。
10. typecheck、完整自动化测试和受控真实 publication 验收通过。

### 11.11 Rollback and operational safety

升级不删除或重写现有生产 v1 receipt、Archive 或已完成 publication row。实现提交应先加入纯计划与读取接口，再切换调用路径；在所有入口切换完成前，旧写后预留路径不得与新路径同时可达。

若上线后发现冲突，停止发布并保留 journal/backups，继续允许 Archive 解析和验证；不得通过忽略未知文件、删除数据库记录或重建空 Vault 绕过。回滚代码后，既有 v1 数据仍可使用；尚未完成的 v2 reserved/failed 记录保留供修复，不伪装为 completed。
