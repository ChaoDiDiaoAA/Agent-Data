# Agent Engineering Paper-Only Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `agent-engineering` from the independent Research workflow to a paper-only library that uses the same arXiv, PDF, MinerU, Archive, Evidence, checkpoint, and CLI path as `fsd`.

**Architecture:** Keep the global Research implementation available for future research libraries, but remove `agent-engineering` from that branch. Make `agent-engineering` a normal `paper` library with its own queries, paper policy, PDF categories, limits, and isolated storage. Reuse the existing paper execution path; do not add an Agent-specific harvester, selector, downloader, parser, or publisher.

**Tech Stack:** Bun 1.4, TypeScript, YAML layered configuration, OpenCLI arXiv harvest, SQLite state, MinerU API, Archive v2, Evidence v3.

**Spec:** `docs/superpowers/specs/2026-09-06-agent-engineering-design.md`, superseded for Agent source scope by the 2026-09-07 paper-only decision recorded in the repository README and this plan.

## Global Constraints

- `fsd` configuration, runtime data, SQLite state, PDF root, Archive, Evidence, and menu behavior must remain unchanged.
- `agent-engineering` must contain only arXiv paper discovery and must use `library_kind: paper`.
- The shared paper path remains canonical: `buildHarvestPlan` → `runHarvestShards` → paper selection → `downloadAcceptedPdf` → MinerU → Evidence v3.
- Do not delete the global `src/research/` implementation or its generic tests; only remove Agent configuration and routing that selects it.
- Do not reset, checkout, clean, or overwrite unrelated dirty worktree changes.
- Mark each completed plan step with `[x]` after its verification command passes.

---

### Task 1: Lock the paper-only contract with failing tests

**Files:**
- Modify: `tests/research-cli.test.ts` (rename test descriptions or replace with Agent paper contract assertions)
- Modify: `tests/library-config.test.ts`
- Modify: `tests/cli-menu.test.ts`
- Modify: `tests/workflow.test.ts` or add a focused test beside it

**Interfaces:**
- Consumes: `loadEngineContext`, `normalizeCliOperation`, `routeScheduleConfig`, `runInteractiveMenu`, `executeOperation`.
- Produces: regression coverage proving Agent is paper-kind, rejects backfill/import-source, exposes MinerU/paper menu behavior, and starts a MinerU session for Agent task operations.

- [x] **Step 1: Write the failing tests.** Assert `agent-engineering` loads as `paper`, its schedule returns `maxPapers`, `backfill` is rejected for a paper library, and the interactive menu routes choice `9` to `arxiv-check` like FSD.
- [x] **Step 2: Run the focused tests to verify the expected failures.**

  Run:

  ```powershell
  bun test --timeout 30000 tests/research-cli.test.ts tests/library-config.test.ts tests/cli-menu.test.ts
  ```

  Expected: failures identify the current research-kind configuration and Agent research menu assumptions.
- [x] **Step 3: Keep the test failures limited to the paper-only contract.** The initial RED run isolated the expected Agent Research assumptions before production changes.

### Task 2: Convert Agent configuration to the FSD paper schema

**Files:**
- Modify: `config/agent-engineering/library.yaml`
- Modify: `config/agent-engineering/query-matrix.yaml`
- Create: `config/agent-engineering/paper-policy.yaml`
- Create: `config/agent-engineering/categories.yaml`
- Delete: `config/agent-engineering/source-policy.yaml`
- Delete: `config/agent-engineering/topic-taxonomy.yaml`

**Interfaces:**
- Consumes: paper-library loader contract in `src/shared/engine-context.ts` and FSD configuration shape.
- Produces: an isolated paper library with 15 Agent tracks, submitted/updated arXiv modes, 150 current-paper quota, weekly-paper quota, paper filtering, and PDF category mapping.

- [x] **Step 1: Change `library.yaml` to `library_kind: paper`, `max_papers`, `max_papers` weekly schedule, `overlap_hours`, and `download_after_hard_filter`.** Preserved the existing 15 track IDs and 10-paper per-track current allocation.
- [x] **Step 2: Change every query track from `arxiv_categories`/`date_fields`/Research source fields to FSD fields `categories` and `date_modes: [submitted, updated]`.** Removed `source_kinds` and `domains` from this Agent query file.
- [x] **Step 3: Add Agent-specific `paper-policy.yaml` and `categories.yaml`.** Kept the paper-policy contract identical to FSD while using Agent terms and one PDF category per active track plus `99-Unclassified`.
- [x] **Step 4: Remove only the now-unused Agent Research configuration files.** Kept `src/research/` and generic Research tests, moving those tests to a dedicated fixture library.
- [x] **Step 5: Run configuration tests and confirm the loader now reaches the paper branch.**

  Run:

  ```powershell
  bun test --timeout 30000 tests/library-config.test.ts tests/research-cli.test.ts
  ```

### Task 3: Remove the Agent-specific Research routing discriminator

**Files:**
- Modify: `src/library/workflow.ts`
- Modify: `src/cli/routes.ts`
- Modify: `tests/research-cli.test.ts`
- Modify: relevant workflow/route tests

**Interfaces:**
- Consumes: `EngineContext.library.kind`, `isPaperLibrary`, `isResearchLibrary`, and the existing operation workflow.
- Produces: kind-based routing with no `libraryId === 'agent-engineering'` Research special case; Agent tasks use the existing paper workflow and MinerU lifecycle.

- [x] **Step 1: Add a failing assertion that Agent `run-task` does not construct or require a Research execution context and that `executeOperation` treats Agent as paper for MinerU session ownership.**
- [x] **Step 2: Run the focused route/workflow tests and observe the failure caused by the current hard-coded Agent Research branch.**
- [x] **Step 3: Replace the hard-coded `agent-engineering` kind decision in `workflow.ts` with the loaded library kind, retaining a paper fallback only for injected no-config test fixtures.**
- [x] **Step 4: Make `normalizeCliOperation` accept an explicit library kind (defaulting to paper for legacy injected callers) and permit `backfill` only for actual Research libraries.**
- [x] **Step 5: Make CLI command dispatch derive `paperLibrary`/`researchLibrary` from the selected engine context rather than the Agent ID.** Research commands remain available for future Research libraries, while Agent follows the paper branch.
- [x] **Step 6: Run the focused route/workflow tests and confirm they pass.**

### Task 4: Reuse the normal paper execution path end-to-end

**Files:**
- Modify: `src/cli/menu.ts` only if tests show a stale Agent-specific branch remains
- Modify: `src/library/execution.ts` only if the paper branch needs an existing shared seam exposed
- Add/modify: `tests/run-task.test.ts`, `tests/config-source.test.ts`, or a focused Agent paper task test

**Interfaces:**
- Consumes: `runConfiguredTask` paper branch, `buildHarvestPlan`, `runHarvestShards`, `downloadAcceptedPdf`, `createHarvestCheckpointSession`, existing MinerU session, and `publishRunEvidence`.
- Produces: Agent behavior identical to FSD behavior with Agent-owned configuration and storage roots.

- [x] **Step 1: Add a test that constructs the Agent paper context and verifies the selected harvest plan has 15 tracks and 30 submitted/updated shards.**
- [x] **Step 2: Add a test that injects the existing paper `harvest` seam and verifies Agent receives the same network, checkpoint, and MinerU boundaries as FSD.**
- [x] **Step 3: Remove any remaining Agent-only Research dependency from the paper task invocation; do not create a second implementation of discovery, selection, PDF download, or publication.**
- [x] **Step 4: Run the Agent paper task tests and the existing FSD task tests.**

### Task 5: Update documentation and stale Research references

**Files:**
- Modify: `README.md`
- Modify: `config/README.md`
- Modify: `CONTEXT.md` only where it claims Agent is a Research-source library
- Modify: Agent Engineering design/spec status section to record the paper-only decision
- Modify: `tests/research-cli.test.ts` descriptions and expectations

**Interfaces:**
- Consumes: final paper-only configuration and CLI behavior.
- Produces: documentation that tells users Agent Engineering uses the same paper menu, commands, limits, PDF path, MinerU path, and Evidence v3 layout as FSD while retaining its own library ID and topics.

- [x] **Step 1: Replace Agent Research commands (`source-config`, `backfill`, `import-source`) with paper commands (`mineru-config`, `arxiv-check`, `import-local`, `parse-local`, `harvest-plan`).**
- [x] **Step 2: Document that Agent and FSD share implementation but not state, roots, configuration, or quotas.**
- [x] **Step 3: Document the Agent 15-track arXiv-only scope and its PDF category mapping.**
- [x] **Step 4: Remove stale claims that Agent has source-kind limits, Research Archive, official-document adapters, or independent Research counters.**

### Task 6: Full verification and plan bookkeeping

**Files:**
- Modify: `docs/superpowers/plans/2026-09-07-agent-engineering-paper-only.md`

- [x] **Step 1: Run `bun run typecheck`.**
- [x] **Step 2: Run the focused Agent/FSD configuration, CLI, workflow, harvest, and task tests.**
- [x] **Step 3: Run the full `bun test --timeout 30000` suite and record unrelated pre-existing failures separately without changing user-owned configuration.** The suite reached 1,345 passing and 31 failing tests plus 4 skips; failures were pre-existing Windows sandbox `EPERM`, the user-modified FSD limits/config fixtures, one OpenCLI budget fixture, and one Archive HTML fixture. No Agent paper-only test failed; the scheduler export error observed during the run was corrected and covered separately.
- [x] **Step 4: Run `git diff --check` for all changed files.**
- [x] **Step 5: Mark every completed plan step with `[x]`, leaving any blocked or unrelated pre-existing failure explicitly described.**
