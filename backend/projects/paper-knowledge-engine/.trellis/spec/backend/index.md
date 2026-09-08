# Backend storage paths

## Pre-Development Checklist

When changing machine roots, downloads, cleanup or Vault rebuilding, trace the field from `shared/engine-context.ts` through `shared/paths.ts` and `shared/config.ts` to its consumer. Read the contract below before editing those boundaries.

## 1. Scope / Trigger

Independent PDF storage is a configuration contract, not a change to Archive or Evidence formats. Machine-specific drive paths belong in YAML; each root is scoped by the selected library ID.

## 2. Signatures

`loadEngineContext({ root, libraryId })` exposes `machine.roots` and derived `paths`. `loadConfig({ root, libraryId })` exposes the `pdfRoot` consumed by `downloadAcceptedPdf`.

## 3. Contracts

- YAML `roots.pdf_libraries_root?: string` becomes `MachineConfig.roots.pdfLibrariesRoot` and `LibraryPaths.pdfRoot`.
- Configured PDF root is the machine PDF parent plus library ID; downloads retain existing category subdirectories.
- Without this optional field, old configurations retain `<dataRoot>/work/downloads`.
- `vaults_root` independently determines the Obsidian library root. Internal data and backup roots retain their existing roles.
- Successful parsing still adopts the verified Archive `source.pdf` as the database's authoritative PDF path. This does not remove the external downloaded original. Evidence keeps its self-contained reading copy.
- Direction documents live under `config/<libraryId>/`: `library.yaml`, `query-matrix.yaml`, `paper-policy.yaml`, `categories.yaml`. `configurationFiles()` owns their membership together with engine/machine files; policy snapshots hash every file. Retired configuration is test fixture input only.
- Pass the selected `libraryId` to `loadMinerULocalConfig(root, { libraryId })` at configuration, task, local import/parse and operation-session boundaries. Omitting it defaults to FSD and would misroute another library's Archive/work paths.
- Current Archive packages are direct children: `archive/<baseId>-v<version>/source.pdf`. Update writer, job paths, publication reader, reconciliation, migration targets and rebuild together. Vault still uses `Evidence/papers/`; historical source formats remain historical.

## 4. Validation & Error Matrix

| Input | Outcome |
| --- | --- |
| Field absent | Compatible internal download directory |
| Absolute safe PDF parent | Library-scoped external directory |
| Empty/null/non-string/relative parent | Configuration/path validation error |
| Traversal, malformed Windows/UNC root | `INVALID_LIBRARY_PATH` or configuration error |
| Destructive maintenance overlaps a protected PDF root | Refuse that target; preserve PDF bytes |
| Selected direction is incomplete | Fail loading and policy capture; never merge another direction's files |
| Archive directory differs from manifest identity | Refuse publication/rebuild |

## 5. Good / Base / Bad Cases

- Good: PDF and Vault have disjoint configured parent directories, each scoped by library ID.
- Base: an old three-root configuration still loads without a PDF setting.
- Bad: a caller silently replaces the configured PDF root with `work/downloads`, or treats external PDF originals as disposable staging.

## 6. Tests Required

Use isolated machine roots. Assert the real downloaded file path and bytes, missing-field compatibility, a second library's isolation, and invalid-root rejection. Maintenance tests must preserve original PDF bytes; mocked network responses may provide PDF bytes but must not replace the real storage boundary.

Exercise flat Archive installation through publication and rebuild, including interrupted replay. For split configuration, changing any selected file must change its operation policy hash without affecting another direction; missing or unknown fields fail closed.

## 7. Wrong vs Correct

Wrong: always compute downloads from `workRoot` at a downstream call site. Correct: consume the configured `pdfRoot`; preserve the compatibility fallback at the shared configuration boundary.

## Quality Check

### CLI direction selection

The public CLI has no implicit FSD selection. No-argument startup discovers `config/<libraryId>/library.yaml` and requires an explicit menu choice, even with one configured library. Blank/invalid input does not select; an empty list or EOF exits without creating state. Menu action `10` returns to the picker, and subsequent operations reload the selected direction's configuration and use its isolated paths. Direct direction commands require `--library`; help and internal process launcher/supervisor commands are direction-independent. Test both picker/task-menu EOF and actual operation admission across two configured libraries using isolated roots.

Run `bun run typecheck` and `bun test --timeout 30000` with `FSD_TEST_ROOT` under an isolated writable directory. Verify configuration loading creates no real database/Vault/PDF directory. Historical migration source constants remain unchanged when current destinations change.
