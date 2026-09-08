# FSD / paper-knowledge-engine 复用审查

日期：2026-09-08。范围：当前工作树源码与机器指向的本地 MinerU 源码；只读检查，没有下载、启动解析、发布或修改引擎代码。目标限定为“从网上收集公开发票原件、公开字段标注与官方字段/格式资料”。下文“已实现”表示源码存在且调用路径明确，不代表本次已进行端到端运行验收。

## 结论

推荐保留 `flowmate-data` 作为发票样本项目，复用引擎底层运行、MinerU、哈希、HTTP、文件替换能力，新增一个很薄的样本流程。不要把发票伪装成 paper，也不要以“新增一个 research 方向配置即可工作”为实施前提。当前 research 模式对方向、类型、存储格式和全文解析均有硬限制，放宽这些限制再接完整发布链比复用底层成本更高。

一个重要区别：**FSD 的高层导入仅支持 PDF，但当前本地 MinerU 本身支持 JPG/PNG 等图片**。Flowmate 可以保留原图，通过底层 `MinerUCliJob.fileSource` 输入原图；无需先开发另一套图片转 PDF 服务。该桥接仍应通过 PDF/JPG/PNG 小样本验收后才能称为已完成。

## 当前功能、边界与复用判断

| 能力 | 当前实现事实 | 对 Flowmate 的判断 |
|---|---|---|
| 命令与库配置 | CLI 有 `run-task current/weekly/backfill`、`import-source`、`import-local`、`parse-local`、`evidence-publish`、`vault-rebuild`；通过 `--library` 选择库。[1] | 保留当前引擎命令服务原有库；Flowmate 单独提供样本命令，不复用论文任务命令作为发票接口。 |
| 新增 research 库 | `library_kind` 只允许 `paper/research`；research 强制完整的 15 个 Agent/Harness 方向，并封闭来源枚举。[2] | 不是任意主题通用数据库；发票领域不能只增加配置。 |
| OpenCLI | 运行器直接组装 `arxiv harvest`，adapter 安装目录和源码哈希也绑定 arxiv。[3] | 可继续使用现成 OpenCLI 工具做人工辅助发现；不能把 FSD runner 描述成全网搜索或动态适配框架。P0 使用已验证来源清单更省事。 |
| 官方网页 | `OfficialDocAdapter` 已接默认 CLI，读取明确提供的 `targets`，仅接受 UTF-8 `text/html`；保存 HTML、Markdown、HTTP 元数据；严格 HTML 子集。[4] | 对静态官方资料局部可复用。它不会全网搜索、爬取链接或自动下载页面中的发票图片/PDF，也不接收官方 PDF。 |
| Repository | 有 `RepositoryAdapter`，但需要显式 `RepositoryReadBoundary`，默认 CLI 不实例化。仅接受固定 commit/tag 和文本文件。[5] | 不是可直接拿来下载 GitHub 数据集压缩包/图片的入口。P0 使用明确下载地址或少量来源专用脚本。 |
| Release | 默认 CLI 注册 `ReleaseAdapter`，支持 GitHub 公共仓库固定 tag 的 release JSON；输出 release 正文及附件元数据。[6] | 不下载附件正文，不能当数据集下载器。 |
| 本地研究资料 | `LocalArtifactAdapter` 只允许 PDF 和文本扩展名；PDF 编码为 JSON 中的 base64，最终文件是 `content.txt`。还存在 benchmark 文件名/内容拒绝规则。[7] | 不适合发票数据集原件与标注配对，不能用于 JPG/PNG 样本入库。 |
| HTTP 下载基础 | `createHttpClient` 提供 HTTPS/域名检查、取消、超时、响应体上限及有限同源重定向；返回原始 bytes。[8] | 底层可复用，Flowmate 负责媒体类型、原文件哈希、来源许可和样本登记；跨 CDN 跳转不能假定可用，需要明确验证最终直链。没有通用重试循环或 ZIP 解包功能。 |
| 本地 MinerU 生命周期 | `createMineruApiSession` 启动本机 Python FastAPI、健康检查、复用进程、取消和清理；runner 只接受 `http://127.0.0.1:<port>`。[9] | 重点复用。名称含 API 但不是云 API，不能据此声称旧方案里的云 MinerU MCP 已实现。云端解析若未来需要，是独立新增适配器。 |
| 通用解析输入 | `MinerUCliJob` 仅强制 `model/fileSource/outputDir`，`arxivId` 可选；runner 将文件路径传给现成 MinerU CLI。[10] | 通过 Flowmate 的集中桥接文件调用 session/runner；传独立输出和运行路径，不走 `runLocalParse` 的论文 Archive/state。 |
| JPG/PNG 能力 | 机器配置固定 MinerU 3.4.5 和 commit；当前本地 HEAD 与固定 commit 一致、工作树干净。MinerU CLI 接受 pdf/images，图片在 `read_fn` 内部转为 PDF bytes，FastAPI 同样接受图像上传。[11] | 输入格式层面已有实现；无需先把每张图人工转 PDF。保留原始 JPG/PNG 为权威原件，MinerU 的内部转换与 Markdown 都是派生结果。尚未对真实发票做解析准确率验证。 |
| 解析结果规整 | `normalizeLocalMinerUResult` 读取 Markdown/content-list、规整页信息、引用资产与哈希；`normalizeMinerUPages` 提供页文本。`assessExtraction` 仅检查无文本、空页比例、乱码比例、页数等。[12] | 页文本/资产规整可局部复用，需 JPG/PNG 输出验收。质量检查不等于发票字段正确；不应把 OCR 输出直接当 gold 标注。 |
| 哈希与原子文件 | `canonicalJson/hashCanonical/archiveFileManifest`、路径验证、原子替换、运行锁均已实现。[13] | 优先集中复用；哈希算法不另造。Flowmate 新建 URL/文件/样本配对的业务身份规则。 |
| PDF 下载与去重 | `downloadAcceptedPdf` 有内容 hash 查重、PDF 魔数和页数检查，但输入与状态绑定 arxiv/baseId/primaryTrack。[14] | 复用校验思路或抽出的纯能力，不直接调用它存发票。 |
| Archive / Evidence | 不只 paper：存在 research Archive 和 Evidence/sources 链。但 paper Archive 强制 `source.pdf`，research Archive 只允许 content 文本/HTML/PDF/metadata JSON；两者均不是任意数据集资产目录。[15] | 可借鉴“原件/派生文本/索引”分层，不能宣称现成 Archive 支持图片样本+字段标注+DatasetManifest。Flowmate 定义更小资产清单。 |
| SQLite 与备份 | 通用 `createStateDatabase/backupStateDatabase` 已实现；备份使用 `VACUUM INTO` 后校验完整性。业务 state API 与 paper/research 表绑定。[16] | 如 Flowmate 保留 SQLite，可复用驱动和备份函数，单独 schema。P0 若 JSON 索引足够，不必仅为复用而引入任务数据库。 |
| Vault 重建 | `vault-rebuild` 枚举 Archive V2，以 `<baseId>-v<version>` 校验并调用 paper Evidence V3 渲染器。[17] | 不能用于 Flowmate 样本库直接恢复。Flowmate 用样本 manifest 重渲染少量 Markdown 即可；不复制完整发布事务系统。 |
| 许可/隐私/标注/训练导出 | 在审查的 `src/config` 未找到 license/PII/训练集分割或 DatasetManifest 业务实现；现有 SourceProvenance、ArchiveManifest 是技术来源/文件完整性语义。[18] | 必须新增最小业务字段：原始 URL/获取时间、许可及证据 URL、用途限制、样本类型、原件哈希、标注来源/状态、是否允许导出。公开可访问不自动代表可再分发。 |

## 最小复用边界

Flowmate 只新增：

1. **来源清单与采集**：以确定下载地址、公开数据集文件清单、官方资料链接为输入。来源目录页和真正文件 URL 分开保存；记录获取时间、许可来源，批量包保存发布版本/commit 与原始相对路径。P0 不做自动全网爬虫框架。
2. **样本登记与文件配对**：原件 PDF/JPG/PNG、发布方标注、OCR 派生结果各自独立；用原文件 SHA-256 识别同一原件，用来源内相对路径配对原标注，保留原始标注内容与映射版本。字段输出标明 `published_annotation`、`ocr_candidate` 或 `human_verified`，防止混淆。
3. **解析桥接**：集中依赖现有 `createMineruApiSession`、`MinerUCliJob` 和必要规整器，共用本机已固定的环境与模型；Flowmate 自己拥有 input/output/lock 目录和样本状态。直接原图输入的可达性由源码支持，真实效果通过小样本验收。
4. **简单索引与导出**：原件/元数据为权威数据，Obsidian 是派生 Markdown 目录和查询视图。保存 review/export 状态；未明确获准导出的样本不进入可分发 manifest。无需把所有材料硬塞进引擎的 Evidence/sources 事务。

建议把跨项目依赖集中在一个 `fsd-bridge` 文件或很小的内部门面，避免大量深路径 import。最初可在同一仓库中直接依赖已核实的纯函数/接口；抽独立 npm 包、增加新的通用 engine library kind、统一所有来源 adapter 均非 P0 必要条件。

## 为什么不选“新增 research 方向”

要完整承载发票样本，它至少需要改变 15-track 校验、来源类型及身份规则、LocalArtifact 二进制限制、Archive payload 白名单、图片全文解析、字段标注存储、Evidence 模板、独立备份/重建，以及 CLI 默认缺少的源目标/MinerU连接。单纯删一条 track 检查并不能完成这些适配。[2][7][15]

`research` 现成功能适合 Agent/Harness 资料研究；对于本次公开发票样本工作台，复用底层能保留已经解决的 Windows 进程管理、模型运行、哈希与文件安全问题，同时避免扩散修改研究和论文领域契约。

## 源码依据

以下路径基于本次读取的当前工作树，行号在后续代码修改后可能改变。`E` 表示 `D:/agent-data/backend/projects/paper-knowledge-engine`，`M` 表示 `D:/agent-data/tools/MinerU`。

- [1] `E/src/cli/routes.ts:521-547` 帮助文本；`:603-636` research/paper 路由限制与上下文组装。尤其 `:616` research 库拒绝 `mineru-config`，`:618` 拒绝 paper-only 操作。
- [2] `E/src/shared/engine-context.ts:14-23` 硬编码 research 15 tracks / 8 source kinds；`:698-701` 必须声明全部 source kinds；`:726` taxonomy 必须 15 tracks；`:747-792` research 库加载校验；`:810-813` library kind 分流。
- [3] `E/src/discovery/opencli-runner.ts:168-185` `buildArgs`；`E/src/runtime/opencli.ts:78` arxiv adapter 目录；`:140-141` arxiv 专用源码 hash。
- [4] `E/src/research/cli-runtime.ts:15-27` 默认注册列表；`E/src/research/adapters/official-doc-adapter.ts:13-19` HTML 严格子集；`:99-117` capture/discover。
- [5] `E/src/research/adapters/repository-adapter.ts:37-38` RepositoryReadBoundary；`:47-52` 固定 revision；`:66-75` 文本文件限定；`E/src/research/cli-runtime.ts:11-22` 说明 repository 边界由调用方注入且默认未实例化。
- [6] `E/src/research/adapters/release-adapter.ts:40-47` GitHub 端点；`:85-94` public 检查；`:152-181` 只归档 release 正文及附件元数据。
- [7] `E/src/research/adapters/local-artifact-adapter.ts:111` benchmark 文件名拒绝；`:127-141` PDF/文本及 benchmark 内容检查；`:131-133` PDF base64；`:201-204` `content.txt` JSON 输出；`E/src/research/research-parse.ts:17-24` 全文仅 paper/technical-report，且只认 source.pdf。
- [8] `E/src/research/http-client.ts:10-17` URL 域名检查；`:21-32` timeout/abort；`:35-88` GET、同源重定向、响应体上限和 bytes；`:63` 拒绝跨 origin。
- [9] `E/src/mineru/mineru-api-session.ts:13-16` session 接口；`:235` 工厂；`:273-298` 本地端口与 Python API 子进程；`E/src/mineru/mineru-cli-runner.ts:36-39` 回环 API URL；`:126-159` runner；`E/src/research/cli-runtime.ts:23-39` 默认依赖未注入 ResearchMineruBoundary，配合 `research-parse.ts:19` 可知此路径不能默认完成 research paper 全文。
- [10] `E/src/types/jobs.ts:103-105` MinerUCliJob；`E/src/mineru/mineru-cli-runner.ts:84-96` CLI args，`:135-143` 执行；`E/src/mineru/mineru-local-config.ts:80-94` 引擎/机器配置合并。
- [11] `E/config/machine.local.yaml:16-20` 固定 sourceRoot、版本和 commit。2026-09-08 只读执行 `git -C M rev-parse HEAD` 得到 `4fe4bde114a23ee5dd637eae99b767f4669bf58c`，`git status --short` 无输出；`M/pyproject.toml:128-134` mineru CLI/服务入口；`M/mineru/cli/common.py:42-43` pdf/image 扩展名；`:171-181` 图像转 PDF bytes；`M/mineru/cli/client.py:544-573` 输入文件接收；`M/mineru/cli/fast_api.py:83` 支持上传类型。未启动服务和解析，不能推断 OCR 正确率。
- [12] `E/src/mineru/mineru-local-result.ts:92-155` 结果规整与引用文件 hash；`E/src/mineru/page-text.ts:17-33` 页文本；`E/src/mineru/mineru-quality.ts:3-15` 提取质量规则。
- [13] `E/src/shared/manifest.ts:73-101` canonical/hash/manifest；`E/src/shared/archive-v2.ts:33-54` realpath 校验；`E/src/evidence/atomic-replace.ts:20` 文件替换；`E/src/runtime/run-lock.ts:69` 运行锁；`E/src/runtime/process.ts:201-238` 受控进程启动校验。
- [14] `E/src/library/sources/pdf-store.ts:116-201` 下载与 hash 去重；`E/src/library/sources/local-pdf-files.ts:39-86` 本地只扫描 PDF 及魔数、PDFDocument 验证。
- [15] `E/src/shared/archive-v2.ts:29-30` paper payload；`:71-104` paper Archive kind、PDF与字段约束；`:344-374` hash/PDF核验；`E/src/research/source-archive.ts:11-20` research manifest/payload；`E/src/evidence/source-publisher.ts:164-235` research Evidence 发布；`E/src/evidence/render-source.ts:87-113` research 渲染器。故不能一概说“Archive/Evidence只有论文”，也不能说“已支持任意原件”。
- [16] `E/src/runtime/sqlite.ts:56` 数据库驱动；`:109-140` 备份边界与 VACUUM/完整性校验；`E/src/library/state/research-state.ts:117-182` research-specific 表和 source/version 规则。
- [17] `E/src/maintenance/vault-rebuild.ts:4-8` paper Evidence/Archive imports；`:109-138` paper Archive 枚举和重建；`E/src/research/source-identity.ts:30-68` 来源 URL/版本身份实现，适合借鉴但不是全类型样本去重模型。
- [18] `E/src/types/research-sources.ts:16-24` 来源及版本契约；`E/src/research/source-archive.ts:11-14` manifest 契约；`E/src/shared/manifest.ts:5-9` 文件 manifest 契约；本次检索 `src/config` 的 `license/licence/redistribut/pii/privacy/consent/dataset.manifest` 未找到对应领域实现。结论仅针对本次审查范围。
