# Shared Type Boundaries

This directory contains small, strict TypeScript interfaces shared by the staged
TypeScript migration.  It deliberately declares only stable boundaries; the
remaining business configuration shapes stay with their modules until their
assigned migration tasks.

`config.ts` covers normalized paths, runtime policy, independent current/weekly
limits, arXiv settings and deterministic paper-admission policies. `papers.ts` covers discovery
metadata, candidates and harvest plans. `jobs.ts` covers windows, validated
selection recovery fields, parse identities/artifacts and progress events.
Legacy input metadata can omit downstream fields; SQL rows and persisted JSON
are checked at their reading boundaries instead of being cast to these types.

Task 8 adds normalized local-import/MinerU settings, PDF identities/pages,
local parse jobs, execution summaries and artifacts. Injected test runners can
omit production process fields, but a default MinerU invocation validates the
complete configuration and requires an explicit ProcessContext. Unknown external
JSON and artifact paths are checked by the owning module before these interfaces
are returned; timeout and cleanup status remain explicit.

The task boundary uses a result-status union plus compatibility-safe
parse/selection checkpoint shapes and deterministic task artifacts. Persisted JSON
is accepted as unknown and checked by the pipeline and artifact readers before
use. No SQL field, checkpoint serialization or operation/run ID is renamed to
satisfy TypeScript.
