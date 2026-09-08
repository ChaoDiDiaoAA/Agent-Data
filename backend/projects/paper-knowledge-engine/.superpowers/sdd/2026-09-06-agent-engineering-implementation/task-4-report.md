# Task 4 implementation report

## Interim — selection, counters and checkpoint primitives (2026-09-07)

Status: this subset is verified; Task 4 as a whole is not complete. Baseline: `9ecb381ebbf1e6bc1c077e034b759ed1a22370fa`.

### Scoped files

- `src/research/research-selection.ts`
- `src/research/research-counters.ts`
- `src/research/research-checkpoints.ts`
- `tests/research-selection.test.ts`
- `tests/research-counters.test.ts`
- `tests/research-resume.test.ts`

### Implemented semantics

Selection uses the existing ResearchCandidate, normalization and adapter approval contracts. Policy-approved hits are deduplicated by sourceId/versionId before total, primary-Track and source-kind quotas. Primary Track follows configured Track order; secondary labels are retained. Ordering then uses source kind, descending latest published/updated/released timestamp, sourceId and versionId. Retrieval time cannot admit undated sources in normal current/weekly selection; explicit allowUndatedBackfill is available only for backfill. Invalid source kinds (including benchmark kinds), unknown Tracks, out-of-window dates and disallowed domains are rejected. Same-version kind/content conflicts fail closed.

Counters preserve raw candidate hits and independently deduplicate accepted, newVersions, archived and published source/version sets. Stage-membership validation rejects inconsistent counters. The formatter emits `候选 N，接受 M，新版本 K，归档 A，发布 P`. Archive/publication replay does not add a duplicate to these supplied sets. Historical database accounting remains outside this subset.

Checkpoint primitives clone and deeply freeze the ordered selection, accepted identities and pre-run novelty flags. Canonical JSON SHA-256 binds the selection. Resume validation rejects request mode/window/config hash/limit differences, selection hash mismatches and invalid membership. These are pure checkpoint primitives: they do not yet persist request.json, selection.json, shards, counters.json or failure.json, and do not execute recovery.

### TDD and verification

1. Tests were written before these modules. The initial scoped run observed RED: 0 pass, 3 fail / 3 module-resolution errors because all three implementation modules were absent.
2. Implemented the three modules. Scoped tests passed (11 tests).
3. Typecheck initially rejected the test fixture's `Monday` enum value. Changed only that fixture to the existing `monday` contract.
4. Final `bun test tests/research-selection.test.ts tests/research-counters.test.ts tests/research-resume.test.ts --timeout 10000`: exit 0, 11 pass, 0 fail, 32 expectations.
5. Final `bun run typecheck`: exit 0.

Tests use deterministic in-memory source fixtures and approval contracts; no network requests, adapter discovery processes or MinerU installation are needed. No full suite was run, per the task scope.

### Boundaries and remaining work

This subset does not modify workflow/parse, execution routing, StateStore or jobs types. It writes no FSD paper tables, categories or Evidence. Existing user modifications are preserved. Only the six scoped source/test files are to be staged for `feat: add research selection counters and checkpoints`; this report remains unstaged as requested.

Remaining Task 4 work includes workflow orchestration, durable checkpoint/failure files, completed-shard skip and failed-shard retry, archive verification/replay integration, injected generic paper parsing, publication gating and current/weekly watermarks, independent backfill runs, and relevant workflow/state regression tests. The prior config contract has no full-text or undated-import policy fields; this subset exposes an explicit undated backfill option without changing that contract. The subsequent workflow must include this option in its configuration hash. No completion claim is made for these remaining requirements.

## Mainline result — resumable workflow and generic parse (2026-09-07)

Status: the injected workflow/parse contract is implemented and verified. Production execution routing and lifecycle-store integration are not included in this commit, following the controller's final instruction to stage only new Task 4 files. Mainline baseline: `d64490b88db7d0ddf3b169155f38eeaf82401b81`.

### Files in the mainline commit

- `src/research/research-workflow.ts`: typed ResearchRunRequest/ResearchRunResult, explicit start/resume functions, injected lifecycle store/adapters/archive/MinerU/publication, run lock, durable artifacts, recovery and counter reporting.
- `src/research/research-parse.ts`: paper/technical-report-only full-text parse boundary and generic artifacts.
- `tests/research-workflow.test.ts`: fake StateStore, source adapters, Archive and MinerU, including parse tests; temporary directories hold checkpoint files only.
- `.superpowers/sdd/2026-09-06-agent-engineering-implementation/task-4-report.md`: interim and mainline results.

Existing selection/counters/checkpoints modules and their tests, including research-resume.test.ts, are unchanged. No CLI, execution.ts or jobs.ts changes were made in this mainline turn.

### Run, checkpoint and recovery semantics

- Runs use `research_current`, `research_weekly` or `research_backfill` through the research lifecycle port. No paper harvest resume query is called. A library-local `operations/locks/research-sync.lock` serializes workflow execution.
- Current/weekly derive their lower bound from the existing success watermark, otherwise the configured first date (2026-01-01 in the research config). Explicit dates override defaults; date-only `to` includes the full UTC day. Backfill requires an independent explicit range on initial start.
- `request.json` contains normalized mode/window/filters/limit and a configuration hash. That hash covers the library, network, adapter IDs/kinds, discovery targets, explicit full-text/undated policy and caller-owned parser/engine snapshot. Raw network configuration is not written to request.json.
- Discovery batches are checkpointed under `shards/discovery-<hash>.json`. If discovery fails before selection exists, completed batches are reused and unfinished discovery continues. Once selection exists, resume never discovers, expands or reorders it.
- Before fetch, the workflow writes `selection.json` and `selection.sha256` and binds their hash and the request hash through the lifecycle port. Resume validates the saved run, mode, window, configuration, request and selection hashes before resuming state or adapters. Rehashing a changed selection cannot bypass the store binding. A committed selection with a missing hash file is rejected.
- Per-version `shards/<hash>.json` records prepared fetch/parse bytes, their hash, archive manifest hash and safe failure data. Completed database shards skip fetching/writing but their archives are reverified. Failed fetches retry; failed archive writes reuse the persisted prepared artifacts, including parsed paper content. Pre-run novelty remains frozen across retries.
- Verified archive writes and verified prior archives feed existing research source/version and observation APIs. Observation identity/timestamp is stable on retry. Existing generic Archive readers/writers remain the production defaults; tests inject fakes.
- `counters.json` is regenerated from the frozen accepted/novel sets, verified archives and publication sources. The optional log observer receives JSON counters and the precise Chinese formatter. Observer exceptions do not change the business outcome.
- Sanitized, bounded error summaries are written to failure.json and shard failures using the existing redaction helper. Raw stack traces and raw exception objects are not persisted. Failure.json is retained as historical diagnostic evidence after a successful resume.
- The workflow creates no disposable fetch/parse/publish work directories of its own. It performs no broad cleanup, and preserves Archive, run history, external PDFs and user files.

### Parse and FSD boundaries

Full text is an explicit `fullTextKinds` policy. Only paper and technical-report can invoke the injected ResearchMineruBoundary. Docs, specifications, repositories, releases, evaluation methods and local artifacts return without starting MinerU, even if requireFullText is true. The boundary accepts PDF bytes and their hash plus generic source/version identity, and returns Markdown/page locators; the caller owns the existing MinerU session and its lifecycle.

Parsing verifies the PDF signature, nonempty Markdown, unique positive page numbers and valid Markdown line ranges. It preserves source.pdf, writes normalized content.md, metadata/pdf.json (PDF SHA-256 and pages), metadata/discovery.json (the original discovery content and hash), and generic PDF/Markdown locators. The resulting SourceVersion content hash identifies the normalized full text. No TaskPaper, FSD categories, paper table writer, FSD Evidence publisher or paper parsing pipeline is invoked.

### Publication and watermark contract

Without a publisher the result and lifecycle status become awaiting_evidence; no success watermark advances. A supplied publisher must finish the existing research publication protocol and record its source receipts in the store. The workflow then verifies that every selected verified Archive appears exactly in the completed publication with the correct archive manifest hash. Only then does it call completeResearchWorkflowRun. Its lifecycle implementation must atomically verify the selection binding/publication and advance the existing watermark monotonically for current/weekly; backfill never changes it. Publication replay returns the same unique source/version count without another historical publication row.

### TDD and exact verification

1. Added workflow/parse tests before either implementation file. Initial `bun test tests/research-workflow.test.ts --timeout 10000` observed RED: 0 pass, 1 fail / missing research-workflow module.
2. First implementation pass: 19/19 scoped tests and typecheck passed.
3. Added recovery/parse/fetch/discovery/cancellation cases. The missing committed selection.sha256 case observed a behavioral RED (17 pass, 1 fail in the workflow invocation, which also imports selection fixtures/tests). Added the missing-file guard and returned to GREEN.
4. Relevant regression command: `bun test tests/research-workflow.test.ts tests/research-resume.test.ts tests/research-counters.test.ts tests/research-selection.test.ts tests/research-state-store.test.ts tests/state-store.test.ts tests/workflow.test.ts --timeout 10000` — exit 0, **100 pass, 0 fail**, 222 expectations across 7 files. This includes existing FSD workflow and state tests.
5. Final scoped command, after making the lifecycle port independent of uncommitted StateStore type additions: `bun test tests/research-workflow.test.ts tests/research-resume.test.ts tests/research-counters.test.ts tests/research-selection.test.ts --timeout 10000` — exit 0, **24 pass, 0 fail**, 137 expectations across 4 files. Parse cases are in research-workflow.test.ts; there is no separate parse test file.
6. Final `bun run typecheck` — exit 0.

No full suite, network discovery or installed MinerU model was used. Verification ran in the preserved working tree, not a clean checkout stripped of the controller's pre-existing changes.

### Rulings, integration limits and handoff

1. **StateStore staging boundary:** state-store.ts already contained a user change before Task 4. During implementation, minimal research get/resume/checkpoint-binding/await/publication-finalization methods were added there and passed typecheck plus relevant existing state regressions. The controller's final instruction prohibits staging pre-existing dirty files, so that entire file remains unstaged, with both the original user change and these Task 4 additions preserved. The committed ResearchWorkflowStore therefore extends a Pick of existing Task 1–3 methods with an explicit injected lifecycle port; it does not require those uncommitted additions merely to typecheck. The controller must separately review/integrate that lifecycle implementation before connecting the production entry point. New lifecycle semantics are covered through the fake store in workflow tests; the existing real-state regressions do not independently exercise every new lifecycle method.
2. **Execution routing:** no runConfiguredTask/CLI/menu route was changed. Adapter/session/publication assembly belongs to the caller of the exported runResearchTask/resumeResearchTask contract. This is the authorized contract-level stopping point, not a claim of an operational CLI feature.
3. **Policy/schema gaps:** Tasks 1–3 contain no full-text parse policy field. fullTextKinds and optional configSnapshot are explicit injection inputs and participate in the saved configuration hash. No parallel source contract or configuration schema was introduced. The generic boundary does not construct or install a MinerU session itself.
4. **Local imports:** discovery target options are available, but the preserved selection module does not propagate localPurpose into its approval scope. Explicit local-artifact import orchestration therefore remains an integration limitation for the later import route; the workflow must not be advertised as completing that route.
5. **Publication integration:** the publisher must use the selection hash as its research publication input binding for this workflow contract. The actual Task 5 Evidence implementation is neither created nor changed here. Durable receipt verification remains its existing StateStore/publication responsibility; fake publications test orchestration and watermark gating only.
6. **Review scope:** only the four new Task 4 files listed above are included in `feat: add resumable research workflow`. No pre-existing dirty file is staged; no subagent was invoked; all unrelated user changes remain in place.

## Final closure — execution routing follow-up (2026-09-07)

The planned minimal execution dispatch was added in `99d0b38` (`feat: route configured research tasks`). `runConfiguredTask` now branches on the layered library kind before paper-only configuration/pipeline setup. Research callers inject adapter/archive/MinerU/publication dependencies and receive the library-local state root and StateStore; explicit resume uses `resumeResearchTask`, and the store is closed in `finally`. Paper routing retains its previous overload and behavior. CLI/menu adapter assembly remains Task 6 scope.

Final review: `task-4-final-review.md` — PASS, no confirmed P0–P3 findings.

Final controller verification:

- research routing plus workflow/selection/checkpoint/counter/state and FSD route regressions: **77 pass, 0 fail**, 229 expectations;
- `bun run typecheck`: pass.

Task 4 is complete. The remaining integration boundary is intentional: Task 5 owns generic research Evidence publication, and Task 6 owns concrete CLI adapter assembly/menu exposure.
