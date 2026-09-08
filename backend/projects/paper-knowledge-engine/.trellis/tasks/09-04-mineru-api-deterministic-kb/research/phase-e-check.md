# Phase E Check — real-state resume semantics

Date: 2026-09-04

## Proven behavior

- A three-paper frozen run uses a real SQLite state store, frozen selection/parse manifests, a valid successful Archive for A, a failed attempt for B, and no attempt for C.
- Resume keeps the same `runId`, makes no discovery or PDF download call, and sends A/B/C through the production `runLocalParse()` boundary.
- Production recovery reuses A without calling the MinerU runner; the runner is invoked exactly for B and C, in that order.
- After B/C succeed, verified Archive sources A/B/C are published and each managed paper receives `document.md`.
- The repeated-failure case creates a real failed operation, calls `resumeOperation()` for the same job, and proves `executeOperation()` supplies the original `runId` automatically.
- When B fails again, C is not attempted, publication is not called, and the operation remains failed with `canResume=true`.

## Verification

- `bun test tests/pipeline.test.ts tests/automatic-selection-resume.test.ts tests/run-task.test.ts tests/three-paper-resume.test.ts --timeout 30000`: 28 pass, 0 fail.
- `bun test tests/three-paper-resume.test.ts --timeout 30000`: 2 pass, 0 fail after both review fixes.
- `bun run typecheck`: pass.
- Scoped `git diff --check`: pass before review fixes; final full-scope diff checking is part of Phase F.

## Independent review

The first reviewer (`01a06888-9061-7b23-a53a-cc5085ac6c3e`) found two test-integrity gaps:

- A was skipped by test-owned logic instead of the production parse boundary.
- The failure case supplied `resumeRunId` directly instead of using the operation resume path.

Both were corrected independently and retested. The second reviewer (`01a0688e-c2cd-7610-987b-4f7d9269aad9`) reported no findings and confirmed that the two earlier false-positive risks were removed.

## Change scope

- Added `tests/three-paper-resume.test.ts`.
- No production code was changed in Phase E because the existing implementation satisfied the strengthened real-state regression.
