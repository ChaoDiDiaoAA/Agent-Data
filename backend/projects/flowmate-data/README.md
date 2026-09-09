# FlowmateData 脚本

当前重构方案见 [P0 公开发票数据工作台目标方案 V2](docs/specs/P0_公开发票数据工作台目标方案_V2.md)，源码复用依据见 [FSD 复用审查](docs/research/2026-09-08-fsd-reuse-audit.md)，配置逐项说明见 [config/README.md](config/README.md)。本期只面向网上公开的发票资料与样本，不依赖企业内部数据。

目标位置：`D:\paper\Invoice` 保存网上下载的原始数据，`D:\agent-data\data\flowmate-data` 保存处理记录和派生结果，`D:\obsidian\data\flowmate-data` 保存可重建的 Obsidian 卡片。

## 存储边界

- `D:\paper\Invoice`：公开来源原件、发布方原始标注，以及一份只从 `dataRoot` 发布的结构化镜像。
- `D:\agent-data\data\flowmate-data`：机器主记录、标签、MinerU 解析结果、selection、Release、`policies/withdrawals.json` 撤回清单和运行状态；`work` 可随时删除重建。
- `D:\obsidian\data\flowmate-data`：`01_Index`～`05_Releases` 的可重建 Markdown；带 `generated_by: flowmate-data` 的文件由目录生成器管理，用户笔记不会被覆盖。
- `D:\agent-data\backups\flowmate-data`：带 SHA-256 manifest 的静止备份。

目录发布前应关闭 Obsidian 及其同步/写入插件，并让所有 Flowmate 命令通过同一个 `dataRoot/work/run.lock` 串行运行。发布会在写入前后检查 Vault 路径边界；检测到外部并发改变时立即失败，保留可恢复的事务条目，不按不可信路径删除文件。处理这类失败前先停止外部写入，再重新执行目录构建。

## 运行前准备

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

| 配置路径                                     | 含义                                                     | 示例                             |
| -------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `sample.source_id`                         | 样本来源登记 ID，对应`config/sources/<source_id>.json` | `voxel51-invoice-ocr`          |
| `sample.dataset_id`                        | 处理数据和 Obsidian 的数据集分区                         | `voxel51-hq-invoice-ocr`       |
| `sample.selection_id`                      | 固定选样清单 ID；同一 ID 重跑读取已提交清单              | `initial-20`                   |
| `sample.acquire_limit`                     | 当前任务获取并交给 MinerU 解析的带标注样本数             | `20`                           |
| `sample.publish_snapshot`                  | 标签映射后是否同步发布`D:\paper\Invoice` 结构化镜像    | `true`                         |
| `knowledge.source_ids`                     | 已登记的知识来源列表                                     | `[]`（当前不启用额外知识来源） |
| `knowledge.parse_source_ids`               | 已登记且允许解析的知识来源                               | `[]`                           |
| `release.version`                          | 默认 Release 版本                                        | `public-invoice-p0-v1`         |
| `release.include_originals`                | 是否在 Release 复制允许再分发的原件                      | `false`                        |
| `backup.verify` / `backup.restore_smoke` | 备份命令默认是否校验、独立恢复演练                       | `true` / `true`              |

命令行的 `--selection`、`--limit`、`--publish-snapshot`、`--include-originals`、`--verify` 和 `--restore-smoke` 会覆盖或开启对应默认值；没有显式 `--config` 时读取本机的 `config/workbench.local.json`。

下载并发、重试策略、来源跳转白名单、图片 32 MiB 大小上限和索引 16 MiB 大小上限属于安全实现约束，不放进业务配置，避免一次配置误把全库或不受信任的跳转放开。

当前公开来源的获取位置：

- `config/sources/voxel51-invoice-ocr.json`：唯一启用的原始数据来源。Hugging Face 数据集声明共 8,181 张发票图片，其中 1,489 条带结构化标注；程序只选有发布方标注的记录，再按原始 record ID 排序获取 `acquire_limit` 条图片及 `annotation.json`，不会下载全库。`record_count` 和 `annotated_record_count` 会阻止超过上限的采集。

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

菜单会从 `config/workbench.local.json` 读取唯一的 `sample.acquire_limit`，显示当前来源总量及可标注数量。菜单的“执行当前任务”会用同一个数量完成获取、标签映射、MinerU 解析、Obsidian、Release、校验和备份；菜单不会要求手工输入数量，也不会为菜单命令追加 `--limit`。修改配置后重新运行命令即可生效。

直接子命令仍可用于调试、自动化和兼容已有脚本，但属于高级模式。直接模式可显式传入 `--paths`、`--config`，并在确有需要时用 `--limit` 临时覆盖配置：

```powershell
bun src/cli.ts source probe voxel51-invoice-ocr --paths config/paths.local.json --config config/workbench.local.json
bun src/cli.ts acquire voxel51-invoice-ocr --limit 5 --paths config/paths.local.json --config config/workbench.local.json
```

`selected`、`downloaded`、`processed`、`cataloged`、`completed` 表示样本状态；`failed` 可从上一个成功状态恢复。`policies/withdrawals.json` 记录来源撤回条目，目录重建会标记为 `withdrawn`，Release 会拒绝再次发布。Release 默认不复制 `redistribution=unknown/denied` 的原件。真实 MinerU smoke 需要本机可用的 MinerU runtime，单元测试使用 fake session；实际当前任务数量由 `sample.acquire_limit` 决定。

`verify` 命令会校验当前样本、标签、结构化镜像、解析 receipt 并重建目录；输出中的 `projection_valid` 表示这些当前文件检查通过。重复采集是否新增 0 条和 FSD 数据是否未变化需要运行前后证据，因此会列在 `pending` 中，不能由一次静态校验伪造为完成。
