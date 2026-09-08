# Paper Knowledge Engine Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 FSD 专用工程重构为共享 `paper-knowledge-engine`，并把 FSD 数据和 Obsidian Vault 安全迁移到精简、可恢复、可扩展的新布局。

**Architecture:** 先在旧代码根内建立通用方向库配置、`libraryId` 协议、Archive v2 和 Evidence v3 契约，再通过 hash-bound 迁移工具复制并验证真实状态。新代码、数据和 Vault 独立通过验收后执行切换，最后才删除旧根和可重建冗余内容。

**Tech Stack:** Bun 1.4.0、TypeScript 7、SQLite、YAML、MinerU 3.4.5、本地 OpenCLI arXiv 适配器、Obsidian Markdown。

**Spec:** `docs/superpowers/specs/2026-09-04-paper-knowledge-engine-restructure-design.md`

## Global Constraints

- 唯一交互入口是 `bun src/cli.ts`；不得恢复 PowerShell 菜单外壳。
- 当前 `libraryId` 固定为 `fsd`，引擎名固定为 `paper-knowledge-engine`。
- 新代码根为 `D:/agent-data/backend/projects/paper-knowledge-engine`。
- 新数据根为 `D:/agent-data/data/paper-libraries/fsd`。
- 新 Vault 为 `D:/paper/fsd`，发布器只拥有其中的 `Evidence/`。
- 本阶段不生成 LLM 内容，不实现 L3 人工知识层。
- 任何迁移 apply 必须绑定先前 dry-run 结果的 SHA-256。
- 任何删除必须发生在端到端验收和迁移快照校验之后。
- 不覆盖或回滚当前工作树内用户已有修改。

---

### Task 1: 建立三层配置与方向库选择

**Files:**
- Create: `config/engine.yaml`
- Create: `config/machine.local.yaml`
- Create: `config/libraries/fsd.yaml`
- Create: `src/library/config.ts`
- Modify: `src/types/config.ts`
- Modify: `src/config.ts`
- Test: `tests/library-config.test.ts`
- Test: `tests/config-source.test.ts`

**Interfaces:**
- Produces: `loadEngineContext(options: { root: string; libraryId?: string }): EngineContext`
- Produces: `EngineContext = { engine: EngineConfig; machine: MachineConfig; library: LibraryConfig; paths: LibraryPaths }`
- Produces: `parseLibrarySelection(argv: string[]): { libraryId: string; argv: string[] }`

- [x] **Step 1: 写出三类配置的失败测试**

```ts
test('loads fsd through engine, machine, and library config only', () => {
  const context = loadEngineContext({ root: fixtureRoot, libraryId: 'fsd' });
  expect(context.library.libraryId).toBe('fsd');
  expect(context.library.startDate).toBe('2026-01-01');
  expect(context.paths.dataRoot).toBe('D:\\agent-data\\data\\paper-libraries\\fsd');
  expect(context.paths.vaultRoot).toBe('D:\\paper\\fsd');
});

test('rejects an unknown library id', () => {
  expect(() => loadEngineContext({ root: fixtureRoot, libraryId: 'missing' })).toThrow('UNKNOWN_LIBRARY');
});
```

- [x] **Step 2: 运行测试并确认旧加载器不能满足新契约**

Run: `bun test tests/library-config.test.ts tests/config-source.test.ts`

Expected: FAIL，错误指向缺失的 `loadEngineContext` 或仍读取旧的九文件配置。

- [x] **Step 3: 实现严格的配置类型与加载顺序**

```ts
export interface LibraryConfig {
  libraryId: string;
  displayName: string;
  startDate: string;
  overlapHours: number;
  currentTask: { maxPapers: number; trackLimits: Record<string, number> };
  weeklySchedule: WeeklySchedule;
}

export function loadEngineContext(options: { root: string; libraryId?: string }): EngineContext;
export function parseLibrarySelection(argv: string[]): { libraryId: string; argv: string[] };
```

将当前 MinerU/OpenCLI/runtime/Evidence 共享值合并到 `engine.yaml`，本机绝对路径和 MinerU 安装值写入 `machine.local.yaml`，FSD 查询、策略、日期与调度写入 `libraries/fsd.yaml`。未知字段和未知方向库必须失败关闭。

- [x] **Step 4: 运行配置测试、类型检查和旧配置引用扫描**

Run: `bun test tests/library-config.test.ts tests/config-source.test.ts tests/mineru-local-config.test.ts tests/schedule-config.test.ts`

Run: `bun run typecheck`

Run: `rg -n "paths\.local|pipeline\.yaml|query-matrix\.yaml|paper-policy\.yaml|evidence-policy\.yaml|runtime\.yaml|server\.yaml|mineru-local\.yaml" src tests`

Expected: 测试与类型检查通过；扫描结果只允许存在于迁移适配器测试夹具。

- [x] **Step 5: 精确提交配置模型**

```powershell
git add config/engine.yaml config/machine.local.yaml config/libraries/fsd.yaml src/library/config.ts src/types/config.ts src/config.ts tests/library-config.test.ts tests/config-source.test.ts
git commit -m "refactor: consolidate engine and library configuration"
```

### Task 2: 将任务协议从 projectId 改为 libraryId

**Files:**
- Create: `src/library/identity.ts`
- Modify: `src/operation-contracts.ts`
- Modify: `src/operation-service.ts`
- Modify: `src/operation-store.ts`
- Modify: `src/job-bridge.ts`
- Modify: `src/workflow.ts`
- Modify: `src/cli.ts`
- Test: `tests/operation-contracts.test.ts`
- Test: `tests/operation-service.test.ts`
- Test: `tests/job-bridge.test.ts`

**Interfaces:**
- Produces: `LibraryId` branded string and `assertLibraryId(value: unknown): LibraryId`
- Produces: `SubmitRequest = { libraryId: LibraryId; requestId: string; operation: Operation | InternalOperation }`
- Produces: `JobView.libraryId: LibraryId`

- [x] **Step 1: 写出协议拒绝旧字段的失败测试**

```ts
test('accepts libraryId and rejects projectId', () => {
  const request = validateRequest({ libraryId: 'fsd', requestId: 'req-1', operation: { kind: 'current' } });
  expect(request.libraryId).toBe('fsd');
  expect(() => validateRequest({ projectId: 'fsd-code2doc', requestId: 'req-1', operation: { kind: 'current' } })).toThrow('INVALID_REQUEST');
});
```

- [x] **Step 2: 运行协议相关测试并确认失败**

Run: `bun test tests/operation-contracts.test.ts tests/operation-service.test.ts tests/job-bridge.test.ts`

Expected: FAIL，因为当前协议要求 `projectId: fsd-code2doc`。

- [x] **Step 3: 实现 libraryId 单一身份并贯穿任务视图**

```ts
export type LibraryId = string & { readonly __libraryId: unique symbol };

export function assertLibraryId(value: unknown): asserts value is LibraryId {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(value)) {
    throw operationError('INVALID_REQUEST');
  }
}
```

请求校验使用精确字段集合；活动 JSON 不接受 `projectId`。CLI 从 Task 1 的选择结果注入 `libraryId`，operation store 按方向数据根隔离。

- [x] **Step 4: 运行任务恢复和协议回归测试**

Run: `bun test tests/operation-contracts.test.ts tests/operation-service.test.ts tests/operation-store.test.ts tests/job-bridge.test.ts tests/automatic-selection-resume.test.ts tests/three-paper-resume.test.ts`

Expected: PASS，恢复任务仍保持固定选篇与原 run ID。

- [x] **Step 5: 精确提交协议变更**

```powershell
git add src/library/identity.ts src/operation-contracts.ts src/operation-service.ts src/operation-store.ts src/job-bridge.ts src/workflow.ts src/cli.ts tests/operation-contracts.test.ts tests/operation-service.test.ts tests/job-bridge.test.ts
git commit -m "refactor: identify operations by library"
```

### Task 3: 建立方向运行区路径契约

**Files:**
- Create: `src/library/paths.ts`
- Modify: `src/state-store.ts`
- Modify: `src/task-artifacts.ts`
- Modify: `src/operation-store.ts`
- Modify: `src/run-lock.ts`
- Modify: `src/local-pdf-import.ts`
- Test: `tests/library-paths.test.ts`
- Test: `tests/state-store.test.ts`
- Test: `tests/local-pdf-import.test.ts`

**Interfaces:**
- Produces: `LibraryPaths`
- Produces: `deriveLibraryPaths(machine: MachineConfig, libraryId: LibraryId): LibraryPaths`

- [x] **Step 1: 写出无 state 包装层的路径测试**

```ts
test('derives the flat fsd runtime layout', () => {
  const paths = deriveLibraryPaths(machine, asLibraryId('fsd'));
  expect(paths.databasePath).toBe('D:\\agent-data\\data\\paper-libraries\\fsd\\library.sqlite');
  expect(paths.archiveRoot).toEndWith('paper-libraries\\fsd\\archive');
  expect(paths.workRoot).toEndWith('paper-libraries\\fsd\\work');
  expect(paths.backupRoot).toBe('D:\\agent-data\\backups\\paper-libraries\\fsd');
});
```

- [x] **Step 2: 运行路径与状态测试并确认失败**

Run: `bun test tests/library-paths.test.ts tests/state-store.test.ts tests/local-pdf-import.test.ts`

Expected: FAIL，因为当前路径仍含 `state/extracted`、`tmp` 和 `papers.sqlite`。

- [x] **Step 3: 实现唯一的 LibraryPaths 契约**

```ts
export interface LibraryPaths {
  dataRoot: string;
  databasePath: string;
  archiveRoot: string;
  runsRoot: string;
  operationsRoot: string;
  workRoot: string;
  backupRoot: string;
  vaultRoot: string;
}
```

所有状态、锁、任务产物和导入代码只能接收 `LibraryPaths` 或其中的明确字段，不再自行拼接旧目录名。

- [x] **Step 4: 运行路径安全与状态回归测试**

Run: `bun test tests/library-paths.test.ts tests/state-store.test.ts tests/operation-store.test.ts tests/local-pdf-import.test.ts tests/run-task.test.ts`

Run: `bun run typecheck`

Expected: PASS，且路径逃逸测试继续失败关闭。

- [x] **Step 5: 精确提交运行区契约**

```powershell
git add src/library/paths.ts src/state-store.ts src/task-artifacts.ts src/operation-store.ts src/run-lock.ts src/local-pdf-import.ts tests/library-paths.test.ts tests/state-store.test.ts tests/local-pdf-import.test.ts
git commit -m "refactor: centralize library runtime paths"
```

### Task 4: 创建精简 Archive v2 写入契约

**Files:**
- Create: `src/library/archive-v2.ts`
- Create: `src/library/archive-writer.ts`
- Modify: `src/mineru-workspace.ts`
- Modify: `src/mineru-local-result.ts`
- Modify: `src/evidence/archive-reader.ts`
- Modify: `src/evidence/contracts.ts`
- Test: `tests/archive-v2.test.ts`
- Test: `tests/mineru-local-result.test.ts`
- Test: `tests/evidence-archive-reader.test.ts`

**Interfaces:**
- Produces: `ArchiveSourceV2`
- Produces: `writeArchiveV2(input: ArchiveWriteInput): Promise<VerifiedArchiveV2>`
- Produces: `verifyArchiveV2(root: string): Promise<VerifiedArchiveV2>`

- [x] **Step 1: 写出只允许七类长期产物的失败测试**

```ts
test('writes a lean archive and excludes MinerU intermediates', async () => {
  const archive = await writeArchiveV2(fixtureInput);
  expect(await relativeFiles(archive.root)).toEqual([
    'assets/figure.jpg', 'content-list.json', 'document.md', 'manifest.json',
    'pages.json', 'source.json', 'source.pdf',
  ]);
  for (const forbidden of ['origin.pdf', 'layout.pdf', 'span.pdf', 'middle.json', 'model.json', 'page-marked.txt']) {
    expect(await containsBasename(archive.root, forbidden)).toBeFalse();
  }
});
```

- [x] **Step 2: 运行 Archive 和 MinerU 结果测试并确认失败**

Run: `bun test tests/archive-v2.test.ts tests/mineru-local-result.test.ts tests/evidence-archive-reader.test.ts`

Expected: FAIL，因为当前 Archive v1 保存原始工作目录和重复产物。

- [x] **Step 3: 实现 ArchiveSourceV2 和事务式发布**

```ts
export interface ArchiveSourceV2 {
  schemaVersion: 2;
  libraryId: LibraryId;
  sourceKind: 'arxiv' | 'local_pdf';
  baseId: string;
  version: number;
  pdfSha256: string;
  parser: { name: 'MinerU'; version: string; model: 'pipeline' | 'vlm'; method: 'auto' | 'txt' | 'ocr' };
  artifacts: {
    pdf: 'source.pdf';
    document: 'document.md';
    pages: 'pages.json';
    contentList: 'content-list.json';
    assetsRoot: 'assets';
  };
  files: { path: string; sha256: string; bytes: number }[];
}
```

先在 `work/parsing/<attemptId>` 校验 PDF、Markdown、页数据和全部资源，生成 canonical manifest 后再原子安装到 `archive/papers/<id>-vN`。成功后删除工作区；失败诊断移至 `work/diagnostics/<attemptId>`。

- [x] **Step 4: 运行 Archive 安全、资源引用和恢复测试**

Run: `bun test tests/archive-v2.test.ts tests/mineru-local-result.test.ts tests/evidence-archive-reader.test.ts tests/mineru-cleanup-gate.test.ts tests/mineru-session-smoke.test.ts`

Expected: PASS；缺失资源、哈希不符和路径逃逸均被拒绝。

- [x] **Step 5: 精确提交 Archive v2**

```powershell
git add src/library/archive-v2.ts src/library/archive-writer.ts src/mineru-workspace.ts src/mineru-local-result.ts src/evidence/archive-reader.ts src/evidence/contracts.ts tests/archive-v2.test.ts tests/mineru-local-result.test.ts tests/evidence-archive-reader.test.ts
git commit -m "feat: add lean archive v2 packages"
```

### Task 5: 实现 hash-bound Archive v1 到 v2 迁移

**Files:**
- Create: `src/maintenance/archive-migration.ts`
- Create: `tests/archive-migration.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/evidence-migration.test.ts`

**Interfaces:**
- Produces: `createArchiveMigrationPlan(input): Promise<ArchiveMigrationPlan>`
- Produces: `applyArchiveMigration(input & { planSha256: string }): Promise<ArchiveMigrationResult>`
- Produces CLI: `archive-migrate --dry-run --format json`
- Produces CLI: `archive-migrate --apply --plan-file FILE --plan-sha256 SHA256`

- [x] **Step 1: 写出计划漂移和重复产物清理测试**

```ts
test('refuses apply when the reviewed inventory changed', async () => {
  const plan = await createArchiveMigrationPlan(fixture);
  await appendFile(oldArchivePdf, 'changed');
  await expect(applyArchiveMigration({ ...fixture, planSha256: plan.sha256 })).rejects.toThrow('MIGRATION_PLAN_DRIFT');
});

test('migrates one v1 paper to one v2 package without duplicate images', async () => {
  const result = await applyReviewedPlan(fixture);
  expect(result.migrated).toBe(1);
  expect(result.prunedKinds).toContain('mineru-intermediate');
});
```

- [x] **Step 2: 运行迁移测试并确认命令尚不存在**

Run: `bun test tests/archive-migration.test.ts tests/evidence-migration.test.ts`

Expected: FAIL，错误指向缺失的迁移接口。

- [x] **Step 3: 实现只读盘点、canonical JSON 哈希和复制式 apply**

计划逐篇记录旧根、目标根、输入 manifest、目标文件、裁剪类别、字节数和 SHA-256。apply 重新计算所有输入哈希，只写新数据根，不修改旧 Archive；任一论文失败则该论文目标目录不出现。

- [x] **Step 4: 用夹具执行 dry-run、apply 与二次幂等执行**

Run: `bun src/cli.ts archive-migrate --dry-run --format json`

Run: `bun test tests/archive-migration.test.ts tests/evidence-migration.test.ts`

Expected: 测试夹具中首次 apply 成功，第二次返回 `replayed: true`，计划漂移返回非零状态。

- [x] **Step 5: 精确提交 Archive 迁移器**

```powershell
git add src/maintenance/archive-migration.ts src/cli.ts tests/archive-migration.test.ts tests/evidence-migration.test.ts
git commit -m "feat: add hash-bound archive migration"
```

### Task 6: 迁移 SQLite、runs、operations 与 receipts

**Files:**
- Create: `migrations/009-library-layout-v2.sql`
- Create: `src/maintenance/library-state-migration.ts`
- Create: `tests/library-state-migration.test.ts`
- Modify: `src/state-store.ts`
- Modify: `src/operation-store.ts`
- Modify: `src/evidence/receipt-store.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Produces: `createLibraryStatePlan(input): Promise<LibraryStatePlan>`
- Produces: `applyLibraryStatePlan(input & { planSha256: string }): Promise<LibraryStateResult>`
- Produces CLI: `library-migrate --dry-run --format json`
- Produces CLI: `library-migrate --apply --plan-file FILE --plan-sha256 SHA256`

- [x] **Step 1: 写出 128 个旧路径单元格和旧 projectId 的迁移测试**

```ts
test('rewrites every persisted path and operation identity', async () => {
  const result = await migrateFixtureState();
  expect(result.rewrittenDatabaseCells).toBe(128);
  expect(result.oldPathOccurrences).toBe(0);
  expect(result.oldProjectIdOccurrences).toBe(0);
  expect(result.libraryIds).toEqual(['fsd']);
});
```

- [x] **Step 2: 运行状态迁移测试并确认失败**

Run: `bun test tests/library-state-migration.test.ts tests/state-store.test.ts tests/operation-store.test.ts`

Expected: FAIL，因为当前数据库和 JSON 仍保存旧根及 `projectId`。

- [x] **Step 3: 实现复制、事务更新和严格计数断言**

数据库复制为 `library.sqlite` 后执行 `BEGIN IMMEDIATE`，更新 `papers.pdf_path`、六个 `parse_attempts` 路径列和 `evidence_publications.receipt_path`，再执行 `PRAGMA integrity_check`。迁移 19 个 operation JSON 和全部 run manifests；实际匹配数与 dry-run 计数不一致时回滚。

- [x] **Step 4: 验证完整性、外键和无旧路径残留**

Run: `bun test tests/library-state-migration.test.ts tests/state-store.test.ts tests/operation-store.test.ts tests/evidence-publication-service.test.ts`

Expected: PASS；`integrity_check=ok`、`foreign_key_check` 无行、旧路径计数为零。

- [x] **Step 5: 精确提交状态迁移器**

```powershell
git add migrations/009-library-layout-v2.sql src/maintenance/library-state-migration.ts src/state-store.ts src/operation-store.ts src/evidence/receipt-store.ts src/cli.ts tests/library-state-migration.test.ts
git commit -m "feat: migrate library state and operation history"
```

### Task 7: 实现 Evidence v3 紧凑布局

**Files:**
- Create: `src/evidence/layout-v3.ts`
- Modify: `src/evidence/render-paper.ts`
- Modify: `src/evidence/render-indexes.ts`
- Modify: `src/evidence/publisher.ts`
- Modify: `src/evidence/publication-service.ts`
- Modify: `src/evidence/receipt-store.ts`
- Modify: `templates/evidence/paper-index.md`
- Delete: `templates/evidence/vault-index.md`
- Delete: `templates/evidence/vault-readme.md`
- Delete: `templates/pdf-readme.md`
- Test: `tests/evidence-layout-v3.test.ts`
- Test: `tests/evidence-render-paper.test.ts`
- Test: `tests/evidence-render-indexes.test.ts`
- Test: `tests/evidence-publisher.test.ts`

**Interfaces:**
- Produces: `EVIDENCE_LAYOUT_V3`
- Produces: `renderEvidenceV3(sources: VerifiedArchiveV2[]): EvidenceFile[]`

- [x] **Step 1: 写出精确 Vault 文件集合测试**

```ts
test('renders one compact paper package and four aggregate indexes', () => {
  const paths = renderEvidenceV3([source]).map(file => file.relativePath).sort();
  expect(paths).toEqual([
    'Evidence/indexes/authors.md', 'Evidence/indexes/categories.md',
    'Evidence/indexes/tracks.md', 'Evidence/indexes/years.md',
    'Evidence/papers/2608.09072-v1/assets/figure.jpg',
    'Evidence/papers/2608.09072-v1/pages.md',
    'Evidence/papers/2608.09072-v1/paper.md',
    'Evidence/papers/2608.09072-v1/source.pdf',
  ]);
});
```

- [x] **Step 2: 运行 Evidence 测试并确认旧布局失败**

Run: `bun test tests/evidence-layout-v3.test.ts tests/evidence-render-paper.test.ts tests/evidence-render-indexes.test.ts tests/evidence-publisher.test.ts`

Expected: FAIL，因为当前渲染器仍写 `01-Evidence/sources/papers/...`、逐篇 JSON 和大量索引文件。

- [x] **Step 3: 实现集中式 v3 路径与托管边界**

```ts
export const EVIDENCE_LAYOUT_V3 = {
  schemaVersion: 3,
  root: 'Evidence',
  papersRoot: 'Evidence/papers',
  indexes: {
    authors: 'Evidence/indexes/authors.md',
    categories: 'Evidence/indexes/categories.md',
    tracks: 'Evidence/indexes/tracks.md',
    years: 'Evidence/indexes/years.md',
  },
} as const;
```

`paper.md` 合并元数据、导航和 MinerU Markdown；`pages.md` 从页数据确定性生成。发布 manifest 和 receipt 保存在运行数据区，不发布逐篇 JSON。发布器不得读取、修改或声明 Vault 根目录人工文件。

- [x] **Step 4: 运行发布幂等、冲突、资源和确定性测试**

Run: `bun test tests/evidence-layout-v3.test.ts tests/evidence-render-paper.test.ts tests/evidence-render-indexes.test.ts tests/evidence-publisher.test.ts tests/evidence-publication-service.test.ts tests/deterministic-evidence-flow.test.ts`

Expected: PASS；相同输入重复发布为 replay，资源缺失失败，`Evidence/` 外文件不参与冲突判断。

- [x] **Step 5: 精确提交 Evidence v3**

```powershell
git add src/evidence/layout-v3.ts src/evidence/render-paper.ts src/evidence/render-indexes.ts src/evidence/publisher.ts src/evidence/publication-service.ts src/evidence/receipt-store.ts templates tests/evidence-layout-v3.test.ts tests/evidence-render-paper.test.ts tests/evidence-render-indexes.test.ts tests/evidence-publisher.test.ts
git commit -m "feat: publish compact evidence v3 vaults"
```

### Task 8: 创建新 Vault 的全量重建与验证器

**Files:**
- Create: `src/maintenance/vault-rebuild.ts`
- Create: `src/evidence/vault-validator.ts`
- Create: `tests/vault-rebuild.test.ts`
- Create: `tests/vault-validator.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/vault-cleanup.test.ts`

**Interfaces:**
- Produces: `createVaultRebuildPlan(input): Promise<VaultRebuildPlan>`
- Produces: `applyVaultRebuild(input & { planSha256: string }): Promise<VaultRebuildResult>`
- Produces: `validateVault(input): Promise<VaultValidationReport>`

- [x] **Step 1: 写出仅迁移 .obsidian 且不迁移四个根 Markdown 的测试**

```ts
test('rebuilds a clean vault and preserves only Obsidian settings', async () => {
  const result = await rebuildFixtureVault();
  expect(await exists(join(result.vaultRoot, '.obsidian', 'app.json'))).toBeTrue();
  for (const name of ['欢迎.md', 'index.md', 'log.md', 'README.md']) {
    expect(await exists(join(result.vaultRoot, name))).toBeFalse();
  }
  expect(result.validation.brokenLinks).toBe(0);
  expect(result.validation.missingAssets).toBe(0);
});
```

- [x] **Step 2: 运行重建测试并确认失败**

Run: `bun test tests/vault-rebuild.test.ts tests/vault-validator.test.ts tests/vault-cleanup.test.ts`

Expected: FAIL，因为当前维护工具面向原地清理旧 Vault。

- [x] **Step 3: 实现 staging 重建、验证和原子安装**

重建目标先写入 `D:/paper/.fsd-rebuild-<publicationId>`；从旧 Vault 复制 `.obsidian/`，从全部验证 Archive v2 生成 Evidence v3，检查 Markdown 链接、资源、PDF 哈希、论文计数和四个索引，最后将 staging 原子安装为 `D:/paper/fsd`。目标已存在且内容不匹配时失败关闭。

- [x] **Step 4: 运行确定性重建与损坏注入测试**

Run: `bun test tests/vault-rebuild.test.ts tests/vault-validator.test.ts tests/evidence-publisher.test.ts tests/deterministic-evidence-flow.test.ts`

Expected: PASS；删除一张图片或篡改 PDF 后验证器必须报告精确相对路径。

- [x] **Step 5: 精确提交 Vault 重建器**

```powershell
git add src/maintenance/vault-rebuild.ts src/evidence/vault-validator.ts src/cli.ts tests/vault-rebuild.test.ts tests/vault-validator.test.ts tests/vault-cleanup.test.ts
git commit -m "feat: rebuild and validate direction vaults"
```

### Task 9: 按能力收拢源码并保持 CLI 薄入口

**Files:**
- Move: `src/cli-menu.ts` → `src/cli/menu.ts`
- Split: command routing from `src/cli.ts` → `src/cli/routes.ts`
- Move: `src/opencli-install.ts`, `src/opencli-runner.ts` → `src/discovery/opencli-install.ts`, `src/discovery/opencli-runner.ts`
- Move: `src/harvest-plan.ts`, `src/harvest-checkpoint.ts` → `src/discovery/harvest-plan.ts`, `src/discovery/checkpoint.ts`
- Move: `src/mineru-api-session.ts`, `src/mineru-cli-runner.ts`, `src/mineru-local-config.ts`, `src/mineru-local-result.ts`, `src/mineru-workspace.ts` → matching files under `src/mineru/`
- Move: `src/workflow.ts`, `src/pipeline.ts`, `src/worker.ts` → `src/library/workflow.ts`, `src/library/pipeline.ts`, `src/library/worker.ts`
- Move: `src/task-selection.ts`, `src/paper-policy.ts`, `src/metadata-verifier.ts` → matching files under `src/library/selection/`
- Move: `src/pdf-store.ts`, `src/pdf-text.ts`, `src/local-pdf-files.ts`, `src/local-pdf-import.ts`, `src/import-preview.ts` → matching files under `src/library/sources/`
- Move: `src/operation-contracts.ts`, `src/operation-service.ts`, `src/operation-store.ts`, `src/job-bridge.ts` → matching files under `src/library/operations/`
- Move: `src/run-window.ts`, `src/schedule-config.ts`, `src/scheduler.ts` → matching files under `src/library/schedule/`
- Move: `src/state-store.ts`, `src/task-artifacts.ts` → matching files under `src/library/state/`
- Move: `src/reconciliation.ts` → `src/maintenance/reconciliation.ts`
- Keep: `src/evidence/`, `src/runtime/`, `src/maintenance/`, `src/shared/`
- Modify: `src/cli.ts`
- Modify: `src/**/*.ts` imports
- Test: `tests/cli-only-boundary.test.ts`
- Test: `tests/module-boundaries.test.ts`

**Interfaces:**
- Produces: `main(argv?: string[], context?: MainContext): Promise<void>` as the only executable entry
- Produces: module-boundary rule preventing feature modules from importing CLI presentation code

- [x] **Step 1: 写出入口和模块边界测试**

```ts
test('keeps cli.ts as a thin executable', async () => {
  const source = await Bun.file(join(root, 'src', 'cli.ts')).text();
  expect(source.split('\n').length).toBeLessThan(80);
  expect(source).not.toContain('openStateStore(');
  expect(source).not.toContain('new MineruApiSession');
});
```

- [x] **Step 2: 运行边界测试并确认当前平铺结构失败**

Run: `bun test tests/cli-only-boundary.test.ts tests/module-boundaries.test.ts`

Expected: FAIL，因为当前 `src/cli.ts` 同时包含路由、状态打开、交互生命周期和业务执行。

- [x] **Step 3: 在修改对应能力时移动文件并消除根级转发壳**

`src/cli.ts` 只解析 `--library`、建立 `EngineContext`、调用 `runMenu` 或 `routeCommand` 并设置退出码。循环依赖检查必须覆盖 `cli → library → discovery/mineru/evidence/runtime` 的单向关系；不保留只做 re-export 的旧根文件。

- [x] **Step 4: 运行全量测试、类型检查和模块扫描**

Run: `bun test`

Run: `bun run typecheck`

Run: `rg -n "from ['\"]\./(opencli|mineru|workflow|pipeline|state-store|pdf-store)" src`

Expected: 全部通过；扫描无旧根模块导入。

- [x] **Step 5: 精确提交能力目录重组**

```powershell
git add src tests/cli-only-boundary.test.ts tests/module-boundaries.test.ts
git commit -m "refactor: organize the engine by capability"
```

### Task 10: 更新纯 Bun 菜单、包身份与使用文档

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/cli/menu.ts`
- Modify: `src/cli/routes.ts`
- Modify: `README.md`
- Modify: `使用手册.md`
- Modify: `config/README.md`
- Modify: `src/README.md`
- Modify: `tests/cli-menu.test.ts`
- Modify: `tests/cli-bootstrap.test.ts`
- Modify: `tests/schedule-config.test.ts`

**Interfaces:**
- Consumes: `parseLibrarySelection` and `EngineContext`
- Produces: `bun src/cli.ts` and `bun src/cli.ts --library fsd`

- [x] **Step 1: 写出菜单标题、默认方向和显式方向测试**

```ts
test('shows engine and selected library without changing menu numbering', async () => {
  const lines = await renderMenu({ libraryId: 'fsd', displayName: 'FSD 论文知识库' });
  expect(lines.slice(0, 3)).toEqual([
    '论文知识引擎（Bun CLI）',
    '当前方向库：FSD 论文知识库（fsd）',
    '=========================',
  ]);
  expect(lines).toContain('0. 退出');
});
```

- [x] **Step 2: 运行 CLI 测试并确认旧品牌失败**

Run: `bun test tests/cli-menu.test.ts tests/cli-bootstrap.test.ts tests/schedule-config.test.ts`

Expected: FAIL，因为当前标题和包名仍为个人论文知识库/`fsd-code2doc`。

- [x] **Step 3: 更新包名、CLI 帮助、菜单与文档中的确切命令**

`package.json.name` 改为 `paper-knowledge-engine`；所有任务脚本仍调用 Bun。调度任务名改为 `paper-knowledge-engine-fsd-weekly`。文档只展示新路径和三类配置，不保留 PowerShell 菜单命令。

- [x] **Step 4: 运行 CLI、锁文件和旧名称扫描**

Run: `bun install --frozen-lockfile`

Run: `bun test tests/cli-menu.test.ts tests/cli-bootstrap.test.ts tests/schedule-config.test.ts tests/cli-only-boundary.test.ts`

Run: `rg -n "个人论文知识库|fsd-code2doc|01-Evidence|npm run harvest:weekly" package.json bun.lock src config README.md 使用手册.md`

Expected: 测试通过；活动文件扫描为零。

- [x] **Step 5: 精确提交 CLI 与文档**

```powershell
git add package.json bun.lock src/cli README.md 使用手册.md config/README.md src/README.md tests/cli-menu.test.ts tests/cli-bootstrap.test.ts tests/schedule-config.test.ts
git commit -m "docs: expose the generic Bun knowledge engine CLI"
```

### Task 11: 实现工作区 GC 与 hash-bound 删除清单

**Files:**
- Create: `src/maintenance/work-gc.ts`
- Create: `src/maintenance/cleanup-plan.ts`
- Create: `tests/work-gc.test.ts`
- Create: `tests/cleanup-plan.test.ts`
- Modify: `src/cli/routes.ts`
- Modify: `src/library/workflow.ts`

**Interfaces:**
- Produces: `collectExpiredWork(input): Promise<WorkGcPlan>`
- Produces: `createCleanupPlan(input): Promise<CleanupPlan>`
- Produces: `applyCleanupPlan(input & { planSha256: string; confirm: true }): Promise<CleanupResult>`

- [x] **Step 1: 写出允许列表、期限和计划漂移测试**

```ts
test('never plans deletion of archive, sqlite, runs, operations, or obsidian settings', async () => {
  const plan = await createCleanupPlan(fixture);
  const targets = plan.entries.map(entry => entry.path);
  expect(targets.some(path => /archive|library\.sqlite|runs|operations|\.obsidian/.test(path))).toBeFalse();
  expect(targets).toContain(oldBunTestsRoot);
  expect(targets).toContain(oldEvidenceStagingRoot);
});
```

- [x] **Step 2: 运行清理测试并确认安全清单接口缺失**

Run: `bun test tests/work-gc.test.ts tests/cleanup-plan.test.ts tests/mineru-cleanup-gate.test.ts`

Expected: FAIL，因为当前没有统一生命周期和跨根删除计划。

- [x] **Step 3: 实现精确目标、原因、大小和 SHA-256 绑定**

仅允许计划已知旧根、`work/tests`、`work/publishing`、超三十天 diagnostics、旧 `bun-tests`、旧 Evidence staging、空 validation、Trellis `__pycache__` 和已验收的旧 Vault 投影。apply 逐项重新解析绝对路径、确认仍位于 allowlist 根、核对类型与计划哈希后删除；符号链接和新增未知内容必须中止。

- [x] **Step 4: 运行安全测试和 dry-run 输出测试**

Run: `bun test tests/work-gc.test.ts tests/cleanup-plan.test.ts tests/mineru-cleanup-gate.test.ts tests/vault-cleanup.test.ts`

Expected: PASS；Archive、数据库、`.obsidian`、`.trellis/tasks` 永远不进入清单。

- [x] **Step 5: 精确提交清理工具**

```powershell
git add src/maintenance/work-gc.ts src/maintenance/cleanup-plan.ts src/cli/routes.ts src/library/workflow.ts tests/work-gc.test.ts tests/cleanup-plan.test.ts
git commit -m "feat: add bounded work garbage collection and cleanup plans"
```

### Task 11.5: 关闭延期审查项并执行最终代码加固

本任务只修改工作树代码、测试和文档，不操作真实数据根、Vault、自动化或清理 apply。

- [x] **Step 1: 从分支移除误跟踪的 Task 4 SDD 输出，同时保留本地忽略副本**

- [x] **Step 2: 修复零论文 Vault 重建后的 bootstrap/同计划重放幂等性**

- [x] **Step 3: 统一 MinerU 页标记文本渲染，删除重复实现**

- [x] **Step 4: 更新自动化文档为新代码路径、三层配置和纯 Bun 命令**

- [x] **Step 5: 运行聚焦测试、全量测试、类型检查和独立审查**

### Task 12: 执行真实迁移、切换、验收与可恢复归档

2026-09-05 用户变更清理方式：先“将旧代码保存git”，再明确批准“采用可恢复归档并清空旧位置”。因此 Steps 9–10 改为四个固定旧根的完整归档，不永久销毁历史数据、设置或未跟踪文件。

**Files:**
- Move verified project tree to: `D:/agent-data/backend/projects/paper-knowledge-engine`
- Create verified data tree: `D:/agent-data/data/paper-libraries/fsd`
- Create verified snapshot tree: `D:/agent-data/backups/paper-libraries/fsd`
- Create verified Vault: `D:/paper/fsd`
- Remove after verification: the four old roots listed in the spec
- Update: `docs/superpowers/plans/2026-09-04-paper-knowledge-engine-restructure.md` checkboxes only as each step passes

**Interfaces:**
- Consumes every interface and migration command from Tasks 1–11
- Produces the operationally live FSD direction library on the new roots

- [x] **Step 1: 确认无写入者并完成 SQLite 收束**

Run read-only process checks for Bun, MinerU, OpenCLI and the FSD database. Stop only matching project processes, run SQLite WAL checkpoint through the project store, close it, and verify `library.sqlite-wal`/`library.sqlite-shm` are absent from the snapshot source.

Expected: 没有匹配写入者；旧数据库 `PRAGMA integrity_check` 返回 `ok`，旧 `papers.sqlite-wal`/`papers.sqlite-shm` 不存在。

- [x] **Step 2: 创建并验证迁移快照**

快照必须包含旧数据库、runs、operations、Archive、receipts、旧 `.obsidian` 和当前代码工作树；生成 canonical manifest 后逐文件复算 SHA-256。

Expected: 快照报告 `verified: true`，并位于 `D:/agent-data/backups/paper-libraries/fsd/<timestamp>`。

- [x] **Step 3: 在新代码根安装依赖并执行全量测试**

Run: `bun install --frozen-lockfile`

Run: `bun test`

Run: `bun run typecheck`

Expected: 全部通过；新代码根可以独立运行，不依赖旧工程目录。

- [x] **Step 4: 对真实 Archive 和状态依次 dry-run，再使用相同哈希 apply**

Run: `bun src/cli.ts --library fsd archive-migrate --dry-run --format json`

Run: `bun src/cli.ts --library fsd library-migrate --dry-run --format json`

Expected: 计划包含全部 20 篇历史论文、全部 runs/operations/receipts 和 128 个已知路径单元格；apply 后 Archive v2 校验全部通过且旧来源未被修改。

- [x] **Step 5: 从 Archive v2 全量重建并验证新 Vault**

Run: `bun src/cli.ts --library fsd vault-rebuild --dry-run --format json`

使用 dry-run 返回的计划文件和 SHA-256 执行 apply，再运行：

Run: `bun src/cli.ts --library fsd reconcile`

Expected: 20 篇历史论文均有 `paper.md`、`pages.md`、`source.pdf` 和完整资源；四个聚合索引存在；断链和缺失资源为零。

- [x] **Step 6: 执行真实一篇论文 smoke test 与中断恢复测试**

Run: `bun src/cli.ts --library fsd run-task --mode current --limit 1`

在测试性解析任务完成至少一个 processing window 后发送一次正常中断信号，再执行同一 current 任务。

Expected: 固定选篇和已下载 PDF 被复用；任务级 MinerU API 重新建立；Archive、Evidence、单独发布和对账全部成功。

Verified 2026-09-05: `2608.30345v1` 在首个窗口后正常中断，原 run `dd2dfbf0-e620-4331-a510-e169b3a7f419` 恢复后解析 17 页成功。历史发布基线同 hash 安装/重放通过，累计发布 21 篇；新 run 与两个旧 run 单独重放通过。永久 PDF 路径交接已修正，21 篇对账一致，0 断链/缺失/待解析。详细证据见真实迁移记录。

- [x] **Step 7: 扫描所有活动载体中的旧名称和路径**

Run: `rg -n "fsd-code2doc|01-Evidence|D:\\obsidian\\data\\fsd-code2doc|D:\\paper\\fsd-code2doc" D:\agent-data\backend\projects\paper-knowledge-engine D:\agent-data\data\paper-libraries\fsd D:\paper\fsd`

Verified: 活动代码/配置、数据库单元格、Archive、运行输入、操作记录、新 Vault 与 `.obsidian` 中旧引用为零；18 个保留历史引用文件仅为集中式迁移兼容模块和不可变的历史发布备份，不是活动入口。真实扫描结果保存在 `final-audit-before-retirement.json`。

- [x] **Step 8: 移除失效 Codex 自动化并按需重建新自动化**

使用 Codex 自动化管理接口删除引用 `D:/fsd-code2xdoc`、旧 Vault/PDF 根和 `npm run harvest:weekly` 的现有自动化。只有在新 CLI 完成 smoke test 后，才创建调用 `bun src/cli.ts --library fsd run-task --mode weekly` 的新自动化。

Expected: 不存在指向旧根或 npm 命令的活动自动化。

- [x] **Step 9: 生成四个旧根的可恢复归档 dry-run 并逐项复核**

Run: `bun D:/agent-data/backups/paper-libraries/fsd/migration-plans/20260905-165920/retire-legacy.ts --dry-run`

Verified: 固定旧代码/数据/PDF/Vault 根合计 474,704,511 字节、57,973 个普通文件、602 个链接。逐文件 SHA-256、链接目标及目录身份已记录；不跟随链接。计划 SHA-256 为 `ed388e2ab74a7cb0c739e6d501995697705f1b8de6523c27b1ce2ba8186a10b9`。目标为独立备份目录 `D:/agent-data/backups/paper-libraries/fsd/retired-legacy-20260905`，不覆盖新根或已有快照。旧代码另已保存在 Git `0521fc1`；原工作树 HEAD/index 保持不变。

- [x] **Step 10: 使用相同计划哈希执行可恢复归档并复验**

通过固定目标归档脚本 `--apply` 提交已复核 SHA-256；移动前重新验证内容及目录身份，移动后复核全部哈希。仅同卷重命名，不递归删除，不跟随旧测试链接；失败则回移。完成后再次运行 `bun test`、`bun run typecheck`、`reconcile`、Vault validator 和旧路径存在性检查。

Expected: 四个旧位置不存在；全部旧内容在归档子目录完整保留；新 CLI、数据、Vault、快照和 Git 恢复路径保持有效。归档不会释放磁盘空间；永久销毁另行确认。

Verified 2026-09-05: 四根归档成功，474,704,511 字节和全部链接完整保留；正式新根全量测试 1,137 pass / 4 条件性 skip / 0 fail，类型检查通过。21 篇对账一致，4 个索引，0 断链、缺失资源或待重解析；旧根均不存在。归档安全测试 8/8 通过，原工作树 HEAD/index 未改动。实际释放磁盘空间为 0 字节。

- [x] **Step 11: 完成最终提交并将本计划已完成步骤改为 `[x]`**

```powershell
git add docs CONTEXT.md README.md 使用手册.md config migrations scripts src templates tests package.json bun.lock
git commit -m "feat: complete paper knowledge engine migration"
```

Expected: 仅实际执行并通过证据验证的步骤标记为 `[x]`；最终报告列出测试结果、迁移计数、清理字节数、快照路径和剩余风险。

Verified 2026-09-05: 最终实现提交 `cab8411` 已保存到 `codex/paper-knowledge-engine-restructure`；本任务所有实施步骤均已完成。分支和独立工作树保留，未合并原脏工作树、未推送远端。旧代码恢复提交为 `0521fc1`；完整旧根归档、真实验收日志和恢复说明均保留。

---

## Plan Self-Review

- [x] **Spec coverage:** 每项命名、路径、配置、Archive、Evidence、历史迁移、CLI、清理和验收要求都映射到至少一个任务。
- [x] **Placeholder scan:** 计划不含模糊的后续实现项或未定义接口。
- [x] **Type consistency:** `LibraryId`、`LibraryPaths`、`EngineContext`、`ArchiveSourceV2`、Evidence v3 和迁移计划哈希在所有任务中名称一致。
- [x] **Safety review:** 所有真实写入先 dry-run；所有删除晚于快照和验收；用户工作树修改不被回滚。
