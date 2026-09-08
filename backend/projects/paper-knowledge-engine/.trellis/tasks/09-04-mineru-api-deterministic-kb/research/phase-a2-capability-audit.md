# Phase A2 — Old Tasks 1–5 capability audit

Captured: 2026-09-04 (Asia/Shanghai)

Baseline: `faccbcd32f47cbf1deb742dd59afd841a4192f98`

## Verification run

```powershell
bun test tests/mineru-local-config.test.ts tests/mineru-config-cli.test.ts tests/runtime-process.test.ts tests/runtime-bun-process.test.ts tests/mineru-cli-runner.test.ts tests/mineru-api-session.test.ts tests/mineru-local-jobs.test.ts tests/local-pdf-import.test.ts tests/configured-task-limits.test.ts tests/mineru-short-path.test.ts --timeout 30000
bun run typecheck
```

Results:

- Focused tests: 111 passed, 0 failed across 10 files in 13.14 seconds.
- TypeScript: `tsc --noEmit` passed.

No product source, test, or config file was edited during this audit.

## Retained capabilities

### Task 1 — Configuration contract

Retain. `MinerUCliConfig` loads and validates fixed loopback host, configured port, startup timeout, single concurrency/window, and supported pipeline batch ratio. CLI config output exposes the normalized values. Focused configuration tests pass.

### Task 2 — Loss-tolerant process output

Retain. Managed output uses replacement decoding while continuing to drain streams and enforce byte limits. The invalid UTF-8 success regression and split-codepoint streaming regression both pass, along with cleanup and process-record tests.

### Task 3 — Explicit API client boundary and diagnostics

Retain with one tightening item. `runMineruCli()` requires `apiUrl`, passes UTF-8/runtime environment, preserves structured supervisor failures, and has no production direct caller outside `mineru-api-session.ts`. Current validation still accepts a custom path on the configured origin; Phase C will require the exact origin.

### Task 4 — `MineruApiSession` state machine

Retain. Single-flight startup, loopback port refusal, health-contract validation, crash/no-replay semantics, later restart, dedicated safety root, startup timeout, disposal, and fail-closed cleanup all pass their focused tests.

### Task 5 — Parse routing

Retain. Configured task, specified-paper parse, and local import tests prove that parsing uses an injected session runner. `rg -n "runMineruCli\\(" src` returns only the exported definition; the session module imports and invokes it through its injected/default `runClient` boundary.

## Confirmed gaps for the new plan

1. **Menu lifetime conflicts with the approved architecture.** `src/cli.ts:523-554` creates one menu-owned session and disposes it only after `runInteractiveMenu()` returns. Phase B must remove this cross-operation ownership; each parsing operation owns its own lazy session.
2. **Cleanup failure can leak a success DTO.** `src/workflow.ts:173-180` converts the durable job to failed after dispose failure but still calls `onResult(returnedResult)` when business work had returned. Phase B must suppress that callback and CLI success output.
3. **Batch ratio is not on the inference server.** `src/mineru-api-session.ts:224` gives the server `buildMinerUProcessEnv(config)`, while `MINERU_VIRTUAL_VRAM_SIZE` is added separately only to the per-paper client at `src/mineru-cli-runner.ts:137-138`. Phase C must put the inference setting on the server and prove Batch Ratio 1 in a real run.
4. **Runner URL is origin-compatible, not exact-origin.** The public runner currently preserves a valid custom path. Phase C must reject paths and use only the configured origin.
5. **OpenCLI automatic preparation exists but is not part of this baseline run.** `src/opencli-runner.ts:170` calls `ensureOpenCliPrepared()` before discovery and a focused test exists at `tests/opencli-installation.test.ts:268`; Phase D must run and strengthen the requested contract rather than rewrite it blindly.
6. **Markdown publication exists in overlap-sensitive uncommitted work.** `src/evidence/render-paper.ts:158` emits `document.md` from verified full Markdown and current tests cover resources/no-LLM content. Phase D must treat those bytes as user-owned baseline and add only missing contract proof.
7. **Three-paper resume acceptance is missing.** Existing checkpoint mechanisms appear compatible, but A/B/C fixed-manifest behavior is not yet proven end to end.
8. **Real reusable-server evidence is missing.** No completed GPU two-request smoke proves one server launch, one model initialization, Batch Ratio 1, two normalized outputs, and confirmed cleanup.

## A2 conclusion

Old Tasks 1–5 are a valid tested baseline and should not be reimplemented. The new work begins at lifecycle ownership/result truthfulness, server-side inference configuration, exact-origin validation, then contract/resume/real-machine acceptance.
