# LLM Post-Training Knowledge Library — Design

## Boundary

The new direction is a paper-only configuration of the existing engine. It owns its direction configuration, SQLite state, run/checkpoint records, PDF root, Archive, Evidence Vault, and publication receipts. Shared code remains the owner of OpenCLI/arXiv discovery, selection, PDF verification, MinerU, Archive v2, Evidence v3, recovery, and CLI routing.

## Data flow

```text
llm-post-training YAML
  → OpenCLI/arXiv submitted + updated shards
  → deterministic title/abstract policy
  → frozen selection manifest
  → verified PDF
  → MinerU task session
  → Archive v2
  → Evidence v3
```

The four active YAML files are the only direction-specific production inputs. Track IDs and PDF category mappings are copied from the approved design. A paper may match multiple Tracks; the shared selector assigns a primary Track and counts each unique paper once.

## Policy boundary

`ai_technique_terms` identify language-model objects. `engineering_task_terms` identify post-training signals and methods. `program_structure_terms` remains empty. Source identity, date, version, and enabled-track checks remain shared gates. Candidate review records are human evidence and are not written into the production paper schema.

## Compatibility and operations

`weekly_schedule.enabled` remains true so the manual `weekly` command works. The first release does not call the Windows/Codex scheduler installer. Historical papers are manually imported from real PDFs and retain their arXiv/source mapping in the human candidate ledger; their `local-*` database identity is not rewritten.

## Rollback

Configuration-only failures are reverted within the new direction directory. A failed discovery or parse keeps its run/checkpoint for same-run recovery. Evidence is replayed by run ID from verified Archive. No broad repository rollback or deletion of another library's state is allowed.
