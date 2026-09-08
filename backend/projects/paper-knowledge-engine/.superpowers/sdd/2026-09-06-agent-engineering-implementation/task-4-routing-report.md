# Task 4 routing follow-up

## Scope

The main Task 4 workflow commit intentionally stopped at an injected contract. This follow-up adds the minimal `runConfiguredTask` dispatch needed by the implementation plan without assembling CLI-specific adapters or Evidence services.

## Changes

- `src/library/execution.ts` now loads the layered context once and routes `research` libraries before any paper-only `loadConfig`, MinerU-local configuration, bootstrap, harvest, PDF, or FSD pipeline code.
- `ConfiguredResearchContext` supplies the injected research dependencies and optional run/resume functions; the defaults are `runResearchTask` and `resumeResearchTask`.
- The route supplies the research library, its library-local data root, and the opened StateStore; it always closes the store. `resumeRunId` selects the explicit resume function.
- Paper libraries retain the existing current/weekly validation and return type through overloads.
- `TaskInput` carries optional research `tracks` and `sourceKinds`; CLI parsing/adapter assembly remains a later CLI integration concern.
- Missing research injection fails before opening a StateStore with `RESEARCH_WORKFLOW_UNCONFIGURED`.

## Verification

```text
bun test tests/research-execution-routing.test.ts --timeout 30000
  3 pass, 0 fail
bun test tests/research-library-config.test.ts tests/run-task.test.ts tests/configured-task-limits.test.ts --timeout 30000
  44 pass, 0 fail
bun run typecheck
  pass
```

The existing research configuration test was updated to assert the new explicit unconfigured-workflow boundary. No CLI/menu behavior or StateStore source was changed in this follow-up.
