# Phase F Check — automated full-scope gate

Date: 2026-09-04

## Final gate

- `bun run typecheck`: pass.
- `bun test --timeout 30000`: 593 pass, 4 explicit skips, 0 fail, exit code 0; 597 tests across 65 files.
- `git diff --check -- backend/projects/fsd-code2doc`: pass. Git emitted only existing LF/CRLF conversion warnings.

Three skipped tests are the existing opt-in maintenance/runtime checks. The fourth is the explicit `FSD_MINERU_SMOKE=1` GPU acceptance added for Phase G; it is skipped only in the default suite and was run successfully as a real test during G1.

## Full-suite defects resolved

- Import-preview and crashed-worker fixtures injected business boundaries without a borrowed MinerU session, so operation ownership failed before the intended test callback. The fixtures now explicitly inject a no-op borrowed session; production ownership remains unchanged.
- CLI menu and job-bridge tests left `process.exitCode` set after intentionally exercising failure paths. Exit-code restoration now uses Bun-compatible zero restoration, and the route-normalization test no longer hides failed operations.
- The operation session previously allowed a replacement FastAPI after a server exit. It now enters a terminal ended state, never starts a second API within the same operation, and reports delayed unconfirmed cleanup during disposal.
- The paper index previously rendered an Archive-relative PDF locator as a Vault-relative link even though the PDF is not published to Obsidian. It now renders a non-clickable Archive PDF locator while retaining path and SHA identity.

## Review

The first full-task reviewer (`01a06894-6bcf-7b21-a0d6-853634c51b98`) found the API restart/cleanup defect and the broken PDF link. Both were reproduced with failing tests, fixed, and retested.

A second focused reviewer (`01a0689d-ac27-7f20-b243-83b6ff57077f`) reported no findings after the fixes.

## Protected worktree

The repository still contains extensive pre-existing staged, unstaged, and untracked user work. Verification was performed in place without broad staging, resetting, or deleting files. Commit scope remains deferred to the explicit Trellis commit-plan checkpoint.
