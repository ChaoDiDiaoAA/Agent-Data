# Paper Knowledge Engine test suite

Run the full deterministic suite with:

```bun
bun test --timeout 30000
bun run typecheck
```

The Evidence tests cover Archive verification, pure paper/index rendering,
atomic publication and receipt recovery. Pipeline and local-import tests cover
the no-LLM path from PDF/MinerU output through Archive v2 and `Evidence/papers/`.
All tests use isolated temporary roots and must not modify the production PDF
library, Archive, SQLite state, Vault, or `.obsidian`.

FSD, Agent Engineering, Multi-Agent Engineering, and LLM Post-Training use the shared paper
workflow. Run their focused direction regression checks from the project root:

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts tests/research-fsd-isolation.test.ts tests/research-cli.test.ts
```

The Multi-Agent contract covers the four configuration files, 18 Tracks,
36 harvest shards, Current 180 / Weekly 18 limits, isolated roots, and paper
command routing. Policy regressions accept a Multi-Agent delegation paper
and reject both single-Agent tooling and ordinary shared-memory parallel
programs, even when the candidate carries an enabled Track. The shared tests
also cover menu behavior, MinerU session ownership, checkpoint support, and
resolved network configuration propagation.

The LLM Post-Training contract covers display name and stable ID, 18 Tracks and
36 submitted/updated shards, Current 180 with initial per-Track allocation 10,
Weekly 18, policy decisions, paper command routing, and four-library path/state
isolation. The shared selector may spill unused per-Track allocation to other
eligible tracks; the value 10 is not a hard category cap. These tests use
fixture-owned roots and do not create production runs, watermarks, PDFs, or Vault files.

Run the opt-in real MinerU double-request smoke on the configured GPU machine:

```powershell
$env:FSD_MINERU_SMOKE='1'
bun test tests/mineru-session-smoke.test.ts --timeout 600000
Remove-Item Env:FSD_MINERU_SMOKE
```

The smoke reads one existing PDF without modifying it, uses test-owned output
and process-safety roots, requires one fixed API and one model initialization
for two requests, and verifies cleanup plus port release. Set
`FSD_MINERU_SMOKE_PDF` to select a specific PDF when needed.

The maintenance suites additionally prove that historical migration and legacy
Vault cleanup are read-only until their reviewed SHA-256 plus explicit apply
gate are supplied. Run the command-line documentation/behavior checks from the
project root; test fixtures must never substitute a production Vault.
