# Flowmate 配置说明

本目录把“机器存储位置”“工作台默认参数”和“公开来源登记”分开管理。命令从
`D:\agent-data\backend\projects\flowmate-data` 执行时，通常使用：

```powershell
bun src/cli.ts <command> --paths config/paths.local.json --config config/workbench.local.json
```

日常运行推荐直接使用菜单：

```powershell
& bun 'D:\agent-data\backend\projects\flowmate-data\src\cli.ts'
```

也可以运行下面的命令显式进入同一个菜单：

```powershell
& bun 'D:\agent-data\backend\projects\flowmate-data\src\cli.ts' menu
```

如果使用相对入口，必须先执行 `Set-Location 'D:\agent-data\backend\projects\flowmate-data'`。
在 `paper-knowledge-engine` 目录运行同名的 `bun src/cli.ts` 会进入论文方向库菜单，不会启动 Flowmate。
菜单会读取本机的
`config/workbench.local.json`：`sample.acquire.with_publisher_annotation` 和
`sample.acquire.without_publisher_annotation` 分别决定两类发票的数量，二者都会获取并交给 MinerU 解析。
菜单会在进入时显示这个任务数量，不会再要求手工输入数量，也不会为菜单生成 `--limit` 参数；修改配置后重新运行命令即可。

`paths.local.json` 是本机路径文件，不提交到 Git；当前工作区保留并跟踪 `workbench.local.json` 与
`mineru.local.json`，修改这两个配置后可以直接提交和运行。仓库不再保留 `*.example.json` 模板；首次使用按下面的完整结构创建这三个文件：

创建 `config/paths.local.json`：

```json
{
  "projectRoot": "D:\\agent-data\\backend\\projects\\flowmate-data",
  "paperEngineRoot": "D:\\agent-data\\backend\\projects\\paper-knowledge-engine",
  "originalRoot": "D:\\paper\\Invoice",
  "dataRoot": "D:\\agent-data\\data\\flowmate-data",
  "vaultRoot": "D:\\obsidian\\data\\flowmate-data",
  "backupRoot": "D:\\agent-data\\backups\\flowmate-data"
}
```

创建 `config/workbench.local.json`：

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

创建 `config/mineru.local.json`。这是 Flowmate 自己的 MinerU 配置，运行时不会读取
`paper-knowledge-engine/config/engine.yaml` 的 `mineru` 段：

```json
{
  "schema_version": 1,
  "mineru": {
    "source_root": "D:\\agent-data\\tools\\MinerU",
    "expected_version": "3.4.5",
    "expected_commit": "4fe4bde114a23ee5dd637eae99b767f4669bf58c",
    "python_version": "3.12",
    "venv_root": "D:\\agent-data\\tools\\MinerU\\.venv",
    "model_source_setup": "modelscope",
    "model_source_runtime": "local",
    "modelscope_revision": "master",
    "model_download_type": "all",
    "models_root": "D:\\agent-data\\tools\\MinerU",
    "modelscope_cache_root": "D:\\agent-data\\tools\\MinerU\\modelscope",
    "mineru_tools_config": "D:\\agent-data\\config\\mineru.runtime.json",
    "pipeline_models_dir": "D:\\agent-data\\tools\\MinerU\\modelscope\\models\\OpenDataLab--PDF-Extract-Kit-1.0",
    "vlm_models_dir": "D:\\agent-data\\tools\\MinerU\\modelscope\\models\\OpenDataLab--MinerU2.5-Pro-2605-1.2B",
    "pipeline_model_repository": "OpenDataLab/PDF-Extract-Kit-1.0",
    "pipeline_required_paths": [
      "models/Layout/PP-DocLayoutV2",
      "models/MFR/unimernet_hf_small_2503",
      "models/MFR/pp_formulanet_plus_m",
      "models/OCR/paddleocr_torch",
      "models/TabRec/SlanetPlus/slanet-plus.onnx",
      "models/TabRec/UnetStructure/unet.onnx",
      "models/TabCls/paddle_table_cls/PP-LCNet_x1_0_table_cls.onnx"
    ],
    "vlm_model_repository": "OpenDataLab/MinerU2.5-Pro-2605-1.2B",
    "expected_gpu_name": "RTX 5060 Laptop GPU",
    "mineru_install_extras": "all",
    "torch_index_url": "https://download.pytorch.org/whl/cu128",
    "lmdeploy_wheel_url": "https://github.com/InternLM/lmdeploy/releases/download/v0.11.1/lmdeploy-0.11.1+cu128-cp312-cp312-win_amd64.whl",
    "cuda_runtime_dll": "cudart64_12.dll",
    "model": "pipeline",
    "allowed_models": ["pipeline", "vlm"],
    "max_concurrency": 1,
    "processing_window_size": 1,
    "pipeline_batch_ratio": 1,
    "cuda_visible_devices": "0",
    "pipeline_device_mode": "cuda",
    "pipeline_method": "auto",
    "pipeline_language": "ch",
    "formula_enabled": true,
    "table_enabled": true,
    "vlm_device": "cuda",
    "vlm_lmdeploy_backend": "turbomind",
    "vlm_batch_size": 1,
    "vlm_cache_max_entry_count": 0.5,
    "task_timeout_seconds": 3600,
    "result_download_timeout_seconds": 600,
    "api_host": "127.0.0.1",
    "api_port": 17861,
    "api_startup_timeout_seconds": 120,
    "local_import": {
      "recursive": true,
      "max_files": 60,
      "max_pdf_pages": 200,
      "max_pdf_size_mb": 200,
      "default_track": "Local-PDF"
    }
  },
  "runtime": {
    "process_cleanup_timeout_ms": 10000,
    "diagnostic_timeout_ms": 20000,
    "max_output_bytes": 33554432
  }
}
```

## 共享引擎和 MinerU 前置

Flowmate 通过自身的 `config/mineru.local.json` 读取 MinerU 版本、源码、虚拟环境、模型目录、GPU、解析参数和进程策略；运行时不读取
`paper-knowledge-engine/config/engine.yaml`，也不通过 `--library fsd` 获取 MinerU 配置。
`paperEngineRoot` 只用于读取共享 `config/machine.local.yaml` 中的 HTTP 代理，让公开来源下载复用现有网络出口；这不是 MinerU 配置。
请先按 [Paper Knowledge Engine 使用手册](../../paper-knowledge-engine/使用手册.md) 安装或准备本机 MinerU、模型和 GPU，再把实际值填写到 Flowmate 配置：

```powershell
cd D:\agent-data\backend\projects\paper-knowledge-engine
bun install --frozen-lockfile
bun run typecheck
```

回到 Flowmate 项目后，所有工作台命令都在 Flowmate 根目录执行，不要加 `--library fsd`，也不要删除或改名 `config/mineru.local.json`：

```powershell
cd D:\agent-data\backend\projects\flowmate-data
bun install --frozen-lockfile
bun run typecheck
```

`parse` 命令会通过 bridge 为当前 selection 的整个批次启动一个 MinerU API，会话在批次完成或失败退出时统一回收；不需要先手工启动第二个 MinerU 服务，也不会为每张发票重复启动和清理 API。Windows 上批次开始实际解析时会申请系统执行状态，避免系统因空闲自动进入待机；批次结束或失败会释放该状态。电源键、合盖或系统强制待机仍可能中断进程。Flowmate 默认使用 `17861`，Paper Knowledge Engine 默认使用 `17860`，两个项目不要共用同一个端口。

两个项目虽然使用独立配置和端口，但通常共用同一套 MinerU 安装、模型和 GPU。共享会话会在
`source_root` 的上一级创建 `.fsd-mineru-resource.lock`，并在整个 API 会话期间持有它；因此
FSD 正在解析论文时，Flowmate 会在启动前明确报告 `MINERU_RESOURCE_BUSY`，等待 FSD 完成后再重试，
不会再让两个任务同时加载模型导致客户端只返回退出码 `1`。不要手工删除仍由运行中进程持有的锁文件。

## 先看结论：从哪里获取、获取多少

### 从哪里获取

获取位置不在 `workbench.local.json` 里写完整 URL，而是在 `config/sources/` 的来源登记文件中：

| 文件 | 来源 | 实际获取位置 |
|---|---|---|
| `sources/voxel51-invoice-ocr.json` | Voxel51 发票图片数据集 | `revision.url` 获取固定 revision；`record_locator.file_url_template` 获取 `samples.json` 和每条图片；`record_locator.index_path` 指定索引文件 |
| `workbench.local.json` | 设置本次两类样本的数量 | 来源和数据集固定为 Voxel51；这里只修改 `sample.acquire` |

Voxel51 是当前唯一登记的原始数据来源。数据集卡片声明总计 8,181 张发票图片，其中 1,489 条带结构化标注；获取流程先访问 revision API 和 `samples.json`，按来源 record ID 分别选择带发布方标注和无发布方标注记录，然后下载选中的图片。带标注记录另存发布方原始标注；无标注记录不会生成伪造标注。不会因为页面显示的总样本数而下载整个数据集。

### 获取多少

样本数量由 `config/workbench.local.json` 的 `sample.acquire` 两个字段控制：

| 参数 | 作用 | 当前默认值 |
|---|---|---:|
| `sample.acquire.with_publisher_annotation` | 当前任务选取、下载并交给 MinerU 解析多少条带发布方标注样本 | `100` |
| `sample.acquire.without_publisher_annotation` | 当前任务选取、下载并交给 MinerU 解析多少条无发布方标注样本 | `0` |
| `sample.acquire` | 两个字段之和就是本次获取和解析总数；不能为 0 | `100` |

例如，要获取并解析 50 条带标注和 20 条无标注发票，修改 `sample` 中的对象为：

```json
{
  "sample": {
    "acquire": {
      "with_publisher_annotation": 50,
      "without_publisher_annotation": 20
    }
  }
}
```

实际配置文件必须保留完整 JSON 结构，不能只保存这个字段。命令行 `--limit` 会临时覆盖对应命令的数量：

```powershell
bun src/cli.ts acquire voxel51-invoice-ocr --limit 50 --paths config/paths.local.json --config config/workbench.local.json
bun src/cli.ts parse --limit 3 --paths config/paths.local.json --config config/workbench.local.json
```

上面的 `--limit` 只适合高级模式下临时覆盖单个子命令，兼容旧脚本时表示带发布方标注数量。要在高级模式分别指定两类数量，可对 `acquire` 使用 `--with-publisher-annotation` 和 `--without-publisher-annotation`；菜单始终使用配置中的两个字段，因此获取和解析数量一致。

当前没有启用额外知识来源；新配置不再填写 `knowledge`。代码中的 `public-files` 读取器只为后续扩展保留，不代表当前会下载其他来源。

## 文件一：`paths.local.json`

这是本机实际配置文件；代码只读取它，不会因为读取配置而创建目标目录。

所有路径必须是绝对 Windows 路径；`originalRoot`、`dataRoot`、`vaultRoot`、`backupRoot` 不能互相包含或重叠。程序不会因为读取配置而创建这些目录。

| 参数 | 作用 | 本项目默认位置 |
|---|---|---|
| `projectRoot` | Flowmate 项目代码和配置根目录；用于定位项目文件 | `D:\agent-data\backend\projects\flowmate-data` |
| `paperEngineRoot` | 共享 Paper Knowledge Engine 根目录；只通过 bridge 复用 HTTP 代理等底层能力 | `D:\agent-data\backend\projects\paper-knowledge-engine` |
| `originalRoot` | 网上下载的原始文件、发布方原始标注，以及结构化镜像 | `D:\paper\Invoice` |
| `dataRoot` | 机器记录、selection、标签、MinerU 结果、Release 和策略文件 | `D:\agent-data\data\flowmate-data` |
| `vaultRoot` | 自包含 Obsidian Vault；保存物理数据副本、可重建 Markdown 卡片和索引 | `D:\obsidian\data\flowmate-data` |
| `backupRoot` | SHA-256 校验的静止备份和恢复演练目录 | `D:\agent-data\backups\flowmate-data` |

### 存储位置与配置参数的关系

- 原始数据保存到 `originalRoot`，不是 `dataRoot`。
- 结构化镜像也保存到 `originalRoot`，但只能由 `dataRoot` 单向发布。
- 机器记录和解析结果保存到 `dataRoot`。
- Obsidian 保存一份由权威根复制而来的发票原图、PDF、发布方标注、统一字段、record、receipt、snapshot、MinerU 结构化结果和 Release 文件，同时保存由机器记录重建的 Markdown；这些文件是副本，不会回写权威根。
- 不使用 `raw/<sha256>/` 目录；SHA-256 写在记录、快照和 manifest 中，用于校验和身份追踪。
- 来源探测和原始文件下载会复用 `paperEngineRoot/config/machine.local.yaml` 的 `network.http_proxy`；直连不稳定时必须先启动该代理。MinerU 的全部运行参数和进程策略保存在 Flowmate 自己的 `config/mineru.local.json`；Flowmate 不读取 `paperEngineRoot/config/engine.yaml` 的 MinerU 配置。`workbench.local.json` 只负责来源、当前任务数量、Release 和备份默认值。

### Obsidian 自包含副本

`catalog build` 是权威根到 Vault 的单向物理复制。数据资产不会创建指向权威根的符号链接或硬链接；Markdown 的临时发布只在 Vault 内部完成。Markdown 中也不会写入 `file:///` 或 `D:\paper\Invoice`、`D:\agent-data\data\flowmate-data` 的绝对路径，卡片中的 `[[...]]` 和 `![[...]]` 只指向 Vault 内文件。

目录结构采用与 FSD Vault 相同的 `Evidence` 托管根，并把每张发票的 Markdown 卡片和附件放在同一个实体目录：

```text
D:\obsidian\data\flowmate-data\
└─ Evidence\
   ├─ indexes\overview.md
   ├─ indexes\voxel51.md
   ├─ invoices\voxel51\000001\
   │  ├─ invoice.md
   │  ├─ original.jpg
   │  ├─ annotation.json       # 仅发布方带标注样本
   │  ├─ fields.json           # 仅已完成标注映射的样本
   │  ├─ record.json、receipt.json、snapshot.json
   │  ├─ content.md、content.json、pages.json、parse.json
   │  └─ assets\
   ├─ knowledge\<source>\<file>--<version>\knowledge.md  # 可选
   └─ releases\<version>\manifest.json、checksums.json    # 可选
```

运行后 Vault 的业务生成物只有 `Evidence/` 和二进制副本 hash 清单 `.flowmate-assets.json`；总览入口是 `Evidence/indexes/overview.md`。Flowmate 不再生成 `01_`、中文目录或卡片与同名附件目录并列的结构。

`D:\paper\Invoice` 与 `D:\agent-data\data\flowmate-data` 仍是权威位置：前者负责原件、发布方原始标注和结构化镜像，后者负责机器记录、统一字段、MinerU 结果、任务和 Release。Vault 副本由这些位置生成，Vault 中的手工修改不会被当作新的来源；相同 hash 的文件可重复执行，检测到手工改写或符号链接时会以冲突错误停止。

清空或升级旧的 Markdown-only Vault 后，直接运行：

```powershell
Set-Location 'D:\agent-data\backend\projects\flowmate-data'
bun src/cli.ts catalog build --paths config/paths.local.json --config config/workbench.local.json
```

`.flowmate-assets.json` 是 Vault 内部的复制清单，用来识别此前由 Flowmate 写入的二进制文件并安全地更新；不要手工编辑或删除它。

## 文件二：`workbench.local.json`

这个文件控制一次工作台运行的默认行为。当前工作区跟踪它，修改数量后直接重新运行即可。

### 顶层参数

| 参数 | 类型 | 作用 |
|---|---|---|
| `schema_version` | `1` | 工作台配置格式版本；当前只能是 `1` |
| `sample` | object | 样本数据集采集和解析默认值 |
| `release` | object | Release 是否复制原件 |
| `backup` | object | 备份命令默认校验和恢复演练开关 |

### `sample` 参数

| 参数 | 作用 | 当前值 |
|---|---|---|
| `acquire.with_publisher_annotation` | 当前任务选取、下载并交给 `parse` 命令处理的带发布方标注样本数 | `10` |
| `acquire.without_publisher_annotation` | 当前任务选取、下载并交给 `parse` 命令处理的无发布方标注样本数 | `10` |
| `acquire` | 两个数量之和，即当前任务获取与 MinerU 解析总数 | `20` |
| `publish_snapshot` | `labels map` 默认是否将标签结构化镜像发布到 `originalRoot` | `true` |

旧配置中的 `sample.acquire_limit` 仍可被读取并按“全部带发布方标注”兼容处理，但新配置不要再使用它；只要同时需要两类样本，就必须填写上面的 `acquire` 对象。

来源固定为 `voxel51-invoice-ocr`，数据集固定为 `voxel51-hq-invoice-ocr`，当前选样清单内部使用
`current` 名称保存到 `dataRoot/tasks/voxel51/selections/current.json`。因此只需修改
`sample.acquire`，不需要维护 `source_id`、`dataset_id` 或 `selection_id`。`current` 是自动追加游标：
未完成的当前批次会按原清单续跑；当前批次完整完成后，再次执行会排除所有已获取的
`source_record_id` 并追加下一批，旧的原件、record 和发票编号仍保留。每次替换前的清单和索引会归档到
`dataRoot/tasks/voxel51/selections/history/<selection-hash>.json`。额外知识来源当前不启用，
代码中的 `public-files` 读取器只为后续扩展保留。

### `release` 参数

| 参数 | 作用 |
|---|---|
| `include_originals` | 是否尝试把允许再分发的原件复制到 Release；`false` 时只发布索引、记录、标签、解析结果和来源证据 |

即使设置 `include_originals=true`，来源的 `redistribution` 不是 `allowed` 时也会失败，不会绕过许可限制。

Release 输出版本固定为 `public-invoice-p0-v1`。内容变化时会在校验通过后自动重建同名目录，
因此修改 `sample.acquire` 后不需要同步修改版本号；如果需要保留旧版本，请先复制 Release 目录或创建备份。

### `backup` 参数

| 参数 | 作用 |
|---|---|
| `verify` | `backup create` 完成后是否立即验证 manifest、文件集合和 SHA-256 |
| `restore_smoke` | 是否恢复到 `backupRoot/.restore-smoke-<uuid>` 独立目录，验证文件、结构化镜像并重建 Obsidian 卡片；成功后清理临时目录 |

正式备份保存在 `backupRoot/YYYYMMDD-HHMMSS/`（UTC 时间；同秒冲突顺延），目录中只有 `manifest.json` 和
`data.zip`。清单记录归档及内部文件校验信息；`verify` 检查归档完整性，
`restore_smoke` 实际恢复到独立目录并验证。`work` 中的临时文件和进程状态不进入备份。

## 文件三：`mineru.local.json`

这个文件只描述 Flowmate 调用 MinerU 所需的本机运行环境，不描述来源和样本数量；当前工作区跟踪已确认的运行配置。
它的 `mineru` 对象沿用共享 MinerU runner 的字段名称，但值由 Flowmate 单独维护；
`tempRoot`、`outputRoot` 和论文库身份不会从文件读取，而是固定派生为
`dataRoot/work` 和程序数据根，并且不设置 `libraryId/libraryPaths`。
MinerU API 下载结果先写入 `dataRoot/work` 下的短临时目录，规整并校验后发布到
`dataRoot/voxel51/000001/`。解析结果平铺保存为 `content.json`、`pages.json`、
`content.md` 和必要附属文件，解析批次和校验信息保存在 JSON 中。
`originalRoot/voxel51/000001/` 保存同一份解析副本和原件。失败不会将未校验的结果当作成功结果发布。

### 顶层参数

| 参数 | 作用 |
|---|---|
| `schema_version` | Flowmate MinerU 配置格式版本；当前只能是 `1` |
| `mineru` | MinerU 安装、模型、GPU、解析和本地 API 参数 |
| `runtime` | MinerU 进程监督的清理超时、诊断超时和输出上限 |

### `mineru` 参数

| 参数 | 作用 |
|---|---|
| `source_root` | MinerU 源码 checkout 根目录；运行时校验版本和 commit |
| `expected_version` | 允许的 MinerU 版本；写入解析 `parser_key` |
| `expected_commit` | 允许的 MinerU 源码完整 Git SHA；必须 40 位小写十六进制 |
| `python_version` | 该虚拟环境的 Python 主次版本记录 |
| `venv_root` | MinerU Python 虚拟环境；必须位于 `source_root` 内 |
| `model_source_setup` | 模型安装来源；当前固定为 `modelscope` |
| `model_source_runtime` | 运行时模型来源；当前固定为 `local` |
| `modelscope_revision` | ModelScope 模型配置版本，例如 `master` |
| `model_download_type` | 模型准备范围，例如 `all` |
| `models_root` | 本机模型根目录 |
| `modelscope_cache_root` | ModelScope 缓存目录；必须位于 `models_root` 内 |
| `mineru_tools_config` | MinerU runtime JSON；其中的 pipeline/VLM 模型目录必须与本文件一致 |
| `pipeline_models_dir` | Pipeline 模型目录 |
| `vlm_models_dir` | VLM 模型目录 |
| `pipeline_model_repository` | Pipeline 模型仓库名；用于校验目录名 |
| `pipeline_required_paths` | Pipeline 模型目录中必须存在的相对文件或目录清单 |
| `vlm_model_repository` | VLM 模型仓库名；用于校验目录名 |
| `expected_gpu_name` | 预期 GPU 名称，供人工核对本机设备 |
| `mineru_install_extras` | MinerU 安装 extras 记录，例如 `all` |
| `torch_index_url` | PyTorch CUDA wheel 索引地址 |
| `lmdeploy_wheel_url` | VLM 所需 LMDeploy wheel 地址 |
| `cuda_runtime_dll` | CUDA runtime DLL 文件名记录 |
| `model` | 本次任务使用的模型；当前为 `pipeline` |
| `allowed_models` | 允许的模型集合；当前固定为 `pipeline` 和 `vlm` |
| `max_concurrency` | MinerU API 最大并发；当前固定为 `1` |
| `processing_window_size` | API 处理窗口大小；当前为 `1` |
| `pipeline_batch_ratio` | Pipeline 虚拟显存批量比例，可选 `1/2/4/8/16` |
| `cuda_visible_devices` | 传给 MinerU 的 `CUDA_VISIBLE_DEVICES`，例如 `0` |
| `pipeline_device_mode` | Pipeline 设备模式；当前为 `cuda` |
| `pipeline_method` | Pipeline 解析方法：`auto`、`txt` 或 `ocr` |
| `pipeline_language` | Pipeline 语言参数，例如 `ch` |
| `formula_enabled` | 是否启用公式解析 |
| `table_enabled` | 是否启用表格解析 |
| `vlm_device` | VLM 设备；当前为 `cuda` |
| `vlm_lmdeploy_backend` | VLM LMDeploy 后端；当前为 `turbomind` |
| `vlm_batch_size` | VLM 批量大小 |
| `vlm_cache_max_entry_count` | VLM 缓存占用比例，范围为 `(0, 1]` |
| `task_timeout_seconds` | 单个 MinerU 任务超时 |
| `result_download_timeout_seconds` | MinerU 结果下载超时 |
| `api_host` | 本地 MinerU API 监听地址；只能是 `127.0.0.1` |
| `api_port` | 本地 MinerU API 端口；Flowmate 默认 `17861`，应与其他项目的 MinerU 服务区分 |
| `api_startup_timeout_seconds` | API 健康检查等待时间 |
| `local_import.recursive` | 共享 runner 的本地导入是否递归；Flowmate 当前不从 FSD 导入 |
| `local_import.max_files` | 本地导入文件数上限 |
| `local_import.max_pdf_pages` | 本地导入 PDF 页数上限 |
| `local_import.max_pdf_size_mb` | 本地导入 PDF 大小上限 |
| `local_import.default_track` | 共享 runner 的默认本地导入 Track；Flowmate 当前不写入 FSD |

### `runtime` 参数

| 参数 | 作用 |
|---|---|
| `process_cleanup_timeout_ms` | MinerU API 及其子进程清理超时 |
| `diagnostic_timeout_ms` | 读取 MinerU 版本、Git 和运行时诊断的超时 |
| `max_output_bytes` | 受监督进程 stdout/stderr 总输出上限 |

修改 MinerU 配置后重新运行菜单即可。解析记录会把版本、commit、模型、方法、
语言和开关写入 `parser_key`，因此配置变化会生成新的解析 attempt，不会覆盖旧结果。

## 文件四：`sources/voxel51-invoice-ocr.json`

这是 `dataset-records` 类型来源。它描述“从哪里读 revision、索引和图片”，不描述本机存储路径，也不决定获取数量。

### 通用来源参数

| 参数 | 作用 |
|---|---|
| `schema_version` | 来源登记格式版本，当前为 `1` |
| `source_id` | 来源身份；当前固定为 `voxel51-invoice-ocr`，由程序与工作台内部默认值校验 |
| `dataset_id` | 来源数据集身份；当前固定为 `voxel51-hq-invoice-ocr`，由程序与工作台内部默认值校验 |
| `reader` | 读取器类型；Voxel51 使用 `dataset-records` |
| `homepage` | 来源说明页，用于记录 provenance 和卡片链接 |
| `record_count` | 数据集总发票图片数；当前为 `8181` |
| `annotated_record_count` | 来源声明的带结构化标注发票数；当前为 `1489`，是 `sample.acquire.with_publisher_annotation` 的硬上限 |
| `record_count - annotated_record_count` | 按来源声明推导的无发布方标注数量；当前为 `6692`，是 `sample.acquire.without_publisher_annotation` 的硬上限 |
| `revision` | 版本解析方式；`kind=huggingface-api`，`url` 是读取完整 commit SHA 的 API 地址 |
| `record_locator` | 数据记录定位规则 |
| `allowed_origins` | 初始请求允许的 origin |
| `redirect_origins` | 下载时允许跳转到的 CDN origin；每一跳都检查。Voxel51 当前登记 `https://cdn-lfs.hf.co`、`https://cas-bridge.xethub.hf.co` 和 `https://us.aws.cdn.hf.co` |
| `declared_license` | 来源声明的许可证名称 |
| `license_evidence` | 许可证证据页面；支持 `{revision}` 占位符 |
| `retention` | 是否允许本地留存：`allowed`、`unknown`、`denied` |
| `local_use` | 是否允许本地处理：`allowed`、`unknown`、`denied` |
| `redistribution` | 是否允许再分发：`allowed`、`unknown`、`denied` |
| `origin_kind` | 数据性质：`synthetic`、`official_example`、`public_redacted`、`public_document` 或 `unknown` |
| `language` | 来源主语言，例如 `en`、`zh-CN` |
| `document_kind` | 文档类型：`invoice`、`receipt`、`invoice_template` 或 `knowledge` |

### `revision` 参数

| 参数 | 当前值 | 作用 |
|---|---|---|
| `revision.kind` | `huggingface-api` | 使用 Hugging Face revision API 获取完整 commit SHA |
| `revision.url` | `https://huggingface.co/api/datasets/Voxel51/high-quality-invoice-images-for-ocr/revision/main` | 获取当前 `main` 指向的完整 revision；结果会写入 selection |

### `record_locator` 参数

| 参数 | 当前值 | 作用 |
|---|---|---|
| `index_path` | `samples.json` | revision 内的样本索引文件 |
| `file_url_template` | `https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/{revision}/{path}` | `{revision}` 替换为完整 SHA，`{path}` 替换为图片或索引路径 |

`samples.json` 中 `json_annotation` 非空且可解析为非空对象的记录归为“带发布方标注”；缺失、空字符串、`null` 或空对象归为“无发布方标注”；格式错误或其他类型归为“无效标注”，只统计不采集。程序按 `sample.acquire.with_publisher_annotation` 和 `sample.acquire.without_publisher_annotation` 分别选取，不根据图片文件名排序，也不按目录顺序猜测标注配对。

Voxel51 图片的 `resolve` URL 当前会从 `https://huggingface.co` 返回 302，落到
`https://us.aws.cdn.hf.co` 后再返回图片；索引或其他文件可能使用前两个 CDN
origin。三个 origin 都必须逐字登记在 `redirect_origins` 中，签名查询参数只用于
请求，不写入回执或日志。若来源后续出现新的跳转 origin，采集会在写入原件前以
`REDIRECT_ORIGIN_NOT_ALLOWED` 失败；先核验它确实属于该来源，再把精确的 HTTPS
origin 加入本文件并补充回归测试，不能改成通配符或自动接受新域名。

## 菜单与参数覆盖优先级

菜单使用 `workbench.local.json` 的 `sample.acquire` 作为数量的唯一来源；选择采集或解析时不会要求输入数量，也不会自动添加 `--limit`。默认 `selection_id=current` 时，当前批次未完成会续跑，当前批次完成后下一次执行会自动排除已获取的 `source_record_id` 并追加下一批；旧批次的原始文件、record 和发票编号不会被覆盖。恢复标记按阶段记录：获取阶段已经开始或失败时续用当前清单，获取前的探测阶段失败时重试会继续追加游标。获取和 MinerU 菜单步骤都会按顺序处理每条发票，并显示 `[发票 i/总数]` 的开始、完成或失败状态；获取进度还会标明“带标注/无标注”。直接子命令仍支持命令行参数，适合调试、自动化和兼容已有脚本。

构建 Obsidian 时，菜单只显示 `[Obsidian 5/8] 构建 Obsidian 目录` 阶段的开始和完成行，不逐文件打印目录内部进度；开始后暂时没有新行时，表示正在进行来源校验、目录写入或清理。

菜单选择 **2** 执行的是一个完整工作流。运行状态保存在
`dataRoot/tasks/voxel51/runs/<run-id>/run.json`，同级任务锁覆盖整个工作流；如果进程中断或某个阶段失败，重新运行菜单并再次选择 **2** 会自动恢复相同配置下最近的未完成批次，跳过已经完成的阶段。MinerU 解析阶段为当前 selection 复用一个 API 会话，失败时在批次边界统一清理；MinerU 还会按原图 SHA-256、解析器身份、`parse.json` 和结构化文件清单验证已完成发票，只有验证通过的记录才会跳过。修改数量、`selection_id`、来源或 `mineru.local.json` 后，配置身份改变，会创建新的批次。

如果某张图片的 MinerU 结果包含有效的 `content-list.json`、`pages.json`，但 Markdown 为 0 字节，Flowmate 会从归一化页文本生成确定性的 `full.md`，再继续校验和发布；这只使用 MinerU 已返回的文字，不补造字段。若页文本也为空，错误会明确写出“empty Markdown and no recoverable page text”。在解析 receipt 写入前失败的 attempt 目录会清理，重试不会累积部分结果。

Obsidian 发布阶段另外使用 `vaultRoot/.flowmate-catalog.lock` 文件锁，文件中保存进程 PID 和启动身份。正常退出会清理锁；进程异常中止后，下一次目录构建会只回收已经退出进程的锁，并删除工具生成的 `.flowmate-catalog-staging-*` 孤立目录。空的旧版锁目录会自动迁移清理；没有 `.flowmate-assets.json` 的旧 Vault 只会在发票目录卡片带 `generated_by: flowmate-data` 时重建一次旧资产清单并刷新副本；非空目录、符号链接、未标记卡片和用户文件会保留并报告包含相对路径的冲突，不会自动删除。

任务开始前还会检查 `dataRoot/work/processes/active.json`。存在未确认清理的 MinerU 进程记录时会在探测前停止；应按
[Paper Knowledge Engine 运行时手册](../../paper-knowledge-engine/src/runtime/README.md)
先执行 `--inspect` / `--resolve`，确认安全后再重新选择 **2**，不能直接删除记录。

从高到低依次是：

1. 命令行显式参数，例如 `--limit 3`、`--with-publisher-annotation 5 --without-publisher-annotation 2`、`--selection regression-2026-09`。
2. `workbench.local.json`。
3. 来源文件中固定的 URL、revision、许可和跳转白名单；这些不是数量参数，不能用 `--limit` 改写。

常用命令：

```powershell
# 只探测 revision 和索引元数据，不下载图片
bun src/cli.ts source probe voxel51-invoice-ocr --paths config/paths.local.json --config config/workbench.local.json

# 只取带发布方标注的 5 条（高级模式临时覆盖）
bun src/cli.ts acquire voxel51-invoice-ocr --limit 5 --paths config/paths.local.json --config config/workbench.local.json

# 分别取 5 条带标注和 2 条无标注（高级模式临时覆盖）
bun src/cli.ts acquire voxel51-invoice-ocr --with-publisher-annotation 5 --without-publisher-annotation 2 --paths config/paths.local.json --config config/workbench.local.json

# 解析当前 selection 中的全部样本；数量来自 workbench.local.json，current 获取完成后下次执行会自动追加下一批
bun src/cli.ts parse --paths config/paths.local.json --config config/workbench.local.json

# 仅调试时临时解析前 2 条（不会改变 selection）
bun src/cli.ts parse --limit 2 --paths config/paths.local.json --config config/workbench.local.json

```

## 不放进业务配置的安全约束

以下规则固定在实现中，不能通过配置扩大范围：

- 单个发票下载和解析并发固定为 1；完整菜单任务另使用 `dataRoot/tasks/voxel51/task.lock`，各阶段内部使用 `dataRoot/work/run.lock` 串行化。
- 一个解析批次只持有一个 MinerU API 会话，按 selection 顺序逐条调用；批次结束或失败时统一释放，恢复运行会跳过已验证结果。
- Voxel51 revision API 读取上限为 2 MiB，`samples.json` 索引读取上限为 16 MiB，单张图片下载上限为 32 MiB。
- 重定向只能去 `redirect_origins` 明确登记的 origin。
- 不建立通用爬虫，不执行网页脚本，不把发现的新链接自动加入采集范围。
- `D:\paper\Invoice` 的结构化镜像只能由 `dataRoot` 单向发布，不能反向覆盖机器记录。
- 原件不可覆盖；来源 revision、record ID、文件 hash 和许可证据都保留在机器记录中。
- 带发布方标注的样本才有 `annotation.json`、`fields.json` 和标签校验；无发布方标注样本只有原图和 MinerU 解析结果，选择清单中的 `counts` 记录两类数量。
