# SDD ledger — plan: D:/agent-data/backend/projects/paper-knowledge-engine/docs/superpowers/plans/2026-09-06-agent-engineering-implementation.md

## Setup

- Execution mode: Subagent-Driven Development.
- Repository is on branch `paper-knowledge-engineering`, not `main`/`master`, but the working tree contains extensive user changes in the shared engine. A new worktree from `HEAD` would omit those changes; implementation therefore stays in the current checkout and stages only task-scoped files.
- The prescribed `sdd-workspace` Bash script could not run on this Windows host because `bash.exe` resolves to the Windows Subsystem launcher and returned `E_ACCESSDENIED`; the equivalent plan-scoped workspace and ignore file were created with PowerShell/apply_patch.
- Existing user changes are preserved; no reset, checkout, clean, or broad staging is allowed.

## Plan scan before Task 1

### Shared-file/interface scan

| Tasks | Shared surface | Check / ruling |
|---|---|---|
| 1 ↔ 2 | `src/types/config.ts`, research source policy types, config loader | Task 1 introduces the `research` library branch and imports policy types; Task 2 defines those policy/source types. Dependency is explicit, with no competing schema. Ruling: Task 1 may use type-only imports whose concrete types land in Task 2. |
| 1 ↔ 3 | `src/shared/engine-context.ts`, source policy, adapter inputs | Task 1 validates and exposes policy; Task 3 consumes the validated policy and does not parse YAML. Ruling: adapter input is normalized config, not raw YAML. |
| 1 ↔ 4 | `src/types/config.ts`, `src/library/execution.ts`, `src/types/jobs.ts` | Task 1 adds the library-kind discriminator; Task 4 routes by that discriminator and adds research modes. Ruling: paper task mode remains backward-compatible and research routing is explicit. |
| 1 ↔ 5 | `config/engine.yaml`, engine context, bootstrap/evidence policy | Task 1 validates the research Evidence policy; Task 5 implements the layout named by that policy. Ruling: paper Evidence v3 remains unchanged; research policy is a sibling contract. |
| 2 ↔ 3 | `src/types/research-sources.ts`, candidate/fetch contracts | Task 2 owns stable source/version types; Task 3 implements adapters against them. Ruling: adapters cannot add unrecognized source kinds or fields. |
| 2 ↔ 4 | `state-store.ts`, migration 011, source/version/checkpoint APIs | Task 2 owns persistence primitives; Task 4 only orchestrates them. Ruling: research tables are additive and are never read by paper harvest methods. |
| 2 ↔ 5 | generic Archive manifest and verified source types | Task 5 consumes only the verified Archive returned by Task 2. Ruling: no renderer may publish from a temporary fetch directory. |
| 3 ↔ 4 | adapter discovery output and workflow selection | Task 3 returns candidates/fetched sources; Task 4 performs policy filtering, dedupe, selection freeze, and persistence. Ruling: adapters never apply task quota or write run checkpoints. |
| 4 ↔ 5 | run IDs, selection hash, completed archives, publication state | Task 4 produces the frozen source set; Task 5 publishes only that set and completes the matching research publication. Ruling: publication never rediscover or reorder sources. |
| 4 ↔ 6 | `runConfiguredTask`, CLI route and mode validation | Task 4 adds the research execution entrypoint; Task 6 exposes it through existing commands. Ruling: FSD routes remain paper-only and reject `backfill`. |
| 5 ↔ 6 | bootstrap, `evidence-publish`, `reconcile`, menu | Task 5 owns generic publication behavior; Task 6 only selects the service by library/run kind. Ruling: no CLI fallback from research to paper publisher. |
| 5 ↔ 7 | Evidence manifests, receipts and rebuild fixtures | Task 7 verifies byte stability and recovery; it does not change the publication contract. |
| 6 ↔ 7 | CLI/config docs and smoke commands | Task 6 provides commands; Task 7 verifies them with fixtures and no external source mutation. |

### Per-task self-consistency scan

| Task | Self-consistency result |
|---|---|
| 0 | Baseline-only task has no production files and its verification commands are available in this Bun project. |
| 1 | Research config files, loader branch, discriminated types, engine policy, fixture tests and FSD regression targets agree. `SourcePolicyConfig`/`TopicTaxonomyConfig` are intentionally defined in Task 2 and are an explicit dependency. |
| 2 | Source identity, generic Archive, migration 011, typed StateStore API and tests use the same `sourceId/versionId` keys. Paper Archive v2 is explicitly excluded. |
| 3 | Every listed adapter implements the shared discovery/fetch boundary and all network behavior is injectable/testable. No adapter owns selection or persistence. |
| 4 | Workflow result counters, checkpoint files, selection freeze and state methods describe the same source/version unit. `backfill` is explicitly separate from the FSD mode union. |
| 5 | Layout, renderer, receipt, state publication and atomic recovery are aligned; Knowledge is outside target inventory. |
| 6 | Menu and route behavior branch on the same library kind and preserve paper-only FSD operations. |
| 7 | Fixtures cover every source kind and every completion criterion without requiring live network or MinerU. |

### Rulings

- Ruling: preserve the current shared checkout rather than creating a fresh worktree — the current user changes span core files that Task 1–6 must build on; a clean `HEAD` worktree would silently omit them. Cost if wrong: task commits contain the current baseline context and require more careful review.
- Ruling: use an additive generic publication service and migration tables rather than widening paper receipt schemas — the FSD v2/v3 compatibility readers are strict and are already user-modified. Cost if wrong: some low-level publisher extraction is repeated until a later refactor.

## Task progress

- Task 0: complete (baseline only; no production changes)
- Task 1: complete (commits `4cd19e9`, `e3056fe`; initial review found one P1, fix round 1 addressed it; re-review PASS/PASS, 0 new findings)
- Task 2: complete (commits `0d21f1d`, `266b548`; initial review found one P1 in concurrent archive installation, fix round 1 addressed it; fix re-review PASS/PASS, 0 new findings)
- Task 3: complete (commits `26331ed`, `b266a23`, `c46e16d`, `a565b2d`, `d66c8a2`, fixes `9324b51`, `e72c08b`, `9ecb381`; initial review found 7 findings, all closed; final review PASS/PASS, 0 findings; controller verification 100 adapter tests passed and typecheck passed)
- Task 4: complete (commits `d64490b`, `9344472`, `99d0b38`; workflow review PASS; final independent review PASS with 0 confirmed findings; final controller verification 77 targeted tests passed and typecheck passed)
- Task 5: complete (research Evidence layout, deterministic renderer/indexes, strict source receipt, generic journaled publisher, bootstrap split; 10 research Evidence tests, 318 Evidence/Archive regressions, and typecheck passed)
- Task 6: pending
- Task 7: pending

## Baseline result

- BASE: `4b9477620b0d5598011f6d5dbfb04ee9c8b9b094`
- `bun run typecheck`: passed.
- `bun test --timeout 30000`: 1153 passed, 4 skipped, 29 failed out of 1186. The failures are pre-existing working-tree/environment failures: Windows `EPERM` while resolving `C:\Users\yyc` in cleanup/import safety tests, current user-modified FSD limit expectations, and current MinerU fixture/artifact expectations. No baseline failure is attributed to Agent Engineering because the feature is not implemented yet.
