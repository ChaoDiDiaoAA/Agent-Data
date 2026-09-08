# FSD runtime boundaries

`sqlite.ts` is the Bun 1.4.0 SQLite boundary for the formal FSD runtime. The
state store keeps strict bindings, safe integer handling, idempotent close and
read-only backup rules described by its tests.

`process.ts` is the direct Bun process boundary. `createProcessContext(projectRoot)`
reloads `runtime.yaml` and the selected project paths without creating locks.
`runManagedProcess` accepts one absolute executable, its argument vector, an
isolated cwd/environment, optional UTF-8 stdin, a finite business timeout and
the configured output limit.

Each launch first claims `stateRoot/locks/processes/active.json` with an
exclusive fsync-backed record. The record stores only executable identity,
owner PID, child PID and child start identity. Windows start identity comes
from the kernel process creation timestamp through Bun FFI. Windows cleanup
uses a direct process-tree termination operation and verifies that the root
PID is gone. Unknown cleanup retains the record and blocks the next launch.

Output is streamed with independent byte caps for stdout and stderr. Timeout,
cancellation and output overflow terminate the owned process. Successful
cleanup emits a terminal lifecycle event and removes the record; uncertain
cleanup remains fail-closed.

`process-supervisor.ts` is a Bun-only recovery utility for one exact record:

```bun
bun src/runtime/process-supervisor.ts --inspect <state_root>/locks/processes/active.json
bun src/runtime/process-supervisor.ts --resolve <state_root>/locks/processes/active.json
```

`opencli.ts` keeps the isolated adapter lease and ownership rules. The runner
uses the exact local OpenCLI dependency, child-only environment overrides and
the same durable process gate as MinerU. arXiv discovery uses Bun fetch with
AbortSignal request timeouts and deterministic retry handling.
