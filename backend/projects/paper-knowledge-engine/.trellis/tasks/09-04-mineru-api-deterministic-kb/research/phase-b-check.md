# Phase B Check — operation ownership and truthful results

Date: 2026-09-04

## Implemented behavior

- The interactive Bun menu owns only readline and an abort controller. It no longer creates, borrows, shares, or disposes a MinerU session.
- Every parse-producing menu command forwards the session factory to `executeOperation`; the workflow creates one lazy operation-owned session and disposes it in `finally`.
- Real readline EOF and external abort settle the menu. Zero-argument `SIGINT`/`SIGTERM` listeners map to explicit signal names; SIGINT sets exit code 130.
- A disposal failure suppresses the returned business DTO. The public CLI output is only the failed `JobView`, with `PROCESS_CLEANUP_UNCONFIRMED` retaining priority.

## TDD evidence

- Initial RED failures proved the old menu created one shared session for two task commands, created a session for view-only commands, surfaced abort as an exception, and emitted a successful business DTO after disposal failure.
- A real-readline child fixture proved `main()` remained unsettled after EOF until the readline close event was wired to the shared abort signal.
- A zero-argument signal-listener test exposed the previous incorrect assumption that Node/Bun supplies the signal name to the callback.
- A controlled mutation restored the old unconditional `onResult` call; the CLI result test failed with `completed` instead of `failed`.

## Verification

- `bun run typecheck`: pass.
- `bun test tests/workflow.test.ts tests/job-bridge.test.ts tests/cli-menu.test.ts --timeout 30000`: 24 pass, 0 fail in the final source state.
- Expanded lifecycle suite covering menu, workflow, bridge, API session, runner, and managed processes: 69 pass, 0 fail.
- `rg` over `src/worker.ts`, `src/operation-service.ts`, and `src/job-bridge.ts`: no MinerU session lifecycle symbols.

## Independent review

Subagent `01a06874-5a96-7511-9d12-8d94794571fc` reported no findings and made no file changes.

Residual risks recorded by the reviewer:

- The review intentionally excluded unrelated dirty-tree changes.
- The real-readline child test uses a 500 ms internal timeout and may be timing-sensitive on an extremely loaded Windows runner.
- A custom injected `readLine` double must respond to its own external abort; the production real-readline path is covered.
