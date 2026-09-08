# Task 1 implementation report — research library configuration and FSD isolation

## Delivered

- Added the `paper`/`research` discriminated `LibraryConfig` boundary, research configuration types, type guards, and a separate immutable research Evidence policy type.
- Added strict `library_kind` dispatch. Paper libraries require exactly their existing four active documents; research libraries require exactly `library.yaml`, `query-matrix.yaml`, `source-policy.yaml`, and `topic-taxonomy.yaml`, rejecting paper-only or unknown fields/files with stable file-and-field errors.
- Added `config/agent-engineering/` with the required identity, fixed 15 tracks, all eight source kinds, strict public-source policy, and topic taxonomy. No synthesis policy was created.
- Added `research_evidence` to the shared engine configuration without changing the paper Evidence v3 contract.
- Kept paper execution boundaries closed to research libraries with `UNSUPPORTED_LIBRARY_KIND: research`; the paper task pipeline has the same defensive boundary.
- Made operation policy snapshots select the active four files by library kind.
- Documented the paper/research split and added research loader regression coverage.

## Files changed

- `src/types/config.ts`
- `src/shared/engine-context.ts`
- `src/shared/config-files.ts`
- `src/shared/config.ts`
- `src/library/execution.ts`
- `src/library/pipeline.ts`
- `src/library/operations/operation-store.ts`
- `config/engine.yaml`
- `config/fsd/library.yaml` (only the Task 1 `library_kind: paper` addition is staged)
- `config/agent-engineering/library.yaml`
- `config/agent-engineering/query-matrix.yaml`
- `config/agent-engineering/source-policy.yaml`
- `config/agent-engineering/topic-taxonomy.yaml`
- `config/README.md` (only Task 1 documentation additions are staged)
- `tests/research-library-config.test.ts`
- `tests/config-source.test.ts`
- `tests/config.test.ts`

## Tests added or updated

- Added `tests/research-library-config.test.ts` for successful research loading; all 15 track IDs; active-file selection; missing and paper-only files; unknown fields; source policy/date/taxonomy validation; library listing; paths; research Evidence policy; paper execution rejection; pipeline rejection; and operation-policy snapshot selection.
- Updated existing compatibility tests only to narrow the FSD discriminated-union fixture before reading paper-only fields.

## TDD evidence

1. `bun test tests/research-library-config.test.ts --timeout 30000` initially failed with `UNKNOWN_LIBRARY: agent-engineering`; after the first loader/configuration slice it passed.
2. The same targeted test then failed because paper execution raised `INCOMPLETE_LAYERED_CONFIG` for research; after the boundary change it passed with `UNSUPPORTED_LIBRARY_KIND: research`.
3. It then failed because a research library silently accepted `paper-policy.yaml`; after exact active-file validation it passed.
4. It then failed because the paper pipeline attempted to acquire an undefined lock for research input; after the pipeline guard it passed.
5. It then failed because the policy snapshot selected FSD paper files; after kind-aware active-file selection it passed.

## Final verification

```text
bun test tests/research-library-config.test.ts tests/config-source.test.ts tests/config.test.ts tests/library-paths.test.ts --timeout 30000
64 pass, 0 fail

bun run typecheck
exit 0

git diff --check
exit 0
```

## Compatibility decisions

- FSD is explicitly `library_kind: paper`; its paper configuration schema and Evidence v3 validation remain closed and unchanged.
- `configurationFiles()` defaults to `fsd`/`paper`, preserving existing callers. Callers with a known research library provide `kind: 'research'` to bind the research file set.
- `loadConfig()` remains a paper compatibility adapter and rejects research explicitly; it does not manufacture paper limits or MinerU policy from research configuration.
- The research policy/taxonomy configuration types remain in `src/types/config.ts` for this task. They are plain type contracts and can move to `src/types/research-sources.ts` in Task 2 without a runtime cycle.

## Unresolved concern

The user requested that the full baseline not be rerun. A previously initiated full-suite run exposed unrelated pre-existing failures: `tests/library-config.test.ts` expects obsolete FSD limits while the dirty user configuration contains the new 100/10/30 limits; `tests/library-picker.test.ts` expects switch option `10` while user menu changes use `11`; and several cleanup-plan cases hit sandbox `EPERM` while resolving `C:\\Users\\yyc`. These were not modified. Task 1 scoped tests and type checking pass.

## P1 review follow-up — research track domain allowlist

- Added a regression case that changes `query-matrix.yaml` track `0` to the public-looking but unapproved `unapproved-public.example` hostname. It asserts `loadEngineContext()` fails with `INVALID_FIELD` plus `query-matrix.yaml`, `tracks.0.domains.0`, and `source_policy.allowed_domains` context.
- TDD red: `bun test tests/research-library-config.test.ts --timeout 30000` produced the expected `AssertionError: Missing expected exception` (6 pass, 1 fail), proving the domain was previously accepted.
- Minimal fix: after parsing the source policy, the research loader now requires every track domain to appear in `sourcePolicy.allowedDomains`, failing closed at the specific query-matrix field. This leaves paper/FSD loading untouched.
- TDD green: the same targeted test passed (7 pass, 0 fail). Final scoped verification and typecheck results are recorded below.

```text
bun test tests/research-library-config.test.ts tests/config-source.test.ts tests/config.test.ts tests/library-paths.test.ts --timeout 30000
65 pass, 0 fail

bun run typecheck
exit 0
```
