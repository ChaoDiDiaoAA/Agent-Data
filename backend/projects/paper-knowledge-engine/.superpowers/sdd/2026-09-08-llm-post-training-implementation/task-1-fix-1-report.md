# Task 1 Fix 1 Report

Changed query-matrix.yaml to restore all 18 Appendix A topic expressions and policy.yaml to restore the exact initial term variants. Extended the contract test with fixed query and variant assertions.

Tests: `bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts` passed (1/1); `bunx tsc --noEmit` passed; harvest plan reports 18 tracks, 36 shards, and maxPapers 180.

Remaining concern: expressions are intentionally the uncalibrated Appendix A seed and remain subject to Task 2/5 review.
