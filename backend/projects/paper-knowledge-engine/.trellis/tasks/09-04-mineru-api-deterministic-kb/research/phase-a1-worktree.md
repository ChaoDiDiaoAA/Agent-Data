# Phase A1 — Working-tree baseline

Captured: 2026-09-04 (Asia/Shanghai)

## Repository identity

- Git root: `D:\agent-data`
- Project root: `D:\agent-data\backend\projects\fsd-code2doc`
- Branch: `codex/phase-1-layout-migration`
- HEAD: `faccbcd32f47cbf1deb742dd59afd841a4192f98`

## Reproducible status snapshot

The expanded `git status --porcelain=v1 --untracked-files=all` snapshot contains 415 dirty file entries across the repository and 258 under this project. Independent Git views report 20 staged paths, 125 unstaged tracked paths, and 272 untracked paths. These counts overlap by design because a path can have both staged and unstaged changes.

Project dirty entries by first path segment:

| Segment | Count |
|---|---:|
| `.trellis` | 55 |
| `tests` | 55 |
| `src` | 50 |
| `.agents` | 46 |
| `config` | 9 |
| `.codex` | 8 |
| `migrations` | 6 |
| `templates` | 5 |
| `opencli` | 5 |
| `automation` | 4 |
| `docs` | 4 |
| `scripts` | 2 |
| project-root files | 7 |

Commands used:

```powershell
git status --porcelain=v1 --untracked-files=all
git diff --cached --name-only
git diff --name-only
git ls-files --others --exclude-standard
git log --oneline --reverse c66f09e..HEAD
git diff --name-only c66f09e..HEAD
```

## Classification

### 1. Current Trellis planning and workflow artifacts

The following paths were created or deliberately edited for this active task and may be updated as task bookkeeping:

- `.trellis/**`
- `.agents/**`
- `.codex/**`
- `AGENTS.md`
- `CONTEXT.md`
- `docs/adr/0001-scope-mineru-api-to-one-operation.md`
- `docs/adr/0002-publish-mineru-markdown-as-managed-projection.md`
- `docs/adr/0003-separate-managed-evidence-from-human-knowledge.md`
- `docs/superpowers/plans/2026-09-03-mineru-session-service.md` only for the final superseded/status annotation already required by Phase H

### 2. Committed MinerU L2 implementation baseline

The range `c66f09e..faccbcd` contains nine implementation commits. Its product paths are:

- `config/mineru-local.yaml`
- `src/cli-menu.ts`, `src/cli.ts`, `src/workflow.ts`
- `src/local-pdf-import.ts`
- `src/mineru-api-session.ts`, `src/mineru-cli-runner.ts`, `src/mineru-local-config.ts`, `src/mineru-local-jobs.ts`
- `src/runtime/process.ts`, `src/types/config.ts`
- the corresponding focused tests: `cli-menu`, `configured-task-limits`, `job-bridge`, `local-pdf-import`, `mineru-api-session`, `mineru-cli-runner`, `mineru-config-cli`, `mineru-local-config`, `mineru-local-jobs`, `mineru-short-path`, `runtime-bun-process`, `runtime-process`, and `workflow`

Later phases may modify only the subset explicitly named by that phase and must compare against HEAD before editing.

### 3. Overlap-sensitive current Archive/Evidence work

These current working-tree paths contain pre-existing intended project work and must be preserved byte-for-byte outside the minimum hunks needed by Phase D:

- staged plus unstaged: `src/evidence/archive-reader.ts`, `tests/evidence-archive-reader.test.ts`
- unstaged tracked: `src/evidence/contracts.ts`, `src/evidence/manifest.ts`, `src/mineru-workspace.ts`, `src/types/jobs.ts`, `tests/evidence-contracts.test.ts`
- untracked: `src/evidence/publisher.ts`, `src/evidence/receipt-store.ts`, `src/evidence/render-indexes.ts`, `src/evidence/render-paper.ts`, `src/evidence/template-assets.d.ts`, `tests/evidence-publisher.test.ts`, `tests/evidence-render-paper.test.ts`

Phase D must first read and test these bytes as user-owned baseline. It may add only demonstrably missing contract assertions or minimum fixes and must use explicit path-limited commits.

### 4. Protected by default

Every dirty path not named in sections 1–3 or in the current implementation-plan step is protected, including root-level deleted legacy files, migration work, unrelated tests/configs, and all legacy PowerShell deletion state. No task command may stage with `git add .`, `git add -A`, a directory-wide add, or an unrestricted commit.

## Existing staged paths

The index already contains 20 paths. Two are overlap-sensitive project files and eighteen are legacy/root migration deletions or tests:

- `backend/projects/fsd-code2doc/src/evidence/archive-reader.ts`
- `backend/projects/fsd-code2doc/tests/evidence-archive-reader.test.ts`
- `config/metadata-sources.yaml`
- `config/mineru-mcp-policy.yaml`
- `scripts/check-mineru-preconditions.ps1`
- `scripts/smoke-mineru-local.ps1`
- `scripts/start-mineru-api.ps1`
- `scripts/start-mineru-mcp.ps1`
- `src/mineru-mcp-jobs.js`
- `src/mineru-result.js`
- `src/report.js`
- `tests/automation-prompt.test.js`
- `tests/mineru-automation-prompt.test.js`
- `tests/mineru-config.test.js`
- `tests/mineru-mcp-jobs.test.js`
- `tests/mineru-pipeline.test.js`
- `tests/mineru-result.test.js`
- `tests/smoke-mineru-local.tests.ps1`
- `tests/start-mineru-api.tests.ps1`
- `tests/start-mineru-mcp.tests.ps1`

Any later commit must name exact files with `git commit --only -- <paths>` so these pre-existing staged entries cannot leak into task commits.

## A1 conclusion

The working tree is safe to continue only under a default-deny path policy. The current task may touch Trellis artifacts plus the exact files named by the active implementation step; all other dirty paths remain user-owned and protected.
