# 论文知识引擎重构与 FSD 方向库迁移设计

## 目标

把当前绑定 `fsd-code2doc` 名称、分散配置和深层 Evidence 目录的实现，重构为一套可供多个研究方向复用的纯 Bun 论文知识引擎。当前 FSD 方向库完成 OpenCLI/arXiv 发现、PDF 下载、本地 MinerU 解析、精简 Archive、确定性 Obsidian 发布与任务恢复；本阶段不引入 LLM 内容。

## 非目标

- 不实现 L3 人工知识层或 LLM Wiki。
- 不恢复 PowerShell 菜单外壳。
- 不复制引擎代码来创建新方向。
- 不长期兼容或双写 `01-Evidence`。
- 不把 MinerU 中间诊断文件发布到 Obsidian。

## 命名与路径

| 用途 | 目标 |
|---|---|
| 共享引擎 | `paper-knowledge-engine` |
| 当前方向库标识 | `fsd` |
| 当前方向库名称 | `FSD 论文知识库` |
| 代码 | `D:/agent-data/backend/projects/paper-knowledge-engine` |
| 活跃运行数据 | `D:/agent-data/data/paper-libraries/fsd` |
| 迁移快照 | `D:/agent-data/backups/paper-libraries/fsd` |
| Obsidian Vault | `D:/paper/fsd` |

旧的 `D:/agent-data/backend/projects/fsd-code2doc`、`D:/agent-data/data/fsd-code2doc`、`D:/paper/fsd-code2doc` 和 `D:/obsidian/data/fsd-code2doc` 只作为迁移来源，在完整验收后删除。

## 目标目录

### 引擎

```text
paper-knowledge-engine/
├─ config/
│  ├─ engine.yaml
│  ├─ machine.local.yaml
│  └─ libraries/fsd.yaml
├─ migrations/
├─ scripts/
├─ src/
│  ├─ cli/
│  ├─ discovery/
│  ├─ library/
│  ├─ mineru/
│  ├─ evidence/
│  ├─ runtime/
│  ├─ maintenance/
│  ├─ shared/
│  └─ cli.ts
├─ tests/
├─ CONTEXT.md
└─ package.json
```

### FSD 运行数据

```text
paper-libraries/fsd/
├─ library.sqlite
├─ archive/
│  └─ papers/<id>-vN/
├─ runs/
├─ operations/
└─ work/
   ├─ parsing/
   ├─ publishing/
   ├─ diagnostics/
   └─ tests/
```

### 单篇 Archive v2

```text
archive/papers/<id>-vN/
├─ manifest.json
├─ source.json
├─ source.pdf
├─ document.md
├─ pages.json
├─ content-list.json
└─ assets/
```

Archive v2 不长期保存 MinerU `origin.pdf`、`layout.pdf`、`span.pdf`、`middle.json`、`model.json`、`page-marked.txt`、原始工作目录或重复图片。

### FSD Vault

```text
D:/paper/fsd/
├─ .obsidian/
└─ Evidence/
   ├─ papers/<id>-vN/
   │  ├─ paper.md
   │  ├─ pages.md
   │  ├─ source.pdf
   │  └─ assets/
   └─ indexes/
      ├─ authors.md
      ├─ categories.md
      ├─ tracks.md
      └─ years.md
```

发布器排他拥有 `Evidence/`；Vault 根目录和未来人工知识层由用户拥有。旧 Vault 根目录四个默认/生成 Markdown 不迁移，只迁移验证后的 `.obsidian/`。

## 配置模型

- `engine.yaml`：共享的 OpenCLI/arXiv、MinerU、API 会话、运行时与 Evidence v3 行为。
- `machine.local.yaml`：本机根路径、MinerU 源码/虚拟环境/模型位置和设备信息。
- `libraries/fsd.yaml`：`libraryId`、显示名、开始日期、查询 Track、筛选策略、任务限额、调度和 Vault 目标。
- 路径由机器根与 `libraryId` 推导；业务代码不得硬编码 `fsd-code2doc`、`01-Evidence` 或旧绝对路径。

## 协议与状态

- 所有新任务请求和响应使用 `libraryId: string`；当前值为 `fsd`。
- 迁移全部 SQLite 行、run manifests、operation JSON 和 receipts；旧绝对路径重写到新根。
- Archive v2 与 Evidence v3 分别有集中式布局契约和严格校验器。
- 旧 Archive/Evidence 仅由一次性、hash-bound 的只读盘点和迁移适配器读取。
- 迁移命令必须先产生带 SHA-256 的 dry-run 清单，apply 必须提交相同清单哈希。

## 生命周期与删除

2026-09-05 变更确认：用户先要求“将旧代码保存git”，随后批准“采用可恢复归档并清空旧位置”。本次四个旧根及其冗余内容改为完整归档到外部备份根；下述永久删除目标不在本次执行，永久销毁必须另行确认。Git 保存旧代码的非忽略工作内容，完整目录归档额外保留忽略文件、独立 `.obsidian` 与测试链接。

- 成功任务清除自身 `work/parsing` 与 `work/publishing` 内容。
- 失败诊断保留三十天；启动恢复清除无主且超期工作目录。
- 迁移快照位于活跃数据根之外，最多保留最近两个已验证快照，并至少保留三十天。
- `bun-tests`、旧 Evidence staging、空 validation 目录、重复 PDF/图片和旧 Vault 投影在验收后永久删除。
- `node_modules` 只在新代码根通过 `bun install --frozen-lockfile` 重建；旧副本在切换后删除。
- 删除前必须停止 CLI、MinerU、OpenCLI、调度进程和 SQLite 写入者，并确认 WAL/SHM 已安全收束。

## CLI

唯一交互入口保持为：

```powershell
bun src/cli.ts
bun src/cli.ts --library fsd
```

菜单标题显示“论文知识引擎（Bun CLI）”和“当前方向库：FSD 论文知识库”。当前只有一个方向库时默认 `fsd`；未来新增方向只增加方向配置与独立数据/Vault。

## 迁移流程

1. 只读盘点旧代码、数据、数据库、Archive、Vault 和自动化。
2. 停止所有写入者并验证 SQLite 一致性。
3. 在外部备份根创建并校验迁移快照。
4. 在新代码路径完成配置、协议、Archive v2、Evidence v3 与 CLI 重构。
5. 复制并迁移运行状态、数据库路径、历史任务和 receipts。
6. 从验证后的 Archive 重建新 Vault，并迁移 `.obsidian/`。
7. 运行全部自动化验收和真实一篇论文 smoke test。
8. 切换入口与调度；移除引用旧路径的 Codex 自动化。
9. 输出固定四个旧根的归档清单，复核后可恢复移走旧根和冗余内容，并验证新入口不依赖旧位置。

## 验收门槛

- `bun test` 与 `bun run typecheck` 全部通过。
- 活动代码、配置、数据库、JSON 和新 Vault 中不存在旧项目名、旧根或 `01-Evidence`。
- SQLite `integrity_check` 为 `ok`，128 个已知旧路径单元格全部迁移。
- 20 篇历史 Archive 全部通过 manifest/hash/资源校验。
- 新 Vault 的论文数、PDF、图片和四个索引可由 Archive 确定性重建。
- 新论文完成发现、下载、任务级 MinerU API 解析、Archive 与 Evidence 发布。
- 人为中断解析后再次执行可以从固定选篇与已有下载恢复。
- 单独 Evidence 发布/恢复和 PDF/Evidence 对账通过。
- 旧位置移除前存在已验证快照、Git 旧代码快照与 hash-bound 可恢复归档清单；归档后逐文件复核。

## 已确认决策

本设计的命名、路径、目录、配置、Archive 保留级别、历史记录策略、Vault 所有权、迁移方式、清理策略与验收范围均已由用户选择“全按推荐”确认。
