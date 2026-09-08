# Phase D Check — OpenCLI and deterministic publication

Date: 2026-09-04

## Proven behavior

- Discovery prepares a missing OpenCLI installation before the first shard.
- If preparation fails, neither the managed OpenCLI process nor the legacy injected transport is invoked; the dependency/package error remains visible.
- Archive source validation requires `normalized/full.md`, `normalized/pages.json`, `normalized/content-list.json`, their manifest identities, the PDF identity, and every referenced asset.
- Each managed paper publication contains `document.md`, copied assets, `pages.md`, `pages.json`, `content_list.json`, `index.md`, and `manifest.json`; the run also receives a publication receipt.
- `document.md` is the normalized MinerU Markdown with only CRLF-to-LF normalization and verified local asset-link rewrites. The exact byte expectation is tested.
- The deterministic file list contains no `mineru-original.md`, and renderer tests reject semantic/LLM-generated sections.

## Change scope

- No Evidence production file was changed in Phase D.
- The OpenCLI test gained a preparation-failure/no-fallback regression.
- The renderer test now proves the exact Markdown transformation, including CRLF normalization.

## Verification

- `bun test tests/opencli-installation.test.ts tests/opencli-runner.test.ts tests/evidence-archive-reader.test.ts tests/evidence-contracts.test.ts tests/evidence-render-paper.test.ts tests/evidence-publisher.test.ts --timeout 30000`: 94 pass, 0 fail.
- `bun run typecheck`: pass.
- Scoped `git diff --check` for the two test modifications: pass.

## Independent review

Subagent `01a0687f-421b-7df3-976d-c32814da6e34` reported no findings and made no file changes.

Recorded limitations:

- The reviewer was stopped after bounded static inspection and did not rerun tests.
- Several Evidence files are untracked or otherwise user-modified, so the main session's explicit file inspection and test results are the primary evidence.
- All pre-existing Evidence changes remain protected from broad staging or overwrite.
