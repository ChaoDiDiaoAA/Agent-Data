# DataWatch 数据获取

DataWatch 是一个独立的 Bun 1.4 / TypeScript 项目，用于把四个公开 Hugging Face 数据集按固定 commit 下载、校验并归档到本机。项目只保存原始仓库文件，不把数据转换成 Excel，也不调用 MinerU：这些来源已经是 CSV、Parquet 和图谱快照等结构化文件。

## 四个数据集

| ID | 来源 | 文件格式 | 数据性质 |
| --- | --- | --- | --- |
| regulatory-affairs | [VaidhyaMegha/regulatory-affairs-kg](https://huggingface.co/datasets/VaidhyaMegha/regulatory-affairs-kg) | CSV、图快照 | openFDA 器械监管公开数据 |
| fda-recalls | [wapplewhite4/fda-recall-intelligence](https://huggingface.co/datasets/wapplewhite4/fda-recall-intelligence) | Parquet | FDA 召回公开样本 |
| procurement-pricing | [electricsheepafrica/pharmaceutical-procurement-pricing](https://huggingface.co/datasets/electricsheepafrica/pharmaceutical-procurement-pricing) | CSV、PNG、脚本 | CC BY 4.0 模拟采购数据 |
| hospital-resources | [diamondgible2/Hospital-Resource-And-Patient-Management-Dataset](https://huggingface.co/datasets/diamondgible2/Hospital-Resource-And-Patient-Management-Dataset) | CSV | 合成医院运营数据 |

完整操作步骤见[使用说明](使用说明.md)。

## 快速开始

~~~powershell
Set-Location D:\agent-data\backend\projects\datawatch-data
bun install --frozen-lockfile
Copy-Item config\paths.example.json config\paths.local.json
bun src\cli.ts
~~~

路径配置默认把原件保存到 D:\paper\DataWatch，机器状态保存到 D:\agent-data\data\datawatch-data，Obsidian 副本保存到 D:\obsidian\data\datawatch-data，备份保存到 D:\agent-data\backups\datawatch-data。可在 config/paths.local.json 中修改。

## 常用命令

~~~powershell
bun src\cli.ts sources list --format json
bun src\cli.ts source probe --dataset regulatory-affairs --format json
bun src\cli.ts run-task --all --format json
bun src\cli.ts status --format json
bun src\cli.ts config show --format json
bun src\cli.ts verify --format json
bun src\cli.ts catalog build --format json
bun src\cli.ts backup create --format json
bun src\cli.ts backup verify --path D:\agent-data\backups\datawatch-data\backup-YYYYMMDDHHMMSS.zip --format json
~~~

run-task --all 会固定每个来源当前的完整 commit SHA，枚举仓库全部文件，下载并校验；每个数据集只保留一个最新快照。完整 SHA 记录在 manifest、运行记录、versions.json 和备份清单中，任务中断后再次执行会复用同一配置下未完成的任务和已校验文件。

## 代码结构

src/config.ts 负责配置校验，src/huggingface.ts 负责版本和仓库树，src/downloader.ts 负责受限下载，src/task.ts 负责任务状态和恢复，src/catalog.ts 负责 Obsidian 发布，src/backup.ts 负责备份，src/cli.ts 和 src/cli/menu.ts 提供命令及交互菜单。

运行状态不写入项目源码目录。原始文件、状态、Obsidian 内容和备份均在项目外的四个根目录中保存。
