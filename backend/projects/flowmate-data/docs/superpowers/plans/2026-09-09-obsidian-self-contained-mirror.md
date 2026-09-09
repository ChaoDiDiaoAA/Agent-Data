# Obsidian Self-Contained Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Obsidian Vault a physical, self-contained copy of Flowmate's invoice and Release outputs while keeping the existing authority roots and compact project layout unchanged.

**Architecture:** Extend the catalog projection with a list of verified binary and text assets. `buildCatalog` will collect assets from the original and data authority roots, while `applyCatalog` will copy them into Vault-owned paths under the existing numbered directories using path checks, hashes, a staging directory and generated-file ownership rules. Markdown cards will reference only Vault-relative files; no `file:///` links to authority roots will remain.

**Tech Stack:** Bun, TypeScript, Node `fs/promises`, existing Flowmate path-boundary/atomic publication helpers, Bun Test.

**Spec:** `backend/projects/flowmate-data/docs/superpowers/specs/2026-09-09-obsidian-self-contained-mirror-design.md`

## Global Constraints

- Keep `projectRoot`, `paperEngineRoot`, `originalRoot`, `dataRoot`, `vaultRoot`, and `backupRoot` unchanged.
- Keep `D:\paper\Invoice` as the original and structured-mirror authority and `D:\agent-data\data\flowmate-data` as the machine-record authority.
- Copy data into `D:\obsidian\data\flowmate-data`; never use a symlink, hard link, or `file:///` link to an authority root.
- Preserve the compact Vault roots `01_总览.md`, `02_数据集`, `03_发票`, and `05_发布`.
- Include `annotation.json` and `fields.json` only for records with `publisher_annotation_status: annotated`.
- Fail closed on path escape, symlink, source-hash mismatch, destination conflict, or incomplete source assets.
- Keep generated Markdown and copied assets idempotent and protect user-authored Vault files.

---

### Task 1: Add a catalog asset model and safe Vault asset publication

**Files:**
- Modify: `backend/projects/flowmate-data/src/catalog.ts:15-104,252-420`
- Test: `backend/projects/flowmate-data/tests/catalog.test.ts`

**Interfaces:**
- Produces `CatalogAsset { path: string; sourcePath: string; sha256: string; bytes: number }` and `CatalogPlan.assets: CatalogAsset[]`.
- `buildCatalog` provides only absolute source paths that resolve inside `originalRoot` or `dataRoot`; `applyCatalog` accepts only Vault-relative destination paths.

- [x] **Step 1: Write the failing test**

Add a catalog test that creates a source file outside the Vault, constructs a plan with one asset, applies it, and expects the exact bytes at the Vault destination. Add a second assertion that a destination containing different bytes is rejected with `CATALOG_ASSET_CONFLICT`, and that a destination symlink is rejected with `CATALOG_PATH_SYMLINK`.

```ts
test('copies catalog assets into the Vault and rejects changed or linked destinations', async () => {
  const paths = await fixturePaths();
  const source = join(paths.originalRoot, 'voxel51', '000001', 'original.jpg');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 1]));
  const plan = {
    vaultRoot: paths.vaultRoot,
    directories: ['03_发票', '03_发票/voxel51', '03_发票/voxel51/000001'],
    files: [],
    assets: [{ path: '03_发票/voxel51/000001/original.jpg', sourcePath: source, sha256: await sha256File(source), bytes: 4 }],
  };
  await applyCatalog(plan);
  await expect(readFile(join(paths.vaultRoot, '03_发票/voxel51/000001/original.jpg'))).resolves.toEqual(Buffer.from([0xff, 0xd8, 0xff, 1]));
  await writeFile(join(paths.vaultRoot, '03_发票/voxel51/000001/original.jpg'), 'changed');
  await expect(applyCatalog(plan)).rejects.toThrow('CATALOG_ASSET_CONFLICT');
});
```

- [x] **Step 2: Run the focused test and confirm the expected failure**

Run `bun test tests/catalog.test.ts -t "copies catalog assets into the Vault"` from `backend/projects/flowmate-data`. It must fail because `CatalogPlan` does not yet expose or publish `assets`.

- [x] **Step 3: Implement the minimal asset contract and copy path**

Extend the catalog types:

```ts
export interface CatalogAsset {
  path: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
}
export interface CatalogPlan {
  vaultRoot: string;
  directories: string[];
  files: CatalogFile[];
  assets: CatalogAsset[];
}
```

Update `validatePlan` to validate asset destination paths with `catalogPath`, reject duplicate destinations across `files` and `assets`, and require a positive safe byte count and 64-character lowercase SHA-256. Validate each source with `lstat`, reject symlinks and non-files, resolve it under the authority root recorded by the builder, and verify `sha256File(sourcePath)` and byte length before staging.

Add `atomicCopyAsset(vaultRoot, asset, stagingRoot)` beside `atomicWriteOwned`. It must create a `.tmp` file under the catalog staging root with `copyFile`, verify the staged byte count and SHA-256, publish it through the existing recovery/no-replace boundary checks, and treat an existing destination with the same bytes as idempotent. An existing destination with a different hash must throw `CATALOG_ASSET_CONFLICT`; a destination symlink must throw `CATALOG_PATH_SYMLINK`.

Run asset publication after text ownership checks and before pruning generated Markdown. Keep all destination paths inside `vaultRoot` and never call `hardLink` for assets.

- [x] **Step 4: Run the focused test and verify it passes**

Run `bun test tests/catalog.test.ts -t "copies catalog assets into the Vault"`. Confirm the test passes and the output contains no failure.

- [x] **Step 5: Commit the isolated catalog asset primitive**

```powershell
git add backend/projects/flowmate-data/src/catalog.ts backend/projects/flowmate-data/tests/catalog.test.ts
git commit -m "feat(flowmate-data): publish catalog assets into Vault"
```

### Task 2: Build the self-contained sample and Release asset plan

**Files:**
- Modify: `backend/projects/flowmate-data/src/catalog.ts:22-177`
- Modify: `backend/projects/flowmate-data/src/layout.ts` only if a shared compact Vault path helper is required
- Test: `backend/projects/flowmate-data/tests/catalog.test.ts`

**Interfaces:**
- `buildCatalog(paths)` returns text pages plus `assets` for every selected sample and Release file.
- Sample assets are written to `03_发票/<dataset>/<sample-id>/`; the card remains `03_发票/<dataset>/<sample-id>.md`.
- Release assets are written to `05_发布/<version>/manifest.json` and `05_发布/<version>/checksums.json` when those files exist in the data root.

- [x] **Step 1: Write the failing test**

Extend the existing seeded catalog fixture so the authority roots contain a valid original image, `annotation.json`, `fields.json`, `record.json`, `receipt.json`, `snapshot.json`, normalized `content.md`, `content.json`, `pages.json`, `parse.json`, one asset under `assets/`, and Release `manifest.json` plus `checksums.json`. After `buildCatalog` and `applyCatalog`, assert every expected file exists in Vault, its bytes equal the authority file, and generated Markdown contains no `file:///`, `D:\paper\Invoice`, or `D:\agent-data\data\flowmate-data`.

Add a second sample with `publisher_annotation_status: unannotated`, no annotation or label refs, and a valid parsed snapshot. Assert its Vault directory contains original and MinerU files but no `annotation.json` or `fields.json`.

```ts
expect(await readFile(join(paths.vaultRoot, '03_发票/voxel51/sample-a/original.jpg'))).toEqual(await readFile(originalPath));
expect(await Bun.file(join(paths.vaultRoot, '03_发票/voxel51/sample-a/annotation.json')).exists()).toBe(true);
expect(await Bun.file(join(paths.vaultRoot, '03_发票/voxel51/sample-b/annotation.json')).exists()).toBe(false);
expect(await Bun.file(join(paths.vaultRoot, '05_发布/v1/manifest.json')).exists()).toBe(true);
const markdown = await Bun.file(join(paths.vaultRoot, '03_发票/voxel51/sample-a.md')).text();
expect(markdown).not.toContain('file:///');
expect(markdown).not.toContain('D:\\paper\\Invoice');
```

- [x] **Step 2: Run the focused test and confirm the expected failure**

Run `bun test tests/catalog.test.ts -t "builds a self-contained Vault sample"`. It must fail because the current builder emits only Markdown and current cards use authority-root links.

- [x] **Step 3: Implement sample asset collection and internal card references**

Add helpers that resolve and verify source files from `record.original_ref`, `record.annotation_ref`, `record.label_ref`, `record.derived_ref`, and the selected snapshot manifest. Map normalized MinerU names to the Vault names already used by the snapshot projection: `full.md` to `content.md`, `content-list.json` to `content.json`, preserve `pages.json`, `parse.json`, and `assets/**`, and include `snapshot.json`, `record.json`, and `receipt.json`.

For annotated records include `annotation.json` and `fields.json`; for unannotated records omit both and omit any unified-label reference. Use `publisher_annotation_status` with the existing backward-compatible inference when older records lack the field. Reject a missing or hash-mismatched required source file before returning the plan.

Replace `fileUrl`, `ref`, and external sample links in `sampleCard` with Vault-relative references. Keep the card at `03_发票/<dataset>/<sample-id>.md` and use links/embeds such as:

```md
![[03_发票/voxel51/sample-a/original.jpg]]
[[03_发票/voxel51/sample-a/content.md|MinerU 内容]]
[[03_发票/voxel51/sample-a/fields.json|统一字段]]
```

Use plain text for unavailable files. Keep the source homepage and license evidence as ordinary URL metadata; do not turn authority-root paths into links. Change the overview Release entry to `[[05_发布/<version>/manifest.json|Release <version>]]`.

- [x] **Step 4: Implement Release asset collection**

Change `releases(paths)` to return the data-root manifest and optional checksums path. Add both files to `CatalogPlan.assets` under `05_发布/<version>/`. Generate a short Release page or append a Release section to `01_总览.md` that uses only the Vault-relative manifest link. If a checksums file is absent, omit it instead of creating a fabricated file.

- [x] **Step 5: Run the focused catalog tests and verify they pass**

Run `bun test tests/catalog.test.ts -t "self-contained Vault|catalog bytes are stable|rebuilds deleted generated cards"`. Confirm both annotated and unannotated asset sets, Release assets, internal-only references, deterministic output, and user-note preservation pass.

- [x] **Step 6: Commit the sample and Release projection**

```powershell
git add backend/projects/flowmate-data/src/catalog.ts backend/projects/flowmate-data/tests/catalog.test.ts
git commit -m "feat(flowmate-data): mirror invoice data into Obsidian"
```

### Task 3: Add integrity coverage and update operator documentation

**Files:**
- Modify: `backend/projects/flowmate-data/tests/catalog.test.ts`
- Modify: `backend/projects/flowmate-data/README.md`
- Modify: `backend/projects/flowmate-data/config/README.md`
- Modify: `backend/projects/flowmate-data/docs/superpowers/specs/2026-09-09-obsidian-self-contained-mirror-design.md` only if implementation decisions need to be recorded

**Interfaces:**
- The catalog command remains `bun src/cli.ts catalog build`; no new path or command flag is required.
- Documentation states that Vault files are physical copies and authority roots remain canonical.

- [x] **Step 1: Write the failing integrity tests**

Add tests that alter a source file after the plan is built and expect `CATALOG_ASSET_SOURCE_HASH_MISMATCH`; replace an existing Vault asset with a symlink and expect `CATALOG_PATH_SYMLINK`; alter a Vault asset and expect `CATALOG_ASSET_CONFLICT`; run `applyCatalog` twice and compare all Vault bytes for stability.

- [x] **Step 2: Implement and run the focused integrity tests**

Use the source and destination hash checks from Task 1, run `bun test tests/catalog.test.ts -t "asset|self-contained"`, and fix only failures caused by the new projection.

- [x] **Step 3: Update operator documentation**

In the root README and config README, document the final Vault tree, the physical-copy rule, the fact that Markdown contains only Vault-relative links, and the distinction between canonical files and Vault copies. State that `catalog build` repopulates the Vault after an empty or legacy Markdown-only Vault. Keep the existing startup command and all six configured roots unchanged.

- [x] **Step 4: Commit documentation and integrity coverage**

```powershell
git add backend/projects/flowmate-data/tests/catalog.test.ts backend/projects/flowmate-data/README.md backend/projects/flowmate-data/config/README.md
git commit -m "docs(flowmate-data): document self-contained Obsidian data"
```

### Task 4: Full verification and clean handoff

**Files:**
- Verify: all files changed by Tasks 1-3

- [x] **Step 1: Run type checking**

Run `bun run typecheck` from `backend/projects/flowmate-data`; expected result is exit code 0.

- [x] **Step 2: Run the complete test suite**

Run `bun test` from `backend/projects/flowmate-data`; expected result is 0 failures, including existing compact-layout, snapshot, release, and CLI tests.

- [x] **Step 3: Run repository checks**

Run `git diff --check` and `git status --short`. Confirm there are no whitespace errors, no generated data roots staged, and no `file:///` authority links in generated catalog source. Do not stage runtime MinerU lock files.

- [x] **Step 4: Validate the actual configured Vault paths**

After confirming no live Flowmate or MinerU run owns the roots, run the menu's `catalog build` against `config/paths.local.json` and `config/workbench.local.json`. Inspect `D:\obsidian\data\flowmate-data\03_发票` and `05_发布` to confirm physical files are present; do not delete authority data as part of this task.

- [x] **Step 5: Report the result**

Report the final Vault tree, canonical source roots, exact verification counts, and commit IDs. Mention any active runtime lock separately and never include it in a commit.
