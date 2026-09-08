# Implement LLM Post-Training Knowledge Library

## Goal

Add an isolated `llm-post-training` paper library that collects and publishes evidence about large language model post-training methods while reusing the existing deterministic paper pipeline.

## Requirements

- Load as `library_kind: paper` with the exact display name `LLM Post-Training（大模型后训练知识库）`.
- Provide the four active configuration files: `library.yaml`, `query-matrix.yaml`, `paper-policy.yaml`, and `categories.yaml`.
- Configure 18 post-training Tracks, submitted/updated discovery shards, Current/Weekly limits, and library-scoped paths.
- Use OpenCLI/arXiv for automatic discovery and preserve explicit local PDF import; do not add a Research workflow, LLM-generated knowledge, model training, dataset/weight downloads, or paper-code execution.
- Keep FSD, Agent Engineering, Multi-Agent Engineering, and the new library's state, PDFs, Archive, Vault, locks, watermarks, and receipts isolated.
- Calibrate deterministic title/abstract keyword filtering with positive, negative, and boundary fixtures, while documenting that lexical filtering is not semantic review.
- Run a 5–10 paper end-to-end trial, review 20–40 unique accepted candidates when available, and record source/version, parsing, publication, recovery, and coverage evidence.
- Keep manual Weekly execution available while not registering an automatic scheduled task in the first release.

## Acceptance Criteria

- [ ] Four configuration files load through the shared paper contract; all 18 Tracks, PDF mappings, 36 shards, limits, and derived paths match the approved design.
- [ ] Focused and full deterministic tests pass, including direction routing, filtering boundaries, four-library isolation, checkpoint/resume, local import, Archive v2, and Evidence v3 regressions.
- [ ] User-facing README, configuration, context, handbook, operations, and historical-candidate documentation match actual CLI behavior.
- [ ] A real 5–10 paper trial produces verifiable Archive/Evidence output or records a concrete failure without claiming success; candidate relevance review reaches the documented threshold when sample size permits.
- [ ] Historical foundation candidates retain real source/version mapping and local import does not advance automatic arXiv watermarks.
- [ ] Manual Weekly and reconciliation behavior are verified; no new scheduled task is registered.

## Scope exclusions

No training platform, benchmark runner, vector index, automatic Q&A, automatic summary/recommendation, cross-library deduplication, or automatic Knowledge layer is part of this task.
