# Phase C Check — fixed API inference and origin contract

Date: 2026-09-04

## Implemented behavior

- A pipeline FastAPI server receives the configured shared inference environment plus `MINERU_VIRTUAL_VRAM_SIZE=5`, the MinerU 3.4.5 control corresponding to `pipelineBatchRatio=1`.
- The per-document client retains the same compatibility environment behavior.
- The public runner accepts only the exact configured origin string `http://127.0.0.1:<apiPort>`; root slashes, custom paths, credentials, query strings, fragments, alternate hosts, ports, and protocols are rejected.
- Production references to `runMineruCli` are limited to its definition and the MinerU API session boundary.

## TDD evidence

- The server launch test failed with `MINERU_VIRTUAL_VRAM_SIZE` undefined before the implementation change.
- The origin test failed because a plain custom path was accepted before validation was tightened.
- The minimal implementation added the pipeline ratio mapping to the server environment and replaced permissive URL parsing with exact configured-origin equality.

## Verification

- `bun test tests/mineru-api-session.test.ts tests/mineru-cli-runner.test.ts --timeout 30000`: 30 pass, 0 fail.
- `bun test tests/mineru-api-session.test.ts tests/mineru-cli-runner.test.ts tests/runtime-process.test.ts tests/runtime-bun-process.test.ts --timeout 30000`: 45 pass, 0 fail.
- `bun run typecheck`: pass.
- Scoped `git diff --check`: pass.
- Production boundary search found no direct runner use outside `mineru-api-session.ts` and the runner definition.

## Independent review

Subagent `01a06879-8ba1-7d50-b5d8-def1f469a255` reported no findings and made no file changes.

Residual risks recorded by the reviewer:

- It performed static diff review and relied on the main session's test evidence.
- Static search cannot prove the absence of hypothetical runtime alias calls.
- The new server assertion covers the configured ratio 1; other supported ratio mappings remain covered by the existing configuration-level tests rather than server launch tests.
