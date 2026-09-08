# LLM Post-Training Knowledge Library — Execution Plan

The detailed implementation checklist is maintained in [the approved SDD plan](../../../../docs/superpowers/plans/2026-09-08-llm-post-training-implementation.md). Execute tasks in order and keep the SDD ledger as the progress source.

1. Add the four direction YAML files, isolated fixture, and contract tests.
2. Add policy positive/negative/boundary tests and calibrate queries/terms.
3. Add shared-route, menu, checkpoint, and four-library isolation tests.
4. Update user-facing docs and create the historical foundation candidate ledger.
5. Run and document the real 5–10 paper trial plus candidate relevance review.
6. Build the initial collection, import selected historical PDFs, verify manual Weekly/reconciliation, and confirm no scheduler task.

Required checks include `bun run typecheck`, focused direction/regression tests, and `bun test --timeout 30000`. Do not register a scheduler or modify production roots during fixture tests.
