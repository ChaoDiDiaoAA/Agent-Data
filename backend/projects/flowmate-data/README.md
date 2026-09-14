# FlowmateData 脚本

当前目录以本文“精简后的发票目录”为准，历史业务方案见 [P0 公开发票数据工作台目标方案 V2](docs/specs/P0_公开发票数据工作台目标方案_V2.md)，源码复用依据见 [FSD 复用审查](docs/research/2026-09-08-fsd-reuse-audit.md)，配置逐项说明见 [config/README.md](config/README.md)。本期只面向网上公开的发票资料与样本，不依赖企业内部数据。

目标位置：`D:\paper\Invoice` 保存网上下载的原始数据和结构化镜像，`D:\agent-data\data\flowmate-data` 保存机器记录与处理结果，`D:\obsidian\data\flowmate-data` 保存这些数据的物理副本以及可重建的 Obsidian 卡片。

## 存储边界

- `D:\paper\Invoice`：公开来源原件、发布方原始标注，以及一份只从 `dataRoot` 发布的结构化镜像。
- `D:\agent-data\data\flowmate-data`：机器主记录、标签、MinerU 解析结果、任务选样清单、Release、`policies/withdrawals.json` 撤回清单和运行状态；`work` 保存临时文件、进程记录及未完成事务，运行中不可删除。
- `D:\obsidian\data\flowmate-data`：Vault 自包含副本。自动发布器只拥有 `Evidence/`，其中按 FSD 风格保存 `invoices/`、`indexes/`、`knowledge/`、`releases/` 和英文命名的 Markdown；每张发票的原图、发布方标注、统一字段、record、receipt、snapshot、MinerU 解析文件和 assets 都物理复制到对应实体目录。带 `generated_by: flowmate-data` 的 Markdown 与 `.flowmate-assets.json` 由目录生成器管理，用户笔记不会被覆盖。
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
  Evidence\
    indexes\overview.md
    indexes\voxel51.md
    invoices\voxel51\000001\
      invoice.md
      original.jpg、annotation.json、fields.json
      record.json、receipt.json、snapshot.json
      content.md、content.json、pages.json、parse.json、assets\
    knowledge\<source>\<file>--<version>\knowledge.md  （可选）
    releases\<version>\manifest.json、checksums.json  （可选）
```

运行后 Vault 的业务生成物只有 `Evidence/` 和用于记录二进制副本 hash 的 `.flowmate-assets.json`；真正的索引从 `Evidence/indexes/overview.md` 打开。`Evidence/` 之外不生成 Flowmate 业务文件。

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

每张发票的 `invoice.md` 与附件位于同一个 Vault 实体目录。卡片中的 `![[...]]`、`[[...]]` 均指向 Vault 内部文件，例如 `Evidence/invoices/voxel51/000001/original.jpg`、`content.md` 或 `fields.json`；不依赖 `D:\paper\Invoice`、`D:\agent-data\data\flowmate-data` 的路径映射。发布文件位于 `Evidence/releases/<version>`，概览页通过 Vault 内部链接打开 `manifest.json`。

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

共享引擎的 `mineru-config` 只属于 Paper Knowledge Engine 自身的诊断命令，不是 Flowmate 的配置入口；Flowmate 的 `parse` 会通过 bridge 为整个当前批次创建一个 MinerU API，会话在批次结束或失败退出时统一回收，不会为每张发票重复启动和清理 API。两个项目共用 MinerU 安装时，bridge 会通过安装目录上一级的 `.fsd-mineru-resource.lock` 串行化 GPU 模型会话；FSD 正在解析时执行 Flowmate 会得到明确的 `MINERU_RESOURCE_BUSY`，应在 FSD 完成后重试。不要手工删除运行中任务持有的锁文件，也不要从 PDF 目录或 Obsidian 目录执行下面的命令。

## 配置

路径和运行参数分开配置：

- `config/paths.local.json`：本机目录位置配置；不会提交到 Git。字段和示例值见 [config/README.md](config/README.md)。
- `config/workbench.local.json`：本次工作台的采集、解析、Release 和备份默认参数；当前工作区保留这份配置，修改后可直接运行并提交。仓库不再保留 example 模板，首次使用按 [config/README.md](config/README.md) 创建。
- `config/mineru.local.json`：Flowmate 独立的 MinerU 安装、模型、GPU、解析和进程策略；当前工作区保留已确认配置，不能用 `paper-knowledge-engine/config/engine.yaml` 替代。
- `config/sources/*.json`：公开来源登记，真正的获取位置在这里，包括主页、revision API 或内容 URL、文件 URL、允许的重定向域名、许可证和是否解析。

`workbench.local.json` 只保留需要人工调整的参数。来源、数据集、选样清单名称、知识来源和 Release 版本都由当前 Flowmate 实现固定或自动生成，不需要随着数量修改。

```json
{
  "schema_version": 1,
  "sample": {
    "acquire": {
      "with_publisher_annotation": 10,
      "without_publisher_annotation": 10
    },
    "publish_snapshot": true
  },
  "release": { "include_originals": false },
  "backup": { "verify": true, "restore_smoke": true }
}
```

`workbench.local.json` 的可调整字段如下：

| 配置路径                                        | 含义                                                     | 示例                             |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `sample.acquire.with_publisher_annotation`    | 当前任务获取并交给 MinerU 解析的带发布方标注样本数       | `10`                           |
| `sample.acquire.without_publisher_annotation` | 当前任务获取并交给 MinerU 解析的无发布方标注样本数       | `10`                           |
| `sample.acquire`                              | 两个数量之和就是本次获取与解析总数                       | `20`                           |
| `sample.publish_snapshot`                     | 标签映射后是否同步发布`D:\paper\Invoice` 结构化镜像    | `true`                         |
| `release.include_originals`                   | 是否在 Release 复制允许再分发的原件                      | `false`                        |
| `backup.verify` / `backup.restore_smoke`    | 备份命令默认是否校验、独立恢复演练                       | `true` / `true`              |

来源固定为 `voxel51-invoice-ocr`，数据集固定为 `voxel51-hq-invoice-ocr`，当前选样清单内部使用
`current` 名称保存到 `dataRoot/tasks/voxel51/selections/current.json`。因此只需修改
`sample.acquire`，不需要维护 `source_id`、`dataset_id` 或 `selection_id`。`current` 是自动追加游标：
未完成的当前批次会按原清单续跑；当前批次完整完成后，再次执行会排除所有已获取的
`source_record_id` 并追加下一批，旧的原件、record 和发票编号仍保留。每次替换前的清单和索引会归档到
`dataRoot/tasks/voxel51/selections/history/<selection-hash>.json`，便于审计和恢复。Release 默认版本为
`public-invoice-p0-v1`，内容变化时会在校验通过后自动重建；不需要修改版本号。旧配置中仍存在的
这些字段仅为兼容历史脚本而读取，新配置不要再添加。

每次配置的两个数量都是“本次追加”的数量，不是数据集总量。`current` 会排除已经保存过的
`source_record_id`；因此来源索引中的实际剩余数量可能小于来源登记文件声明的数量。获取前会按固定
revision 重新统计，若请求超过剩余容量，会在下载前失败并显示 `requested`、`available`、
`already_acquired` 和 `source_total`（对应类别的来源总量），此时只需把对应的 `sample.acquire` 字段调小后重试。

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

菜单会从 `config/workbench.local.json` 读取两个 `sample.acquire` 数量，并显示带标注、无标注及合计。菜单的“执行当前任务”会用同一批合计数量完成获取、标签映射、MinerU 解析、Obsidian、Release、校验和备份；使用默认 `current` 时，每次完整完成后再次执行会自动追加下一批，进程中断或阶段失败会继续当前批次。恢复时只有已开始的阶段会携带恢复标记；如果任务在获取前的探测阶段失败，重试获取仍会按游标追加下一批。菜单不会要求手工输入数量，也不会为菜单命令追加 `--limit`。修改配置后重新运行命令即可生效。

“执行当前任务”会在 `D:\agent-data\data\flowmate-data\tasks\voxel51\runs\` 写入一份运行清单，并在同级使用任务锁。清单保存当前来源、选样名称、两个数量、配置哈希和九个阶段的状态；任务锁覆盖探测、获取、标签、解析、目录、Release、校验和备份的整个流程，避免两个终端同时修改同一批次。这个行为对应 `paper-knowledge-engine` 的 workflow lock、run record 和原子 manifest 设计。进程中断或某个阶段失败后，用同一条菜单命令再次选择 **2**，会自动找到相同配置下最近的未完成批次：已完成的阶段显示“恢复……跳过”，从第一个未完成阶段继续。MinerU 还会按发票检查 `record.json`、原图哈希、解析器配置和结构化解析文件；仍然有效的发票显示“跳过（已存在可复用解析结果）”，只有未完成或校验不通过的发票重新解析。修改 `sample.acquire`、`selection_id`、来源配置或 `config/mineru.local.json` 后，配置哈希变化会自动开始新批次，不需要手工改运行 ID。运行清单是机器状态，不能手工删除正在运行的批次；清空四个数据根重新开始时，运行清单也会一并清除。

Obsidian 目录发布使用 `D:\obsidian\data\flowmate-data\.flowmate-catalog.lock` 作为带进程身份的文件锁。正常退出会自动删除锁；进程被中止后，下一次运行会根据 PID 和启动身份回收已经退出进程留下的锁，并清理 `.flowmate-catalog-staging-*` 孤立目录。旧版本遗留的空锁目录也会在确认后迁移清理；没有 `.flowmate-assets.json` 的旧 Vault 会只对同一发票目录中带 `generated_by: flowmate-data` 卡片旁的旧资产建立一次迁移清单，再安全刷新 `record.json`、解析结果等副本。非空锁目录、符号链接、未标记卡片或用户文件仍会阻止发布；冲突信息会包含 Vault 内相对路径，便于定位。

获取阶段和 MinerU 阶段都会按顺序显示 `[发票 1/100]`、`[发票 2/100]` 等逐条进度。获取阶段会标明“带标注/无标注”，并显示开始、完成或失败；某条发票的“开始”与“完成”之间暂时没有新行时，表示该条仍在等待网络下载或 MinerU 返回。

单张图片获取遇到连接中断、`RESEARCH_TIMEOUT`、HTTP 408/429 或 5xx 时，会按 250 毫秒、1 秒、4 秒的间隔自动重试；不可恢复的错误或重试耗尽才会停止阶段。重试期间已完成的发票会保留，重新选择 **2** 时只会复用已校验的结果并继续失败位置。

MinerU 的 `ETIMEDOUT` 表示当前发票的 MinerU 客户端在 `config/mineru.local.json` 的 `task_timeout_seconds` 内没有返回；它不是“Request concurrency limited to 1”这条 API 启动日志导致的，也不代表前面的发票丢失。批次会在失败点停止，运行清单保留已完成阶段和已成功解析的发票；再次选择 **2** 会复用已有结果，只重试未完成发票。批次级会话复用避免了旧实现中每张发票重复启动、加载模型、清理 API 造成的累计超时和清理竞态；Windows 批次解析期间还会申请系统执行状态，使显示器可以关闭但系统不会因空闲自动进入待机，并在批次结束或失败时释放；用户主动按电源键、合盖或系统策略强制待机仍可能中断任务。若同一张发票在配置的单任务超时内仍失败，应根据错误诊断单独检查该原图和 MinerU 日志。

少数图片型记录可能让 MinerU 生成非空的 `content-list.json` 和 `pages.json`，但生成一个 0 字节的 Markdown 文件。Flowmate 会使用已经过资源引用改写的页文本生成确定性的 `content.md`/`full.md`，并重新计算内容哈希；这不会伪造业务字段，只保留 MinerU 已识别的文字。若结构化结果也没有可恢复页文本，任务才会失败，并在错误中列出缺失的文件。解析和校验完成、`receipt.json` 写入前产生的临时 attempt 会自动删除；因此失败重试不会留下可被误判为成功的半成品目录。

Obsidian 阶段显示外层阶段的开始和完成，并按**当前任务选择集**中的发票样本输出简短的开始/完成行，例如 `[Obsidian] 000911 开始`、`[Obsidian] 000911 完成（耗时 00:02）`；复制到 Vault 前后还会显示 `[Obsidian] 写入目录 开始/完成`。完成摘要中的“当前任务样本”只统计本次选择集数量；目录计划仍会纳入本地已保存的历史样本，以保持 Obsidian 累计目录完整。不会逐个打印样本内部的 `invoice.md`、`record.json` 或图片文件。目录计划校验使用排序扫描，避免样本较多时在最后阶段长时间无输出。

任务开始前会先执行 PKE 的 MinerU 进程安全检查；`dataRoot/work/processes/active.json` 存在且无法确认清理完成时，任务会在探测前停止，避免先下载一批数据再在解析阶段失败。按 PKE 手册先检查并安全解决该记录，再重新选择 **2**：

```powershell
bun 'D:\agent-data\backend\projects\paper-knowledge-engine\src\runtime\process-supervisor.ts' --inspect 'D:\agent-data\data\flowmate-data\work\processes\active.json'
bun 'D:\agent-data\backend\projects\paper-knowledge-engine\src\runtime\process-supervisor.ts' --resolve 'D:\agent-data\data\flowmate-data\work\processes\active.json'
```

直接子命令仍可用于调试、自动化和兼容已有脚本，但属于高级模式。直接模式可显式传入 `--paths`、`--config`，并在确有需要时用 `--limit` 临时覆盖配置：

```powershell
bun src/cli.ts source probe voxel51-invoice-ocr --paths config/paths.local.json --config config/workbench.local.json
bun src/cli.ts acquire voxel51-invoice-ocr --limit 5 --paths config/paths.local.json --config config/workbench.local.json
```

`selected`、`downloaded`、`processed`、`cataloged`、`completed` 表示样本状态；`failed` 可从上一个成功状态恢复。`policies/withdrawals.json` 记录来源撤回条目，目录重建会标记为 `withdrawn`，Release 会拒绝再次发布。Release 默认不复制 `redistribution=unknown/denied` 的原件。真实 MinerU smoke 需要本机可用的 MinerU runtime，单元测试使用 fake session；实际当前任务数量由 `sample.acquire` 两个字段之和决定。`--limit` 仍作为高级兼容参数，表示只取带发布方标注样本；需要两类同时运行时应修改配置或使用两个分类参数。

`verify` 命令会校验当前样本、标签、结构化镜像、解析 receipt 并重建目录；输出中的 `projection_valid` 表示这些当前文件检查通过。重复采集是否新增 0 条和 FSD 数据是否未变化需要运行前后证据，因此会列在 `pending` 中，不能由一次静态校验伪造为完成。
