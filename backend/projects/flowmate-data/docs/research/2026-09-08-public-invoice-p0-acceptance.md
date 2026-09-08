# Public invoice P0 acceptance record

Date: 2026-09-08  
Branch: `codex/public-invoice-workbench`

## Automated evidence

- Flowmate focused suites cover catalog, Release, backup, and the local projection e2e chain.
- The e2e chain uses local fixtures and no network or GPU: record → catalog → portable Release → backup → independent restore.
- Release verification checks the portable manifest and SHA-256 file list after copying the Release directory.
- Backup verification checks the manifest, refuses a held Flowmate run lock, restores user notes, and excludes generated catalog cards.
- Restore verification compares the independent destination tree against the backup manifest, reapplies the current `dataRoot/policies/withdrawals.json`, verifies sample structured snapshots, and rebuilds generated cards in the restored Vault. Withdrawn samples are excluded from new Releases.
- Shared-engine typecheck and regression commands are run separately; unrelated shared-engine work is never modified by this task.

## Live checks pending explicit data run

`config/paths.local.json` is present and its configured roots resolve, but this implementation turn did not start public-data acquisition, real MinerU, or a production backup/restore run. The following acceptance items remain machine checks and are intentionally not faked here:

- acquisition of all 20 fixed Voxel51 records and their original/annotation pairs;
- at least one real Voxel51 JPG/PNG MinerU result;
- `bun src/cli.ts verify --selection initial-20 --release public-invoice-p0-v1 --paths config/paths.local.json`;
- Release redistribution decision for the public source;
- backup create/verify/restore smoke against the configured roots.

Run those commands only after the local paths and public network access are configured. Do not put credentials, signed query strings, or full personal data in this record.
