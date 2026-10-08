<h1 align="center">Agent-Data</h1>

<p align="center">
  <strong>面向论文与公开数据的本地资料管理仓库</strong>
</p>

<p align="center">
  <a href="backend/projects/paper-knowledge-engine/package.json"><img src="https://img.shields.io/badge/Bun-1.4.0-000000?logo=bun&logoColor=white" alt="Bun 1.4.0" /></a>
  <a href="backend/projects/datawatch-data/package.json"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="#-亮点">亮点</a> ·
  <a href="#-项目概述">项目概述</a> ·
  <a href="#-核心技术与流程">核心技术与流程</a> ·
  <a href="#-论文方向库">论文方向库</a> ·
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-项目结构与数据目录">数据目录</a> ·
  <a href="#-开发与维护">开发与维护</a> ·
  <a href="#-许可证">许可证</a>
</p>

---

**Agent-Data** 将论文与公开数据的获取、校验、归档和 Obsidian 发布组织成可追溯的本地流程。选择论文方向库，或选择公开数据集，即可通过各自的 CLI 管理资料与任务状态。

当前提供 **Paper Knowledge Engine** 和 **DataWatch** 两个活动项目。两者均使用 Bun / TypeScript，不调用 LLM；源码与配置纳入 Git，运行数据、PDF、模型、Obsidian 内容和备份保存在代码目录之外。

## ✨ 亮点

| 特性 | 说明 |
| --- | --- |
| **确定性处理** | 按配置与规则执行获取、筛选和校验，保留原始资料与处理结果。 |
| **方向库隔离** | 8 个论文方向复用同一引擎，各自保存配置、数据库、PDF、Archive 和 Vault 内容。 |
| **来源可追溯** | 论文保留来源 PDF、页级文本和资源；DataWatch 记录完整 commit SHA 与文件校验清单。 |
| **本地资料管理** | 原件、运行状态、Obsidian 内容与备份分开保存，路径由本机配置指定。 |
| **中断后恢复** | 任务记录保留已完成工作；按项目操作说明重新运行，可恢复未完成任务。 |
| **校验与备份** | 论文提供 Archive 校验与 Evidence 发布；DataWatch 提供 SHA-256 校验、备份及恢复验证。 |

## 📌 项目概述

| 项目 | 适合什么需求 | 来源与输出 | 文档入口 |
| --- | --- | --- | --- |
| **Paper Knowledge Engine** | 按研究方向收集论文，建立可追溯的论文资料库。 | 自动来源为 arXiv，也支持显式导入本地 PDF；输出 Archive v2 与 Obsidian Evidence v3。 | [项目介绍](backend/projects/paper-knowledge-engine/README.md) · [使用手册](backend/projects/paper-knowledge-engine/使用手册.md) |
| **DataWatch** | 获取公开结构化数据集，保存并校验本机快照。 | 获取 4 个 Hugging Face 数据集的原始仓库文件，保留 CSV、Parquet、图谱快照等格式；支持 Obsidian 副本与备份。 | [项目介绍](backend/projects/datawatch-data/README.md) · [使用说明](backend/projects/datawatch-data/使用说明.md) |

论文引擎当前建设可追溯的资料层，人工知识层后续建设。DataWatch 每个数据集只保留最新快照，不调用 MinerU，也不将原始文件转换为 Excel；它复用论文引擎的部分运行时模块与网络配置，拥有独立的 CLI、资料目录和任务状态。

## 🧠 核心技术与流程

| 技术 | 用途 |
| --- | --- |
| **Bun 1.4.0 / TypeScript** | 两个活动项目的 CLI、任务逻辑与验证工具。 |
| **SQLite** | 论文引擎各方向的状态存储；DataWatch 使用文件清单与任务记录。 |
| **OpenCLI / arXiv** | 论文在线检索与发现。 |
| **本地 MinerU** | 论文 PDF 的解析，保留 Markdown、页级文本与资源。 |
| **Obsidian** | 论文 Evidence 与数据集副本的本地阅读入口。 |

```text
论文资料
OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU
  → Archive v2 → Obsidian Evidence v3

公开数据
Hugging Face → 固定 commit → 原件下载与 SHA-256 校验
  → 最新快照 → Obsidian 副本 / 备份
```

## 📚 论文方向库

| 方向库 | 稳定标识 | 主题 |
| --- | --- | --- |
| FSD 论文知识库 | `fsd` | 软件工程、程序分析、代码迁移与验证 |
| Agent Engineering | `agent-engineering` | Agent 应用工程、运行时、权限、测试与运维 |
| Multi-Agent Engineering | `multi-agent-engineering` | 多 Agent 协作、委派、通信、治理与评测 |
| LLM Post-Training | `llm-post-training` | SFT、偏好优化、RL、蒸馏、安全与后训练评测 |
| Agent Tool & RSI | `agent-tool` | 工具使用/生成、工具后训练与递归自我改进 |
| Agent & LLM Context | `agent-context` | Context 工程、上下文后训练与 RSI Context |
| Skill & Prompt Engineering | `skill-prompt-engineering` | Prompt 与可复用 Skill 的获取、组合、演化和评测 |
| Agent Memory | `agent-memory` | 运行时记忆、后训练记忆与 RSI 记忆 |

方向库配置以 `config/<library-id>/library.yaml` 为准。检索范围、任务配额与调度说明见[论文项目 README](backend/projects/paper-knowledge-engine/README.md)和[配置说明](backend/projects/paper-knowledge-engine/config/README.md)。

## 🚀 快速开始

### 环境准备

- **Windows / PowerShell**，安装 Git 与 **Bun 1.4.0**（与两个项目的 `packageManager` 一致）。
- 论文在线获取需要访问 arXiv；DataWatch 需要访问 Hugging Face。
- 论文解析需要本地 MinerU 环境与模型；按[论文配置说明](backend/projects/paper-knowledge-engine/config/README.md)设置实际安装路径与设备。

首次获取仓库：

```powershell
git clone https://github.com/ChaoDiDiaoAA/Agent-Data.git D:\agent-data
```

已有仓库可跳过克隆。以下 `D:\...` 路径均为当前默认示例；使用其他目录时，须同步调整项目路径配置。

### Paper Knowledge Engine：论文资料

先按[配置说明](backend/projects/paper-knowledge-engine/config/README.md)调整 `config/machine.local.yaml` 中的资料根路径、MinerU 环境与可选代理，再安装依赖并准备 OpenCLI：

```powershell
Set-Location D:\agent-data\backend\projects\paper-knowledge-engine
bun install --frozen-lockfile
bun src\cli.ts --library agent-context opencli-prepare
bun src\cli.ts
```

启动后先选择方向库，再选择操作。直接执行方向命令必须传入 `--library <library-id>`，例如查看 Agent & LLM Context 的抓取计划：

```powershell
bun src\cli.ts --library agent-context harvest-plan --mode current --format json
```

实际获取、解析、发布与恢复步骤见[使用手册](backend/projects/paper-knowledge-engine/使用手册.md)。

### DataWatch：公开数据集

先安装共享运行时所在项目的依赖（若已完成上一步可跳过前两行），再安装 DataWatch 依赖并准备本机配置：

```powershell
Set-Location D:\agent-data\backend\projects\paper-knowledge-engine
bun install --frozen-lockfile
Set-Location D:\agent-data\backend\projects\datawatch-data
bun install --frozen-lockfile
if (-not (Test-Path config\paths.local.json)) {
    Copy-Item config\paths.example.json config\paths.local.json
}
```

启动前编辑 `config/paths.local.json`：六个字段须为本机绝对 Windows 路径；`projectRoot` 与 `paperEngineRoot` 指向实际代码目录，原件、状态、Obsidian 与备份四个资料根须互不嵌套。具体字段见[使用说明](backend/projects/datawatch-data/使用说明.md)。

```powershell
bun src\cli.ts
```

在菜单中选择数据集与操作。DataWatch 无需准备 MinerU；来源清单、版本状态、校验、发布和备份命令见[项目 README](backend/projects/datawatch-data/README.md)。

## 📁 项目结构与数据目录

```text
agent-data/
├─ backend/projects/
│  ├─ paper-knowledge-engine/  论文引擎、方向配置与测试
│  ├─ datawatch-data/          公开数据集获取、校验与备份
│  └─ flowmate-data/           历史脚本与未实现项目
├─ data/                      运行状态与工作目录（不纳入 Git）
├─ backups/                   本机备份（不纳入 Git）
└─ tools/                     工具说明与本地 MinerU 环境
```

下表为当前默认路径示例，实际位置由本机配置决定；论文路径中的 `<library-id>` 对应所选方向库。

| 资料 | 论文引擎 | DataWatch |
| --- | --- | --- |
| **运行状态** | `D:\agent-data\data\paper-libraries\<library-id>`：SQLite、Archive、任务记录与工作目录 | `D:\agent-data\data\datawatch-data`：清单、任务记录与临时文件 |
| **原件** | `D:\paper\paper-knowledge-engine\<library-id>`：原始 PDF | `D:\paper\DataWatch`：来源仓库原始文件 |
| **Obsidian** | `D:\obsidian\data\paper-knowledge-engine\<library-id>`：Evidence 与索引 | `D:\obsidian\data\datawatch-data`：数据集副本与目录 |
| **备份** | `D:\agent-data\backups\paper-libraries\<library-id>`：各方向备份目标根 | `D:\agent-data\backups\datawatch-data`：备份包与清单 |

PDF、运行数据库、Archive、模型、Obsidian 内容及备份不提交到 Git；本机 MinerU 环境与模型位于 `tools/MinerU`，其安装信息由论文机器配置管理。

## 🛠 开发与维护

修改活动项目代码后，在对应项目目录执行现有验证命令：

```powershell
Set-Location D:\agent-data\backend\projects\paper-knowledge-engine
bun run typecheck
bun test --timeout 30000

Set-Location D:\agent-data\backend\projects\datawatch-data
bun run typecheck
bun test --timeout 30000
```

<details>
<summary>Git 分工与历史项目说明</summary>

- `main`：公共目录调整、维护，以及已经验收合并的项目成果。
- `paper-knowledge-engine`：论文引擎后续开发；完成并确认后合并到 `main`。
- 分支作用于整个仓库，不按目录自动隔离。提交前检查范围，避免夹带其他任务的修改。
- `flowmate-data` 尚未实现，保留历史脚本，不属于当前论文流程。
- 旧 README 记录的 FSD 快照标识为 `codex/fsd-legacy-snapshot-20260905`（`0521fc1`）；当前本地及远端未找到该分支，仅作历史参考。旧目录移除记录保留在 Git 历史中，日常入口以两个活动项目为准。

</details>

## 📄 许可证

本仓库代码采用 [MIT License](LICENSE)。论文与数据集的使用和再分发须遵守原始来源的许可；DataWatch 的来源、许可证据与使用边界见[使用说明](backend/projects/datawatch-data/使用说明.md)。
