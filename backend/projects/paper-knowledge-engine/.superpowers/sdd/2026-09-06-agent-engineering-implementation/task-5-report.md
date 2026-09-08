# Task 5 implementation report

Status: complete and locally verified (2026-09-07). The research Evidence projection is additive to the existing FSD publisher: it writes only `Evidence/sources` and the four generic indexes, and it never creates or updates `Knowledge/`.

## Implemented contract

- `SOURCE_EVIDENCE_LAYOUT_V1` fixes the generic layout and validates source kind, 32-character source identity, version identity, and safe relative paths.
- Research source rendering is filesystem-free and deterministic. Each verified Archive produces `index.md`, `source.md`, `content.md`, `citations.md`, and a canonical `manifest.json`. Pages retain source/version identity, canonical URL, publisher/authors, dates, content hash, Tracks, dimensions, archive path, structured loop/permission/identity-tenancy/testing/evaluation facts, and citation locators without adding conclusions.
- Topic, source-kind, lifecycle, and concept indexes are stable and source/version ordered. A multi-Track source has one link per version in the topic projection; older versions remain addressable.
- `source-receipt-store.ts` enforces the exact version-1 receipt schema, canonical JSON bytes, lowercase SHA-256 values, sorted unique source/version entries, immutable replay equivalence, and validated temporary receipt recovery.
- `research-publication-transaction.ts` is the public internal generic transaction layer. It validates target ownership, rejects symlinks/path escapes, uses the research run lock, records a canonical journal, backs up replaced files, rolls back crash-left installs, and removes transaction state only after byte verification.
- `source-publisher.ts` accepts only verified research Archive values, revalidates manifest/file identity, binds the frozen selection hash and run/publication identity, reserves/completes/fails the existing research StateStore publication, and refuses direct temporary-directory publication.
- `bootstrapStageOne` now accepts `libraryKind: 'paper' | 'research'`. Paper initialization remains `Evidence/papers/indexes`; research initialization creates `Evidence/sources/indexes` and does not create paper roots or `Knowledge/`.

## TDD and verification

1. Added the four required research Evidence test files before the corresponding implementation. The initial run was RED because the receipt/publisher modules were absent and the renderer/bootstrap contracts were not implemented.
2. Final research Evidence run: `bun test tests/research-evidence-layout.test.ts tests/research-evidence-render.test.ts tests/research-evidence-publisher.test.ts tests/research-evidence-recovery.test.ts` — **10 pass, 0 fail**, 38 expectations.
3. The publisher tests cover first publish, byte-identical replay, publication/selection conflict, target tamper, journal interruption and recovery, path escape, and the no-paper/no-Knowledge boundary. Existing FSD publisher tests cover the symlink/junction and FSD regression boundary.
4. Existing regression run: all `evidence-*` and `archive-*` tests — **318 pass, 0 fail**, 710 expectations.
5. Final `bun run typecheck` — pass.

No network, OpenCLI, MinerU, live Archive discovery, or Obsidian Knowledge write was used. Existing user modifications remain preserved and are not part of the research publisher transaction.
