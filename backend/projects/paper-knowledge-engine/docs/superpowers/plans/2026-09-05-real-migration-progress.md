# Real migration execution evidence

## Final formal-root checks (2026-09-05)

- Synchronized and SHA-256 compared all 370 project files into `D:/agent-data/backend/projects/paper-knowledge-engine` after all four legacy roots were archived.
- Fixed Windows case-insensitive child environment collisions at both OpenCLI transports and the MinerU environment builder. The injected `execFile` seam was also covered after independent review found its omission. RED regressions reproduced the duplicate keys; GREEN focused tests and final independent review passed. Parent environment is unchanged; non-Windows case semantics remain intact.
- The formal-root real OpenCLI check, with no inherited HTTP/HTTPS/ALL proxy variables, returned 9 AI-FSD candidates in 3.771 seconds using only `machine.local.yaml`'s explicit proxy. It used the configured `2026-01-01` start date and did not mutate paper selection or the library. Evidence: `configured-network-final.json` in the external migration plan directory.
- Final live audit: 21 verified Archive sources, 21 parsed database rows, SQLite integrity `ok`, 0 foreign-key violations, 0 active old-root references. Vault: 21 papers, 4 aggregate indexes, 0 broken links, 0 missing assets. Reconciliation: all 21 consistent; no missing PDF, reparse, note rebuild, publication retry or duplicate PDF. Evidence: `final-verification.json`.
- Formal-root `bun run typecheck` passed. Final formal-root full suite: **1,137 pass / 4 conditional skips / 0 fail**, 1,141 tests across 84 files, 159.11 seconds, exit 0. Command: `bun test --timeout 15000`, with `FSD_TEST_ROOT=D:/agent-data/tmp/pke-final-formal-r2-20260905`. Log: `final-test-after-retirement-r2.log` in the external migration-plan directory. The four skips are existing opt-in maintenance/GPU checks; real discovery, interrupted/resumed GPU parsing, publication, replay, health lifecycle and final Vault audit were separately executed and evidenced. No skipped test is counted as passed.
- First final formal suite: 1,136 pass / 4 gated skips / 1 failure. The two-paper injected-session fixture generated two blank PDFs with identical SHA-256 within the same timestamp second, and its fake download transport bypassed the real duplicate exclusion. A new explicit different-hash assertion reproduced RED before parsing; adding distinct PDF titles to the fixture fixed the input contract. Production deduplication and SQLite uniqueness were not relaxed. All 98 related tests passed; the entire formal suite is rerun against this final fixture.
- The four old locations remain absent. Original root HEAD remains `aef254b300c3ef4e2d046222affcfd2b3108e5c3`, and its index SHA-256 remains `36ff2262871d5648de86beb5421e8c77e5d8a2ac03993b41e7cb000e11f41b33`. The old Codex automation file is absent; the retained old Windows scheduled task is disabled. No replacement scheduler was enabled.

Task 12 Steps 1–11 are complete. Real discovery/download, interrupted-parse recovery, cumulative 21-paper publication and new/old run replay pass. The four legacy roots have been recoverably archived and the final formal-root suite passed. Final implementation commit: `cab8411` on `codex/paper-knowledge-engine-restructure`; no merge or remote push was performed. Earlier pending/blocker entries below are a chronological audit trail, superseded by the later evidence.

## Real-input compatibility repairs

- Commit `506a41b` and its preceding fixes passed independent review (54 focused tests).
- All 20 legacy manifests were audited: 877 inventoried files. Additional input cases found during real dry-run:
  - MinerU rewrites PDFs via PDFium (`mineru/cli/common.py:194,250,303`), so `_origin.pdf` is not necessarily byte-identical to the authoritative downloaded PDF. Classify it as a parser intermediate in known parser directories; preserve the download hash and bytes.
  - Unreferenced crops in known parser image directories are omitted from v2 and retained in the unchanged v1 source/snapshot.
  - Paper 2608.30224 has 12 HTML image references left unnormalized in content-list and page text. Authenticate its original Markdown by replaying the historical rewrite with matching raw/normalized asset bytes. Rewrite page references along with Markdown/content-list.
  - Paper 2608.30581 contains prose `[37](a larger cloud model)`. Require a complete Markdown link instead of falsely treating `a` as an asset path.
- Each case was observed RED before its implementation, then GREEN; combined focused tests: 98 pass, 0 fail; typecheck passed.
- Real dry-run reaches a complete 20-paper plan after these fixes. Final plan hash is generated only after review and final code synchronization.

The old sources and verified snapshot remain intact. Permanent deletion remains gated after migration and acceptance.

2026-09-05 approval update: the user chose recoverable archival, not permanent deletion, for all four old roots. Old code was first saved as Git commit `0521fc1f7cb5c5abb4ebcc910cbc1c0ce4345c99` on `codex/fsd-legacy-snapshot-20260905`; the original worktree HEAD and index were preserved. All ignored files will also remain in the complete directory archive.

## Final code gate

- Independent review approved the resource-closure fixes, writer/page normalization and CLI path mappings with no important findings.
- The stricter Archive verifier exposed 13 renderer-fixture failures. Renderer defense tests now inject page text after verifying their base Archive; Archive tests separately reject missing and traversal page references. All 22 renderer tests pass.
- Final full suite: **1091 pass, 4 skip, 0 fail** (1095 tests / 82 files); typecheck and diff checks pass.
- Formal code files synchronized and SHA-256 verified. Reviewed real Archive plan: `9168c7ec336421f1c65841b05e379e39306dccc730cee56a19cc89db253f77c2`, 20 papers, 247,564,005 input bytes, 57,244,984 target bytes.
- Before apply: legacy database hash remains `5445FC059FB158C122DE4FF7FCDBA63EDCC9AB3BF6631CEAABB1C83BEDC68E85`; process inspection finds no project writer (unrelated MinerU MCP processes are untouched).

## Real apply evidence

- Archive apply: 20 migrated, same reviewed hash, every installed package verified and all legacy inputs rehashed at installation boundaries.
- State apply and exact read-only replay: hash `3c7be0c39934d6917bd9aa870617ba8e1361d3c13f7e2da588d645c388a8ffd2`, 128 rewritten database cells, 19 operations, 24 run files, 2 receipts, integrity `ok`, 0 foreign-key violations, 0 old path/project-ID occurrences.
- Vault first apply stopped before installation: separate validator duplicated the historical partial Markdown-link regex and misread prose as destination `a`. Added failing validator regression; both consumers now share the same complete inline-link grammar. Old Vault remains untouched; failed staging retained for reviewed cleanup.

## Vault and runtime reconciliation

- Failed staging was verified after the regex repair, then moved (not deleted) to the plan-artifact directory as `failed-vault-staging`.
- Same-hash Vault apply passed: `bc10352ed181c45e9803c50166a5ad4d285d1fa0702e21849fd38069318cd63d`, `D:/paper/fsd`, 20 papers, 4 indexes, 0 broken links, 0 missing assets, 35 original settings files retained.
- Runtime reconcile exposed legacy Wiki assumptions and a missing downloads-cache error. Added L2 Archive/Evidence reconciliation and absent-cache handling; discovery-only candidates are not falsely reported as missing PDFs. Real CLI reconcile reports all 20 papers consistent with empty retry/missing/duplicate lists and valid Evidence.
- Review caught that one corrupt Archive aborted all reconciliation. Added missing/corrupt two-paper regressions (RED then GREEN), collected per-package issues and continued auditing. Focused tests 7/7, typecheck passed; scoped independent re-review approved.

## Pending acceptance and protected cleanup

- New one-paper current task used **configuration dates 2026-01-01 → 2026-09-05**, limit 1. OpenCLI preparation passed at the new code root.
- Run `dd2dfbf0-e620-4331-a510-e169b3a7f419` / job `035d6e79-67e4-4b4c-a44e-e94ce42ef877` failed discovery after six connection attempts. Both Bun fetch and system curl independently return connection reset for arxiv.org and export.arxiv.org. MinerU was never launched, no new paper selected/downloaded, and interrupt/resume acceptance is **not** complete.
- Active code/config/scripts/templates contain no old names except the centralized historical compatibility module; CONTEXT uses old names only as forbidden examples. Preserved historical publication backups and `.obsidian/workspace.json:lastOpenFiles` still contain old names. Settings were deliberately copied byte-identically; Step 7 remains unchecked.
- Old Codex automation `ai` (AI 遗留系统现代化论文周更) referenced `D:/fsd-code2xdoc`, old PDF/Vault paths and npm/LLM workflow. Initial permission review rejected removal; the user then explicitly approved deleting this exact automation. The automation API confirmed deletion. No replacement is created until real smoke acceptance passes; Step 8 is checked.
- Preliminary cleanup audit only: current-work/old-code/old-PDF plans admit no entries; old-data/old-work scans fail closed on a test-created reparse point at `tmp/bun-tests/evidence-publisher-02hsxW/state/runs`. No old source, database, PDF, Vault, settings, or test tree was deleted. This is not the final accepted deletion plan (Step 9 remains unchecked).
- Operational JSON plans/results and diagnostic helpers: `D:/agent-data/backups/paper-libraries/fsd/migration-plans/20260905-165920`.
- Final independent on-disk recheck verified 20 Archive packages and all 493 planned Vault files (including all 35 settings files); legacy SQLite SHA-256 remains unchanged. DNS resolves both arXiv hosts and hosts-file lookup found no arXiv override; no network settings were altered.
- The final reconciliation adjustment also handles an as-yet absent Archive root (download-only library) as a reported issue, preserving retry classification while still rejecting non-ENOENT access/traversal errors. Existing CLI database regression observed RED then GREEN; combined 11 tests passed, and scoped review approved.
- After user interruption, the prior test process result was unavailable, so verification was rerun. Default-timeout full run: 1094 pass, 4 skip, one migration-replay timeout at 5125.96 ms (default 5000 ms). The exact replay test then passed alone at 2532.05 ms; final full verification uses `bun test --timeout 15000` without skipped assertions or production timeout changes.
- Final verification completed: **1095 pass, 4 skip, 0 fail**, 1099 tests across 82 files, 131.52 seconds with test timeout15000ms. Typecheck and diff checks passed. The four pre-existing gated smoke tests remain skipped; real external-network smoke is separately and explicitly pending.

## Continued real acceptance (supersedes the earlier network diagnosis)

- Direct requests reset, but the already-running local proxy `127.0.0.1:7897` returns HTTP 200 for both arxiv.org and export.arxiv.org. The shell had no proxy environment and the system proxy was disabled. Thus direct resets did not establish an arXiv outage; an explicit machine proxy is being integrated for OpenCLI and PDF download, without changing system settings or routing loopback MinerU through it.
- Real OpenCLI discovery completed all 16 shards: 313 distinct candidates, 217 eligible, 20 already present, 197 remaining. With configuration dates 2026-01-01 → 2026-09-05 and explicit smoke limit 1, run `dd2dfbf0-e620-4331-a510-e169b3a7f419` selected and downloaded `2608.30345v1` (17 pages, 2.6 MB).
- Normal cancellation was requested only when batch 2 began (one processing window completed). API PID 12260 terminated with cleanup confirmed and no active child PIDs. Evidence: `smoke-interrupt.json`.
- Retrying the same current task reused the fixed paper and PDF without discovery/download, created a new task-owned API PID 68184 and successfully parsed all 17 pages in 1m32s. API cleanup was again confirmed. Archive now contains 21 papers. Publication stopped because old immutable receipts carry pre-migration Archive identities; the runtime attempted to compare them directly with v2 identities. This requires an authenticated migration baseline, not rewriting receipts or skipping verification. Evidence: `smoke-resume.json` (failure retained until publication acceptance).
- Obsidian recent-file history was updated from stale paths to four existing Evidence paths. Only `lastOpenFiles` changed; other workspace fields compare equal. Original workspace JSON is backed up; updated SHA-256 `9c5bdebf5cb59c790cb4d48dce52fd4afe10bbff57e9eada72912970ec49bc69`.
- Fixed-root recoverable retirement dry-run: 57,973 regular files / 474,704,511 bytes / 602 links. SHA-256 `ed388e2ab74a7cb0c739e6d501995697705f1b8de6523c27b1ce2ba8186a10b9`. All links are inventoried without traversal. No move has yet occurred; apply waits for successful 21-paper publication and reconciliation.
- Persistent proxy acceptance: an environment without HTTP/HTTPS/ALL proxy variables used only `machine.local.yaml` and completed a real OpenCLI AI-FSD shard (9 papers, 12.31 seconds). No library selection/download/state was changed; evidence: `configured-network.json`.
- Final scheduler inspection found Windows task `agent-data-fsd-code2doc-weekly` still enabled, invoking the legacy PowerShell entry, every three weeks on Monday at 22:30. Its complete XML was saved as `legacy-windows-task.xml` and DOM-compared with the live definition before disabling. It is now `Disabled` and remains recoverable. This is distinct from the already-deleted Codex automation `ai`; no replacement schedule was invented.

## Publication acceptance and final handoff repairs

- Reviewed migration baseline `91cf4a7b041eb359a0d073e7235d28274b659e752c154d9b5b04b83b9ab3f8c3` was dry-run, installed and replayed with the same hash. Its immutable SQLite anchor authenticates original receipt identities and their reviewed V3 projections; normal publishing no longer requires the old roots or external migration plans. Independent baseline review approved; 93 focused publisher/baseline tests passed.
- A pre-baseline consistent SQLite backup was verified (6,217,728 bytes, SHA-256 `dd2de651b46da063237aead8bb92d9cd47e5ed1b198e556d6be01fd672c1c75e`, integrity `ok`, 0 foreign-key violations).
- Real publication completed for run `dd2dfbf0-e620-4331-a510-e169b3a7f419`: `evidence-eda5f6b58ac6cd8aa532f3e6d13c9064`, 21 sources. Repeated publication is idempotent. Both original completed runs also replay successfully without rewriting their receipt/DB identities or reverting the new paper.
- Reconciliation then detected that newly parsed papers still referenced `work/downloads`. Added a real parse-boundary regression, observed RED, then atomically adopted the permanent Archive PDF in the same transaction that completes the parse attempt. Guards preserve stale-version protection and roll back path/status adoption if attempt completion fails. Review caught a stale `downloaded_version`; it now adopts the authenticated current attempt version. Tests cover v1/v2 same-byte adoption, removal of the download copy and download-layer reuse with no network request.
- The already-completed real paper was repaired without reparsing, using a hash-bound one-paper plan `fb60d3b7c4b6c75fa1da609e77ba7edde2694c2f1765e266f18a3f178da29fd1`, matching Archive/PDF/attempt identities and a transaction recheck. Original values and pre-adoption database are retained externally. Reconciliation now reports all 21 consistent, with no missing/retry/duplicate entries and valid Evidence.
- Final API lifecycle check on the formal new code root: fixed `127.0.0.1:17860` became ready; PID 66032 cleanup was confirmed, no child remained and the port was independently rebound after disposal. Evidence: `live-api-verification.json`.
- Full-suite attempts exposed two distinct issues: the sandbox denied ancestor `realpath` under `C:/Users/yyc` (24 permission failures; all 37 affected tests pass unchanged using isolated `D:/agent-data/tmp/pke-final-20260905`), then an actual Windows duplicate-case environment-key issue in the real OpenCLI proxy test. No safety checks were relaxed; final full-suite rerun follows the environment fix.

## Four legacy roots retired recoverably

- User-approved fixed-root plan `ed388e2ab74a7cb0c739e6d501995697705f1b8de6523c27b1ce2ba8186a10b9` applied successfully: all four roots renamed under `D:/agent-data/backups/paper-libraries/fsd/retired-legacy-20260905`, with each original content hash and directory identity verified after moving. All four original paths are absent. No recursive deletion, linked-target traversal or cross-volume copy occurred.
- Independent review identified journal-failure rollback and audit-path link checks; both fixed and scoped re-review approved. All 8 memory-only fault-injection tests pass against actual script SHA-256 `ef6a19ac7ec202c65ff68a117670abf5f3c8fe6477b8ca5816d8e7a236582cd0`.
- Archived legacy database hash remains `5445FC059FB158C122DE4FF7FCDBA63EDCC9AB3BF6631CEAABB1C83BEDC68E85`. Original worktree index hash remains `36ff2262871d5648de86beb5421e8c77e5d8a2ac03993b41e7cb000e11f41b33`, HEAD remains `aef254b300c3ef4e2d046222affcfd2b3108e5c3`.
- Post-retirement audit: 21 verified Archives and 21 parsed rows, SQLite integrity `ok`, 0 foreign-key violations, 0 active old references, 21 valid Vault papers, 4 indexes, 0 broken links/missing assets. The 18 historical-reference files are the centralized compatibility module and preserved historical publication backups, not live old-root dependencies.
- Post-retirement normal CLI publication replay passes; the pure Bun menu starts and exits correctly at the new formal root. Configuration reads `startDate=2026-01-01`, `maxPapers=10`, new data/Vault paths and the explicit local proxy.
