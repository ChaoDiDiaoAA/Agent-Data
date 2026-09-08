# arXiv adapter sources and generated installation

Maintain `harvest.ts` and `retry.ts`; generated JavaScript is ignored data, never source. Run `bun run opencli:prepare` from the isolated FSD project. The build resolves only this project's exact OpenCLI 1.8.6 dependency using its package.json context and validates the actual exported main/bin metadata without importing the CLI. Missing local dependencies never fall back to ancestors or global packages.

`temp_root/opencli-home/.opencli/clis/arxiv/` contains `harvest.js`, `retry.js` and `manifest.json`. The manifest records project/home/adapter/entry paths, the exact package version, SHA-256 of both sources plus the build script, output hashes, and an installation fingerprint including Bun version and bun.lock bytes. Missing or partial output, changed source/build/lock/runtime/package, and altered JS fail closed until prepare succeeds. It contains no credentials. The managed package junction and ownership record live in the same isolated `.opencli`, pointing only to the resolved project dependency so both the CLI and adapter share one registry.

Prepare and `withOpenCliRuntime` share the exclusive durable `.lease.json` at `opencli-home`. The runner holds it from validation through the supervised child's terminal result. Prepare refuses while a runtime is in use; it also checks the durable project process gate. Random staging is built and hashed before the old owned adapter is renamed aside and the new directory switched into place. Only known owned files are removed, without recursive dependency cleanup. Unknown paths, links, adapter directories, and reparse ancestors are refused.

An interrupted/partial lease is deliberately **not** reclaimed using PID alone. Stop writers and inspect the lease, any staging/previous directories, and `state_root/locks/processes/` with the process recovery instructions before manually resolving an interruption. Never delete an unconfirmed process record merely to allow prepare. Cleanup uncertainty blocks both the next harvest and prepare even after a normally released profile lease. Unrecognized output is retained for inspection.

The runner uses Bun + the validated package entry, a null overall business deadline, and the configured per-request/retry timing. Requests use Bun's native fetch with an AbortSignal timeout. The default is the canonical `https://export.arxiv.org/api/query` endpoint; the parent may select the validated `https://arxiv.org/api/query` endpoint with `--api-base`, avoiding an implicit redirect chain. stdout remains JSON; structured retry and transport progress goes to stderr. `FSD_ARXIV_API_BASE` is retained for loopback tests only; tests never retrieve real papers.

Non-2xx responses retain at most 256 bytes of sanitized response text plus only `Retry-After`, `Server`, `Via`, `X-Cache`, and `X-Served-By`. A `429` whose body contains `Rate exceeded` is treated as arXiv system-capacity pressure, not an ordinary short rate-limit retry: OpenCLI emits one `discovery-deferred` event and exits without spending the remaining retry attempts. The Bun task persists `retry_not_before` with the failed shard. Re-running the same current/weekly task before that instant fails fast with `ARXIV_COOLDOWN_ACTIVE` and sends no arXiv request; after it expires, completed shards stay skipped and discovery resumes from the failed shard. The cooldown is configured by `arxiv.capacity_cooldown_seconds` in `config/pipeline.yaml` and is 900 seconds in production.

Resume with the same normal command; no separate network adapter is used:

```powershell
bun src/cli.ts run-task --mode current
```

`tests/opencli-installation.test.ts` exercises real discovery against `127.0.0.1`, paging, 429/Retry-After, scan-budget exhaustion, invalid Atom, byte budgets, hashes, shared leases and durable cleanup refusal. This is candidate validation; it does not authorize the formal runtime switch.
