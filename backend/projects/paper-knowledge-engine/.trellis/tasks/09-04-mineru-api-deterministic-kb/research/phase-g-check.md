# Phase G Check — real-machine acceptance

Date: 2026-09-04

## G1 — completed

Final command:

```powershell
$env:FSD_MINERU_SMOKE='1'
bun test tests/mineru-session-smoke.test.ts --timeout 600000
```

Final result: 1 pass, 0 fail, 102839 ms test time (102.94 s suite time).

The opt-in test used one operation-scoped FastAPI process for two sequential real MinerU requests and asserted:

- exactly one API launch;
- exactly one `DocAnalysis init done!` model initialization;
- `Batch Ratio: 1`;
- both output directories contained normalized Markdown, content list, page text and pages JSON;
- API and client process records were removed only after confirmed cleanup;
- port 17860 was released.

An additional post-run inspection found no production/test `active.json` involved in the run, no listener on port 17860, and no MinerU Python/Bun process.

## Windows supervision defects found and closed during G1

The first real smoke exposed a root/descendant supervision hang. Regression tests and independent review then found and closed these issues before the final acceptance:

- Win32 `HANDLE`/`BOOL` FFI ABI types and x64 `PROCESSENTRY32W` parent PID offset;
- `Bun.spawn()` to `AssignProcessToJobObject()` race, replaced by a pure-Bun handshake launcher that cannot create the target before Job assignment;
- bounded root-exit, output-drain, stream-cancel and `taskkill` waits;
- named Job membership checks during durable-record recovery;
- checked, retried and retained failed `CloseHandle` state.

Final automated gate after these changes: 593 pass, 4 explicit skips, 0 fail; typecheck passed. Independent reviewer `01a068b7-49a2-7b32-9eb3-a407c23546c5` reported no remaining findings after the final P2 closure.

## G2 — completed after resumable recovery

The bounded production run used window `2026-09-02`, limit 1 and run ID `f06d383c-d723-48e5-a048-2d3abe62069e`. It stopped in discovery before PDF/MinerU because every arXiv request was reset at the socket layer. OpenCLI exhausted six configured attempts over 3:16 and preserved the run as resumable.

Direct Bun fetch and system curl probes to both `https://arxiv.org/api/query` and `https://export.arxiv.org/api/query`, including an ordinary arXiv page, were also reset. At that point no Archive or Obsidian publication was claimed.

The original attempt above was later superseded by the recovered fixed run `0f6fdade-2026-4fe4-b9d2-7b03cad0c635`. Its OpenCLI discovery, PDF download and ten MinerU Archives completed before Evidence publication exposed a bootstrap/publisher ownership conflict.

The final bounded repair and acceptance established:

- a fresh bootstrap writes the canonical empty `01-Evidence/index.md` instead of the Vault navigation template;
- the publisher transactionally migrates only the exact three known legacy template hashes and still rejects any byte-modified file;
- the explicit recovery route accepts a failed run only after `readVerifiedRunSources` validates its complete frozen Archive set;
- the local CLI retains a bounded safe `EVIDENCE_CONFLICT` reason while rejecting unsafe exception detail;
- publication `evidence-6ec4d499212c4a6a68a3d1073d514acd` completed with 10 receipt sources and 185 Vault assets;
- all ten paper directories contain `index.md`, `document.md`, `pages.md`, `pages.json`, `content_list.json`, and `manifest.json`;
- the receipt hash matches SQLite, the publication journal is absent after completion, and a second identical command returns `replayed: true`.

Final automated evidence: focused tests 96/96, full suite 619 pass / 4 gated skip / 0 fail, and `tsc --noEmit` passed.
