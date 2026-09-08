# 稳定 MinerU API 与确定性 Obsidian 知识库流水线 — Implementation Plan

## 已批准的目录精简补充（2026-09-05）

- [x] Archive 去掉 `papers/` 包装层，同步写入、任务清单、发布读取、对账与重建；保持 Vault 布局不变。
- [x] FSD 配置拆入 `config/fsd/` 四文件，旧兼容配置迁入测试夹具；8 个查询方向、16 个分片和既有规则保持不变。
- [x] 同步文档，运行类型检查和全量测试；不迁移旧数据、不创建真实库、不启动网络采集或 MinerU。

验证：扁平归档写入、分目录加载、跨方向 MinerU 路径隔离均先观察失败再修复；修复了原 MinerU 配置加载器硬编码 FSD 的问题。最终 `bun run typecheck`、`git diff --check` 通过，`bun test --timeout 30000` 为 1142 pass / 4 gated skip / 0 fail。旧 FSD 配置与拆分后的四文件值逐项一致。尚未提交 Git；真实采集和 GPU 验收未执行。

以下为历史实施记录；本补充的已批准路径优先于历史文档中的旧布局。

## Execution rules

- 以下步骤严格顺序执行；完成实现、测试和独立检查后才将对应复选框改为 `[x]`。
- 每一步先写或确认失败测试，再做最小修复；现有行为已满足时以新增回归测试证明，不重写代码。
- 每一步只提交列出的任务文件；不得吸收工作树中无关的 staged/untracked 用户修改。
- 不使用 destructive reset，不恢复 PowerShell 菜单/监督器，不引入 LLM。
- 旧计划的已完成 Tasks 1–5 作为基线能力审计，不机械重做。

## Phase A — Rebaseline current work

- [x] **A1. Snapshot and classify the dirty working tree**
  - 记录 `faccbcd` 之后的已提交 MinerU 变更、当前 Evidence/Archive 未提交文件和 Trellis 文档。
  - 将无关用户修改列为保护区，不纳入任务提交。
  - 运行当前 focused tests，保存基线结果；不在本步骤修改产品代码。

- [x] **A2. Audit old Tasks 1–5 against the new PRD**
  - 证明配置、非 UTF-8 解码、显式 API URL、session 状态机、parse routing 仍符合 PRD。
  - 记录缺口，不重复实现已满足能力。

## Phase B — Correct operation ownership and result truthfulness

- [x] **B1. Remove menu-owned MinerU session lifetime**
  - `main()` 不再创建或跨菜单命令传递共享 MinerU session。
  - 每个需要解析的 operation 通过 `executeOperation()` 获得一个 command-owned lazy session。
  - 保留可取消的 readline，但 EOF/信号只结束菜单和 abort 当前 operation。
  - Tests: `tests/workflow.test.ts`, `tests/job-bridge.test.ts`, `tests/cli-menu.test.ts`。

- [x] **B2. Make cleanup failure the only public result**
  - 业务成功但 dispose 失败时，禁止调用成功 `onResult`，CLI 只输出 failed `JobView`，退出码为 1。
  - 同时失败时 `PROCESS_CLEANUP_UNCONFIRMED` 保持最高优先级。
  - Tests: workflow callback、CLI output、success/error/dispose matrix。

- [x] **B3. Run ownership verification and independent review**
  - `bun test tests/workflow.test.ts tests/job-bridge.test.ts tests/cli-menu.test.ts --timeout 30000`
  - `bun run typecheck`
  - 检查 worker/operation-service/job-bridge 中没有新增 session 管理。

## Phase C — Make the fixed API reflect real inference configuration

- [x] **C1. Put inference settings on the FastAPI server**
  - 将 pipeline batch ratio 对应环境和其他推理设置传入 API server process。
  - 客户端环境继续保留必要兼容项，但测试必须证明服务端收到 Batch Ratio 1 配置。
  - Tests: `tests/mineru-api-session.test.ts`, `tests/mineru-cli-runner.test.ts`。

- [x] **C2. Tighten the API origin contract**
  - 生产与公开 runner 只接受由配置生成的 exact loopback origin；拒绝 credentials、query、hash 和自定义 path。
  - `rg -n "runMineruCli\\(" src` 只能找到 session 模块内部调用与定义。

- [x] **C3. Run API contract verification and independent review**
  - `bun test tests/mineru-api-session.test.ts tests/mineru-cli-runner.test.ts tests/runtime-process.test.ts tests/runtime-bun-process.test.ts --timeout 30000`
  - `bun run typecheck`

## Phase D — Prove OpenCLI and deterministic publication contracts

- [x] **D1. Verify automatic OpenCLI preparation**
  - 用缺失 installation manifest 的隔离 fixture 从 discovery 入口执行，证明自动 prepare；准备失败暴露真实错误且没有回退。
  - Tests: `tests/opencli-installation.test.ts`, `tests/opencli-runner.test.ts`, relevant harvest tests。

- [x] **D2. Lock the MinerU Markdown publication contract**
  - Archive 必含 `normalized/full.md` 和资源身份。
  - Obsidian 每篇论文版本必含 `document.md`、assets、pages、content list、index 和 manifest。
  - 断言 `document.md` 仅归一化换行和重写资源链接，不含 LLM 生成段落，不产生 `mineru-original.md`。
  - Tests: Archive reader、paper renderer、publisher integration。

- [x] **D3. Run publication verification and independent review**
  - 运行 OpenCLI、Archive、Evidence renderer/publisher 聚焦测试。
  - `bun run typecheck`

## Phase E — Lock resume semantics

- [x] **E1. Add the real-state three-paper resume regression**
  - A 成功且 Archive 可验证，B failed/interrupted，C missing。
  - 恢复断言同一 `runId`、零 discovery、零 download、parse 顺序仅 B/C、最终发布 A/B/C。

- [x] **E2. Prove repeated failure remains resumable**
  - B 再次失败时 Evidence/Wiki publish 调用为零，operation `canResume=true`。
  - 只有测试 RED 证明生产缺陷时才最小修改 `src/pipeline.ts`。

- [x] **E3. Run resume verification and independent review**
  - `bun test tests/pipeline.test.ts tests/automatic-selection-resume.test.ts tests/run-task.test.ts tests/three-paper-resume.test.ts --timeout 30000`
  - `bun run typecheck`

## Phase F — Automated full-scope gate

- [x] **F1. Run static and full automated checks**
  - `bun run typecheck`
  - `bun test --timeout 30000`
  - 默认运行只允许显式 gated 的真实 MinerU smoke 被 skip；不得新增其他 skip 或回归失败。

- [x] **F2. Review the complete task diff**
  - 对照 PRD、design、ADRs、CONTEXT 和 protected dirty paths 做全量独立检查。
  - 核对生产路径无临时 API、无 LLM、无 PowerShell 菜单入口。

## Phase G — Real-machine acceptance

- [x] **G1. Run one real two-request MinerU smoke**
  - 显式启用 GPU smoke；一个 API 连续处理两个输出目录。
  - 日志断言一次 API launch、一次 model init、Batch Ratio 1、两个成功 normalized artifacts。
  - finally 后 API/client safety roots 均无活动记录，端口已释放。

- [x] **G2a. Harden the OpenCLI arXiv reliability boundary**
  - [x] 直连 `https://export.arxiv.org/api/query`，并为非 2xx 响应保留最多 256 字节的安全诊断和白名单响应头。
  - [x] 将 `429 + Rate exceeded` 分类为系统容量限制，立即生成固定冷却窗口，不消耗普通短重试次数。
  - [x] 将容量限制事件跨 OpenCLI 进程边界传回 Bun 主流程，并持久化 `retry_not_before`；冷却期内快速失败，期满后从失败分片恢复。
  - [x] 增加 `capacity_cooldown_seconds: 900` 配置、中文进度输出、迁移、测试夹具和运维文档。
  - [x] 运行聚焦测试、全量测试、类型检查及真实单分片 smoke，记录验证结果。
    - 聚焦测试 25/25；全量测试 608 pass / 4 gated skip / 0 fail；`tsc --noEmit` 通过。
    - 最终生成的 OpenCLI 真实单分片 smoke 返回 `2609.03156v1`；独立终审与定向复审均无 Critical/Important 遗留。

- [x] **G2b. Close residual arXiv and MinerU timeout diagnostics gaps**
  - [x] 普通 HTTP 429 与系统容量 429 一样立即延期并保存恢复时间，不在同一子进程内继续形成重试突发；保留 5xx 与传输错误的短重试。
  - [x] 将 `task_timeout_seconds` 同步传入 MinerU 官方任务等待环境，并为结果下载超时增加显式 YAML 配置与校验。
  - [x] 分离保留 MinerU 客户端与任务级 API 的有界脱敏 stderr；解析失败输出同时呈现两个来源，便于定位 GPU 推理与 HTTP 客户端故障。
  - [x] 先运行红测，再完成聚焦测试、全量测试与类型检查；每个完成项即时勾选。
    - 红测按预期 3 项失败；修复后聚焦测试 39/39；全量测试 611 pass / 4 gated skip / 0 fail；`tsc --noEmit` 通过；MinerU CLI 配置描述符确认固定 `127.0.0.1:17860`、任务等待 3600 秒、结果下载 600 秒。

- [x] **G2c. Normalize and recover MinerU Archive asset references**
  - [x] 新解析将 MinerU 本地资源复制到稳定 `assets/` 路径，并同步重写 normalized Markdown 与 content-list 后再冻结 manifest。
  - [x] 旧 arXiv Archive 保持不可变；仅允许 `<arxivId>/<method>/<referenced-path>` 精确 manifest 兼容路径，并继续校验冻结 hash 与字节。
  - [x] Evidence 渲染对 Markdown 与发布后的 `content_list.json` 使用同一资源映射；未验证前的 Archive 日志改为“已生成”。
  - [x] 先运行 3 项红测；修复后聚焦测试 49/49 与渲染补充红绿测试通过；全量测试 613 pass / 4 gated skip / 0 fail；`tsc --noEmit` 通过。
  - [x] 对真实 run `0f6fdade-2026-4fe4-b9d2-7b03cad0c635` 做只读生产路径验证：10/10 来源、185/185 资源引用成功读取并渲染，缺失 0；未修改 Archive、SQLite 或 Vault。

- [x] **G2d. Separate current and weekly date-window semantics**
  - [x] 菜单 2 的新 `current` run 始终从 `pipeline.start_date` 开始，不再读取 `last_success` 推进起点。
  - [x] 自动恢复只接受起点与当前配置一致的 failed current discovery run；显式 run 恢复、固定清单解析恢复和 `--from/--to` 保持原契约。
  - [x] 菜单 3 的 `weekly` run 继续使用 `last_success - overlap_hours`，且不早于配置起点。
  - [x] 红测按预期暴露 current 水位读取和旧窗口误恢复；修复后聚焦测试 29/29，全量测试 622 pass / 4 gated skip / 0 fail，`tsc --noEmit` 通过。

- [x] **G2e. Prevent prose HTML mentions from aborting Archive normalization**
  - [x] 将无属性的正文 `<img>`、`<source />` 视为文字并在发布 Markdown 中转义；带 `src`/`srcset` 的真实资源继续进入闭包校验，带其他属性但缺少资源地址的标签继续失败。
  - [x] 将比较表达式 `i<len`、占位符 `<source_request>`/`<img_tag>` 识别为正文而非 HTML 资源；真实资源标签仍保持严格校验。
  - [x] 先运行红测确认真实失败，再通过归档、Evidence reader、MinerU result 聚焦测试 90/90 和 `tsc --noEmit`；真实失败 Markdown 只读扫描成功发现 3 个资源引用。
  - [x] 全量回归已执行：1152 pass / 4 skip / 27 fail；失败来自受限环境访问 `C:\Users\yyc` 的 `EPERM` 及当前工作树已有配置期望漂移，不涉及本步骤修改文件。

- [x] **G2f. Accept the complete arXiv category path grammar in Evidence indexes**
  - [x] 分类索引允许命名空间类别（`cs.AI`）和独立类别（`quant-ph`、`hep-th`），仍只允许单一路径段，拒绝斜杠和路径穿越。
  - [x] 先运行 `quant-ph`/`hep-th`/`cs.AI` 红测，再通过 5/5 分类索引测试；真实 100 个来源只读渲染生成 2237 个 Evidence 文件。
  - [x] 使用提升权限仅恢复发布同一 run `9daf0fef-65f1-4bb5-99a6-1c543f752a6d`，未重新 discovery/download/parse；100/100 Archive 成功，Evidence publication `evidence-ca379afefbec24f7066afd1c9d51d9ab` 已完成，Obsidian 累计 120 篇论文、4 个索引，publication receipt 与 SQLite 一致，journal 已清理。

- [x] **G2. Run one bounded end-to-end arXiv acceptance**
  - 使用固定窗口/limit=1 或固定小论文，经 OpenCLI、PDF、MinerU、Archive 到 Obsidian。
  - 验证 `index.md`、`document.md`、assets、pages、content list、manifest 和 publication receipt。
  - 已恢复并发布固定 run `0f6fdade-2026-4fe4-b9d2-7b03cad0c635` 的 10 篇来源；此前 OpenCLI、PDF、MinerU 与 Archive 已完成，本次修复并验收 Evidence 首次发布边界。
  - publication `evidence-6ec4d499212c4a6a68a3d1073d514acd` 已完成：10 个来源、185 个 assets、每篇 `index.md`/`document.md`/`pages.md`/`pages.json`/`content_list.json`/`manifest.json` 完整，receipt SHA-256 与 SQLite 一致，journal 已清理；相同命令重放返回 `replayed: true`。
  - 新增 bootstrap 首发、三个精确旧模板迁移、人工字节保护、失败 run 显式恢复及安全错误明细测试；全量 `619 pass / 4 gated skip / 0 fail`，类型检查通过。

- [ ] **G3. Run one controlled interruption/resume acceptance**
  - 在后续论文解析时中断，重新执行同一任务。
  - 验证固定选篇、PDF 和成功 Archive 被复用，只继续失败/未解析论文，最终统一发布且无进程残留。

## Phase I — Cumulative Evidence publication v2

- [x] **I1. Add failing cumulative-publication regressions**
  - 在 `tests/evidence-publisher.test.ts` 建立 publication A 后发布 A+B 的红测：A 的论文版本文件字节保持不变，根索引与作者/分类/主题索引更新为 A+B。
  - 增加未知人工文件仍阻止发布、同内容不同 run 产生不同 publication ID、旧 v1 receipt 仍可读取的回归测试。
  - 在 `tests/state-store.test.ts` 和新的 publication service 测试中证明：数据库拒绝 reservation 时，Vault、receipt、journal 与 staging 均不得被写入。

- [x] **I2. Implement publisher v2 plan/apply and receipt compatibility**
  - 在 `src/evidence/publisher.ts` 增加纯 `planEvidencePublication()` 与有副作用的 `applyEvidencePublication()`，publication ID 同时绑定 `runId`、累计内容 hash 和 publisher version。
  - `applyEvidencePublication()` 只接受三种已安装状态：空 Vault、与 predecessor 精确一致、与目标累计投影精确一致；未知文件或不匹配字节继续返回 `EVIDENCE_CONFLICT`。
  - 扩展 `src/evidence/receipt-store.ts`，严格读取 publisherVersion 1/2；保留既有 v1 首发与崩溃恢复兼容性。
  - 运行 publisher/receipt 聚焦测试和类型检查，通过独立规格复审后勾选。

- [x] **I3. Add reserve-first cumulative publication service**
  - 在 `src/state-store.ts` 增加按确定顺序读取已完成 publication run 的只读接口，不直接信任 Vault 文件作为历史来源。
  - 新建 `src/evidence/publication-service.ts`：重新验证所有已完成 run 的 Archive，按 `(baseId, version)` 构造 predecessor 与 current 的确定性并集；同一身份不同 Archive hash 必须失败。
  - 服务必须先生成纯计划，再执行 normal/failed/historical reservation，只有 reservation 成功或幂等重放后才允许创建临时目录、journal、receipt 或修改 Vault。
  - apply 失败时将已 reservation 的 publication 标记 failed；恢复时复用同一 publication ID 并继续完成。
  - 用真实 StateStore 集成测试覆盖 A -> A+B、reservation 拒绝零写入、apply 失败后恢复和 v1 历史兼容；通过独立规格复审后勾选。

- [x] **I4. Route every production publication path through the service**
  - `src/cli.ts` 的正常任务和菜单 6、`src/local-pdf-import.ts`、`src/maintenance/evidence-migration.ts` 不再直接执行“先写 Vault、后 reserve”。
  - 所有入口统一调用 publication service，并保持 normal、failed-recovery、historical-migration 三种 eligibility 语义。
  - 更新 `tests/evidence-cli.test.ts`、`tests/local-pdf-import.test.ts`、迁移与端到端流程测试，证明调用顺序和错误可恢复性。
  - 运行 publication 相关测试、全量串行测试与类型检查，通过独立代码质量复审后勾选。

- [x] **I5. Recover and verify the failed production run without re-parsing**
  - 对 run `739bac0f-7868-4915-968c-288a14e069f1` 仅执行 Evidence 恢复发布，不重新 discovery、download 或 MinerU parse。
  - 验证旧 publication 的 10 篇与新 run 的 10 篇均存在；旧论文正文/资源字节未改变，累计索引包含两批来源，SQLite 与 v2 receipt hash 一致，journal 已清理。
  - 重放同一恢复命令必须幂等成功；记录最终 publication ID、来源数、测试结果和残余风险后勾选。

## Phase H — Documentation and completion

- [ ] **H1. Update operational documentation**
  - 文档明确 OpenCLI 是 arXiv adapter boundary、API 为 operation-scoped fixed service、Archive 与 Obsidian projection 的关系、恢复命令和真实 smoke 命令。
  - 将旧 MinerU session plan 标注为由本 Trellis task 接管，保留历史提交事实。

- [ ] **H2. Final convergence and checklist audit**
  - PRD 所有 acceptance criteria 有测试或真实运行证据。
  - 本文件每个实际完成步骤标记 `[x]`，未完成项不得伪装完成。
  - 记录风险、环境信息、提交范围和测试结果。

## Supplement — Explicit direction picker (2026-09-06)

- [x] Replace implicit FSD CLI selection with discovery from `config/<libraryId>/library.yaml`; even one library requires a choice.
- [x] Add task-menu action `10` to switch libraries; rebuild per-library configuration and operation paths after selection.
- [x] Require `--library` for direct direction commands; retain direction-independent help and process cleanup helpers.
- [x] Update README, user manual, config/source documentation and legacy CLI test invocations.
- [x] Verify isolated picker/switch/EOF tests, full regression suite and typecheck; do not run real collection or MinerU. Evidence: 2026-09-06, `bun test --timeout 30000` with isolated `FSD_TEST_ROOT`: 1146 pass / 4 gated skip / 0 fail (87 files); `bun run typecheck` and `git diff --check` pass. Full log: `D:/agent-data/tmp/pke-picker-final.log`. Production database/PDF/Vault paths remain absent.

## Supplement — arXiv cooldown diagnostics (2026-09-06)

- [x] Preserve `ARXIV_CAPACITY_LIMITED` and `ARXIV_COOLDOWN_ACTIVE` through public JobView sanitization, including a validated UTC `retryNotBefore`; never expose raw upstream diagnostics.
- [x] Display cooldown deadlines in Beijing time with same-direction/same-mode recovery guidance; retain existing pacing and cooldown policy.
- [x] Verify isolated SQLite checkpoints block requests during cooldown and only request the failed shard after expiry; workflow recovery preserves run identity.
- [x] Update the user manual; do not automatically execute live discovery, downloads or MinerU.
- [x] Complete full regression, typecheck and diff validation on `paper-knowledge-engine`: 2026-09-06, 1153 pass / 4 gated skip / 0 fail across 88 files; `bun run typecheck` and `git diff --check` passed. Isolated full log: `D:/agent-data/tmp/arxiv-fix-full.log`. No live arXiv request or production data modification in this implementation.

## Original rollback guidance

- B 阶段失败：保留 operation session 现状，不继续真实 MinerU；不得恢复 per-file temporary API。
- C 阶段失败：停止在自动化测试，修正服务端环境后再运行 GPU。
- D/E 阶段失败：不运行真实端到端任务，避免发布不完整 Wiki。
- G 阶段失败：保存真实日志与安全记录状态，停止批量运行；不得降低端口或 cleanup 校验绕过。

## Post-completion roadmap — not an L2 completion gate

L2 的 A–H 阶段全部完成并归档后，再创建独立 Trellis 任务实现无 LLM 的 L3 `02-Knowledge`。不得提前在本任务中添加人工主题页、方法对比或阅读笔记写入逻辑。
