# FlowmateData 脚本

当前目录以本文“精简后的发票目录”为准，历史业务方案见 [P0 公开发票数据工作台目标方案 V2](docs/specs/P0_公开发票数据工作台目标方案_V2.md)，源码复用依据见 [FSD 复用审查](docs/research/2026-09-08-fsd-reuse-audit.md)，配置逐项说明见 [config/README.md](config/README.md)。本期只面向网上公开的发票资料与样本，不依赖企业内部数据。

目标位置：`D:\paper\Invoice` 保存网上下载的原始数据和结构化镜像，`D:\agent-data\data\flowmate-data` 保存机器记录与处理结果，`D:\obsidian\data\flowmate-data` 保存这些数据的物理副本以及可重建的 Obsidian 卡片。

## 存储边界

- `D:\paper\Invoice`：公开来源原件、发布方原始标注，以及一份只从 `dataRoot` 发布的结构化镜像。
- `D:\agent-data\data\flowmate-data`：机器主记录、标签、MinerU 解析结果、任务选样清单、Release、`policies/withdrawals.json` 撤回清单和运行状态；`work` 保存临时文件、进程记录及未完成事务，运行中不可删除。
- `D:\obsidian\data\flowmate-data`：Vault 自包含副本。除 `01_总览.md`、`02_数据集`、`03_发票`、`05_发布` 的可重建 Markdown 外，还保存每张发票的原图、发布方标注、统一字段、record、receipt、snapshot、MinerU 解析文件和 assets；带 `generated_by: flowmate-data` 的 Markdown 与 `.flowmate-assets.json` 由目录生成器管理，用户笔记不会被覆盖。
- `D:\agent-data\backups\flowmate-data`：带 SHA-256 manifest 的静止备份。

目录发布前应关闭 Obsidian 及其同步/写入插件，并让所有 Flowmate 命令通过同一个 `dataRoot/work/run.lock` 串行运行。发布会在写入前后检查 Vault 路径边界；检测到外部并发改变时立即失败，保留可恢复的事务条目，不按不可信路径删除文件。处理这类失败前先停止外部写入，再重新执行目录构建。

## 精简后的发票目录

项目代码位置和 `config/paths.local.json` 的六个根路径保持不变。发票目录使用数据集短名 `voxel51` 与固定编号（例如 `000001`）；完整来源记录 ID、数据集版本、解析批次和哈希写在 JSON 中。

```text
D:\paper\Invoice\voxel51\000001\
  original.jpg       原始发票图片
  annotation.json    发布方原始标注（带标注样本才有）
  fields.json        标注映射后的发票业务字段（带标注样本才有）
  content.json       MinerU 结构化解析内容
  pages.json         分页信息
  content.md         解析正文
  record.json        来源、解析状态与校验元数据
  assets\            解析附属图片（有才创建）

D:\agent-data\data\flowmate-data\voxel51\000001\
  content.json、pages.json、content.md、record.json、assets\
  fields.json（带发布方标注样本才有）

D:\obsidian\data\flowmate-data\
  01_总览.md
  02_数据集\voxel51.md
  03_发票\voxel51\000001.md
  03_发票\voxel51\000001\
    original.jpg、annotation.json、fields.json
    record.json、receipt.json、snapshot.json
    content.md、content.json、pages.json、parse.json、assets\
  05_发布\<version>\manifest.json、checksums.json
```

每个数据集另有 `dataset.json`。发票目录还保留 `receipt.json`（下载凭据）、`parse.json`（解析来源及文件校验信息）和 `snapshot.json`（当前副本清单），用于校验与恢复，不能手工删除。最终发票目录不再包含 `datasets/samples/structured/parsed/attempt-长哈希/normalized` 层级。

### 权威文件与 Obsidian 副本

三个位置的职责不同：

| 位置 | 角色 | 内容 |
| --- | --- | --- |
| `D:\paper\Invoice` | 原始与结构化镜像权威根 | 下载的原图、发布方 `annotation.json`，以及从 `dataRoot` 发布的当前结构化镜像 |
| `D:\agent-data\data\flowmate-data` | 机器处理权威根 | `record.json`、`fields.json`、`receipt.json`、MinerU 结果、任务和 Release |
| `D:\obsidian\data\flowmate-data` | 展示与离线阅读副本 | 上述选定文件的物理复制，加上可重建的 Markdown 卡片 |

Obsidian 中的同名文件是复制品，修改它不会回写两个权威根。运行 `catalog build` 会按 record 和 snapshot 的 hash 重新补齐缺失副本；已有且 hash 相同的副本直接复用，手工改过的副本会报冲突并停止，避免静默覆盖。首次使用或清空 Vault 后直接重建即可：

```powershell
Set-Location 'D:\agent-data\backend\projects\flowmate-data'
bun src/cli.ts catalog build --paths config/paths.local.json --config config/workbench.local.json
```

每张发票卡片中的 `![[...]]`、`[[...]]` 均指向 Vault 内的实体文件，例如 `03_发票/voxel51/000001/original.jpg`、`content.md` 或 `fields.json`；不依赖 `D:\paper\Invoice`、`D:\agent-data\data\flowmate-data` 的路径映射。发布文件位于 `05_发布\<version>`，概览页通过 Vault 内部链接打开 `manifest.json`。

`content.json` 是 MinerU 识别出的文本、表格及坐标，不等同于业务字段；业务字段查看 `fields.json`。`D:\paper\Invoice\voxel51` 下所有 JSON（包括 dataset、annotation、fields、record、receipt、parse 和 snapshot）使用两空格缩进、换行及末尾换行。程序目录保存机器主副本，`D:\paper\Invoice` 保存原件和当前解析副本，Obsidian 保存一份物理副本；Obsidian Markdown 只使用 Vault 内部链接和嵌入，不使用 `file:///` 或指向上述权威根的绝对路径。格式转换必须通过程序同步更新校验清单，不要用编辑器批量重写受校验的文件。

### 发布方标注与 MinerU 解析结果

带发布方标注的已获取发票，其原始标注位于：

```text
D:\paper\Invoice\voxel51\<发票编号>\annotation.json
```

`annotation.json` 中的 `json_annotation` 是 Voxel51 发布方提供的结构化标注，可作为字段对照依据。相关文件的职责如下：
无发布方标注的样本不会创建这个文件；请以该样本的 `record.json` 中 `publisher_annotation_status` 判断类别。

| 文件                | 来源与用途                                                     |
| ------------------- | -------------------------------------------------------------- |
| `annotation.json` | Voxel51 发布方原始记录；其中`json_annotation` 保存发布方标注 |
| `fields.json`     | Flowmate 将发布方标注映射成统一发票字段后的结果                |
| `content.json`    | MinerU 从`original.jpg` 识别出的文本、表格、坐标和版面结构   |
| `record.json`     | 发票来源、数据集版本、处理状态和文件哈希等校验信息             |

对照关系为：

```text
annotation.json（发布方标注） → fields.json（统一字段）
original.jpg（发票图片）      → content.json（MinerU 解析结果）
```

发布方标注不等于字段全部完整。即使存在 `json_annotation`，币种、未税金额、税率、字段坐标等字段也可能没有提供，程序会在 `fields.json` 中将其标记为 `missing` 或 `ambiguous`。带发布方标注的记录会保存 `annotation.json` 并生成 `fields.json`；无发布方标注的记录仍会下载原图并交给 MinerU，但不生成伪造的 `fields.json`，记录会明确标记为 `publisher_annotation_status: unannotated`。

重新开始时保留代码、本地配置和 MinerU 模型，只清空四个数据根内的旧数据。启动下方菜单并选择 **2. 执行当前任务**，获取和解析数量读取 `sample.acquire.with_publisher_annotation` 与 `sample.acquire.without_publisher_annotation`，不需要重新输入。

## 运行前准备（依赖与模型）

Flowmate 复用 Paper Knowledge Engine 的 MinerU 启动、监督和结果规整代码，但不复用其 `config/engine.yaml` MinerU 配置；发票也不会注册成 FSD 论文或通过 `--library fsd` 运行。先按照 [Paper Knowledge Engine 使用手册](../paper-knowledge-engine/使用手册.md) 准备 MinerU 安装、模型和 GPU，再把实际路径和参数写入 Flowmate 自己的 `config/mineru.local.json`。公开来源 HTTP 代理仍从 `paperEngineRoot/config/machine.local.yaml` 的 `network.http_proxy` 读取：

```powershell
# 共享引擎项目：准备底层 MinerU 启动和规整代码
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun install --frozen-lockfile
bun run typecheck

# Flowmate 项目：检查自身依赖和独立 MinerU 配置
cd D:\agent-data\backend\projects\flowmate-data
bun install --frozen-lockfile
bun run typecheck
```

共享引擎的 `mineru-config` 只属于 Paper Knowledge Engine 自身的诊断命令，不是 Flowmate 的配置入口；Flowmate 的 `parse` 会通过 bridge 创建任务级 MinerU API，会话结束后自动回收。两个项目共用 MinerU 安装时，bridge 会通过安装目录上一级的 `.fsd-mineru-resource.lock` 串行化 GPU 模型会话；FSD 正在解析时执行 Flowmate 会得到明确的 `MINERU_RESOURCE_BUSY`，应在 FSD 完成后重试。不要手工删除运行中任务持有的锁文件，也不要从 PDF 目录或 Obsidian 目录执行下面的命令。

## 配置

路径和运行参数分开配置：

- `config/paths.local.json`：本机目录位置配置；不会提交到 Git。字段和示例值见 [config/README.md](config/README.md)。
- `config/workbench.local.json`：本次工作台的采集、解析、知识资料、Release 和备份默认参数；不会提交到 Git。仓库不再保留 example 模板，首次使用按 [config/README.md](config/README.md) 创建。
- `config/mineru.local.json`：Flowmate 独立的 MinerU 安装、模型、GPU、解析和进程策略；不会提交到 Git，不能用 `paper-knowledge-engine/config/engine.yaml` 替代。
- `config/sources/*.json`：公开来源登记，真正的获取位置在这里，包括主页、revision API 或内容 URL、文件 URL、允许的重定向域名、许可证和是否解析。

`workbench.local.json` 的关键字段如下：

| 配置路径                                        | 含义                                                     | 示例                             |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `sample.source_id`                            | 样本来源登记 ID，对应`config/sources/<source_id>.json` | `voxel51-invoice-ocr`          |
| `sample.dataset_id`                           | 处理数据和 Obsidian 的数据集分区                         | `voxel51-hq-invoice-ocr`       |
| `sample.selection_id`                         | 固定选样清单 ID；同一 ID 重跑读取已提交清单              | `initial-20`                   |
| `sample.acquire.with_publisher_annotation`    | 当前任务获取并交给 MinerU 解析的带发布方标注样本数       | `100`                          |
| `sample.acquire.without_publisher_annotation` | 当前任务获取并交给 MinerU 解析的无发布方标注样本数       | `0`                            |
| `sample.acquire`                              | 两个数量之和就是本次获取与解析总数                       | `100`                          |
| `sample.publish_snapshot`                     | 标签映射后是否同步发布`D:\paper\Invoice` 结构化镜像    | `true`                         |
| `knowledge.source_ids`                        | 已登记的知识来源列表                                     | `[]`（当前不启用额外知识来源） |
| `knowledge.parse_source_ids`                  | 已登记且允许解析的知识来源                               | `[]`                           |
| `release.version`                             | 默认 Release 版本                                        | `public-invoice-p0-v1`         |
| `release.include_originals`                   | 是否在 Release 复制允许再分发的原件                      | `false`                        |
| `backup.verify` / `backup.restore_smoke`    | 备份命令默认是否校验、独立恢复演练                       | `true` / `true`              |

`selection_id` 对应 `dataRoot/tasks/voxel51/selections/<selection_id>.json`，提交后会固定带发布方标注和无发布方标注两组数量。修改 `sample.acquire` 时必须同时换用新的 `selection_id`；菜单会在执行任务前读取本地清单，发现数量不一致会在探测、下载和 MinerU 之前停止并给出已固定数量、当前请求数量和新 ID 示例，避免运行到获取步骤才失败。

命令行的 `--selection`、`--limit`、`--publish-snapshot`、`--include-originals`、`--verify` 和 `--restore-smoke` 会覆盖或开启对应默认值；没有显式 `--config` 时读取本机的 `config/workbench.local.json`。

下载并发、重试策略、来源跳转白名单、图片 32 MiB 大小上限和索引 16 MiB 大小上限属于安全实现约束，不放进业务配置，避免一次配置误把全库或不受信任的跳转放开。

当前公开来源的获取位置：

- `config/sources/voxel51-invoice-ocr.json`：唯一启用的原始数据来源。Hugging Face 数据集声明共 8,181 张发票图片，其中 1,489 条带结构化标注；程序按两个配置数量分别选取带标注和无标注记录，再按原始 record ID 排序下载，两个组都会交给 MinerU，不会下载全库。`record_count` 和 `annotated_record_count` 会阻止超过声明上限的采集；索引中格式错误的标注会单独统计并跳过。

## 推荐运行方式

先按 [config/README.md](config/README.md) 创建三个本地配置并确认路径。为避免和
`paper-knowledge-engine/src/cli.ts` 混淆，推荐使用 Flowmate 的绝对入口；当前目录不影响启动：

```powershell
& bun 'D:\agent-data\backend\projects\flowmate-data\src\cli.ts'
# 也可以显式写出菜单模式
& bun 'D:\agent-data\backend\projects\flowmate-data\src\cli.ts' menu
```

如果使用相对入口，必须先进入 Flowmate 项目根目录：

```powershell
Set-Location 'D:\agent-data\backend\projects\flowmate-data'
bun src/cli.ts
```

不要在 `D:\agent-data\backend\projects\paper-knowledge-engine` 目录执行
`bun src/cli.ts`；那是论文知识引擎的方向库菜单，不会启动 Flowmate。

菜单会从 `config/workbench.local.json` 读取两个 `sample.acquire` 数量，并显示带标注、无标注及合计。菜单的“执行当前任务”会用同一批合计数量完成获取、标签映射、MinerU 解析、Obsidian、Release、校验和备份；菜单不会要求手工输入数量，也不会为菜单命令追加 `--limit`。修改配置后重新运行命令即可生效。

获取阶段和 MinerU 阶段都会按顺序显示 `[发票 1/100]`、`[发票 2/100]` 等逐条进度。获取阶段会标明“带标注/无标注”，并显示开始、完成或失败；某条发票的“开始”与“完成”之间暂时没有新行时，表示该条仍在等待网络下载或 MinerU 返回。

直接子命令仍可用于调试、自动化和兼容已有脚本，但属于高级模式。直接模式可显式传入 `--paths`、`--config`，并在确有需要时用 `--limit` 临时覆盖配置：

```powershell
bun src/cli.ts source probe voxel51-invoice-ocr --paths config/paths.local.json --config config/workbench.local.json
bun src/cli.ts acquire voxel51-invoice-ocr --limit 5 --paths config/paths.local.json --config config/workbench.local.json
```

`selected`、`downloaded`、`processed`、`cataloged`、`completed` 表示样本状态；`failed` 可从上一个成功状态恢复。`policies/withdrawals.json` 记录来源撤回条目，目录重建会标记为 `withdrawn`，Release 会拒绝再次发布。Release 默认不复制 `redistribution=unknown/denied` 的原件。真实 MinerU smoke 需要本机可用的 MinerU runtime，单元测试使用 fake session；实际当前任务数量由 `sample.acquire` 两个字段之和决定。`--limit` 仍作为高级兼容参数，表示只取带发布方标注样本；需要两类同时运行时应修改配置或使用两个分类参数。

`verify` 命令会校验当前样本、标签、结构化镜像、解析 receipt 并重建目录；输出中的 `projection_valid` 表示这些当前文件检查通过。重复采集是否新增 0 条和 FSD 数据是否未变化需要运行前后证据，因此会列在 `pending` 中，不能由一次静态校验伪造为完成。
