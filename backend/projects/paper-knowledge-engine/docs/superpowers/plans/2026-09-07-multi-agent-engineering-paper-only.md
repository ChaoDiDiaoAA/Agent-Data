# Multi-Agent Engineering Paper-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `multi-agent-engineering` as an isolated 18-Track paper library whose automatic acquisition uses only arXiv and whose runtime behavior reuses the existing FSD/Agent paper workflow.

**Architecture:** Express the new direction entirely through the existing `PaperLibraryConfig` seam and the four paper YAML files. The shared path remains `buildHarvestPlan` → `runHarvestShards` → paper selection → `downloadAcceptedPdf` → MinerU → Archive v2 → Evidence v3; no Multi-Agent-specific runtime module, Research adapter, downloader, parser, publisher, or indexer is added.

**Tech Stack:** Bun 1.4, TypeScript 7, YAML layered configuration, OpenCLI arXiv harvest, SQLite state, MinerU API, Archive v2, Evidence v3.

**Spec:** `docs/superpowers/specs/2026-09-06-multi-agent-engineering-design.md`

## Global Constraints

- `multi-agent-engineering` must load as `library_kind: paper`.
- Automatic external acquisition must use only OpenCLI/arXiv; do not add official-document, specification, repository, Release, blog, or web discovery.
- Keep the shared manual `import-local`/`parse-local` PDF entry points; manual imports must not advance arXiv watermarks.
- The active direction config must contain exactly `library.yaml`, `query-matrix.yaml`, `paper-policy.yaml`, and `categories.yaml`.
- Use the 18 Track IDs and PDF directories fixed in the spec.
- Initial limits are `start_date: 2026-01-01`, `overlap_hours: 48`, Current 180 papers with 10 per Track, and Weekly 18 papers.
- Reuse the existing paper execution path and paper menu; do not route this library through `src/research/`.
- Do not hard-code `multi-agent-engineering` in production TypeScript. Library discovery, routing, paths, and task behavior must continue to derive from `libraryId` and `library.kind`.
- FSD, Agent Engineering, and Multi-Agent Engineering must not share SQLite, watermarks, locks, operations, work directories, PDF roots, Archive, Vault, or Evidence.
- Evidence must remain the shared v3 paper projection with authors/categories/tracks/years indexes. The publisher must not create or overwrite `Knowledge/`.
- Preserve all unrelated dirty-worktree changes. Do not reset, checkout, clean, or overwrite files outside this plan.
- Commit steps below are allowed only in an isolated execution worktree or after the user explicitly authorizes staging the already-dirty target files. In the current dirty checkout, run the verification but leave changes uncommitted.

---

### Task 1: Add the Paper-Library Contract and Direction Configuration

**Files:**
- Create: `tests/multi-agent-paper-library.test.ts`
- Create: `config/multi-agent-engineering/library.yaml`
- Create: `config/multi-agent-engineering/query-matrix.yaml`
- Create: `config/multi-agent-engineering/paper-policy.yaml`
- Create: `config/multi-agent-engineering/categories.yaml`

**Interfaces:**
- Consumes: `loadEngineContext(options): EngineContext`, `listLibraries(root)`, `configurationFiles(libraryId, kind)`, `routeHarvestPlan(args, context)`, `routeScheduleConfig(args, context)`, `normalizeCliOperation(command, args, libraryId, libraryKind)`, and `evaluateCandidate(paper, policy)`.
- Produces: a valid `PaperLibraryConfig` for `multi-agent-engineering`, 18 Track definitions, 36 submitted/updated harvest shards, paper-only CLI behavior, and independently derived storage roots.

- [x] **Step 1: Write the failing direction-contract test.**

Create `tests/multi-agent-paper-library.test.ts` with these assertions:

```ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeCliOperation, routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { configurationFiles } from '../src/shared/config-files.ts';
import { listLibraries, loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
const libraryId = asLibraryId('multi-agent-engineering');
const trackIds = [
  'mas-foundations', 'mas-topology', 'mas-roles-capabilities', 'mas-lifecycle-composition',
  'mas-task-decomposition', 'mas-delegation-handoff', 'mas-planning-scheduling',
  'mas-communication', 'mas-shared-state-memory', 'mas-coordination-consensus',
  'mas-conflict-negotiation', 'mas-synthesis-verification', 'mas-security-governance',
  'mas-fault-tolerance', 'mas-resource-governance', 'mas-observability',
  'mas-human-oversight', 'mas-evaluation-methodology',
];

test('loads Multi-Agent Engineering through the four-file paper contract', () => {
  const context = loadEngineContext({ root, libraryId });
  if (context.library.kind !== 'paper') throw new Error('expected Multi-Agent paper library');
  assert.equal(context.library.libraryId, libraryId);
  assert.equal(context.library.displayName, 'Multi-Agent Engineering（Multi-Agent 工程知识库）');
  assert.equal(context.library.startDate, '2026-01-01');
  assert.equal(context.library.currentTask.maxPapers, 180);
  assert.deepEqual(Object.keys(context.library.currentTask.trackLimits), trackIds);
  assert.ok(Object.values(context.library.currentTask.trackLimits).every(limit => limit === 10));
  assert.equal(context.library.weeklySchedule.maxPapers, 18);
  assert.equal(context.library.overlapHours, 48);
  assert.equal(context.library.downloadAfterHardFilter, true);
  assert.deepEqual(context.library.tracks.map(track => track.id), trackIds);
  assert.ok(context.library.tracks.every(track =>
    track.dateModes.length === 2
    && track.dateModes.includes('submitted')
    && track.dateModes.includes('updated')));
  assert.deepEqual(context.library.paperPolicy.trackPriority, trackIds);
  assert.deepEqual(Object.keys(context.library.categories.tracks), trackIds);
  assert.equal(context.library.categories.fallbackPdf, '99-Unclassified');
  assert.ok(listLibraries(root).some(library => library.libraryId === libraryId));
  assert.deepEqual(configurationFiles(libraryId, 'paper').slice(-4), [
    join(libraryId, 'library.yaml'), join(libraryId, 'query-matrix.yaml'),
    join(libraryId, 'paper-policy.yaml'), join(libraryId, 'categories.yaml'),
  ]);
  for (const forbidden of ['source-policy.yaml', 'topic-taxonomy.yaml', 'synthesis-policy.yaml']) {
    assert.equal(existsSync(join(root, 'config', libraryId, forbidden)), false);
  }
});

test('exposes paper schedule, 36 arXiv shards, and no Research backfill', () => {
  const context = loadEngineContext({ root, libraryId });
  const plan = routeHarvestPlan(['--mode', 'current', '--format', 'json'], { root, libraryId });
  assert.deepEqual(plan, {
    trackCount: 18,
    totalShards: 36,
    submittedShards: 18,
    updatedShards: 18,
    maximumCandidateObservations: plan.maximumCandidateObservations,
    maxPapers: 180,
  });
  const schedule = routeScheduleConfig(['--format', 'json'], { root, libraryId });
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.taskName, 'paper-knowledge-engine-multi-agent-engineering-weekly');
  assert.equal(schedule.dayOfWeek, 'Monday');
  assert.equal(schedule.intervalWeeks, 4);
  assert.equal(schedule.startDate, '2026-08-31');
  assert.equal(schedule.localTime, '22:30');
  assert.equal(schedule.timezone, 'Asia/Shanghai');
  assert.equal(schedule.maxPapers, 18);
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);
  assert.throws(
    () => normalizeCliOperation(
      'run-task',
      ['--mode', 'backfill', '--from', '2026-01-01', '--to', '2026-09-07'],
      libraryId,
      context.library.kind,
    ),
    /UNSUPPORTED_LIBRARY_KIND/,
  );
});

test('accepts a Multi-Agent paper using the shared paper policy', () => {
  const context = loadEngineContext({ root, libraryId });
  if (context.library.kind !== 'paper') throw new Error('expected Multi-Agent paper library');
  const decision = evaluateCandidate({
    baseId: '2609.00001',
    arxivId: '2609.00001v1',
    version: 1,
    title: 'Multi-Agent Task Delegation with Fault-Tolerant Coordination',
    summary: 'A multi-agent system for collaborative planning, delegation, and recovery.',
    authors: ['Fixture Author'],
    categories: ['cs.MA'],
    published: '2026-09-01T00:00:00Z',
    updated: '2026-09-01T00:00:00Z',
    matchedTracks: ['mas-delegation-handoff'],
  }, context.library.paperPolicy);
  assert.equal(decision.accepted, true);
  assert.equal(decision.primaryTrack, 'mas-delegation-handoff');
});

test('derives Multi-Agent roots independently from FSD and Agent Engineering', () => {
  const multi = loadEngineContext({ root, libraryId });
  const fsd = loadEngineContext({ root, libraryId: 'fsd' });
  const agent = loadEngineContext({ root, libraryId: 'agent-engineering' });
  const keys = [
    'dataRoot', 'databasePath', 'archiveRoot', 'runsRoot', 'operationsRoot',
    'workRoot', 'backupRoot', 'pdfRoot', 'vaultRoot',
  ] as const;
  for (const key of keys) {
    assert.match(multi.paths[key]!, /multi-agent-engineering/i);
    assert.notEqual(multi.paths[key], fsd.paths[key]);
    assert.notEqual(multi.paths[key], agent.paths[key]);
  }
});
```

- [x] **Step 2: Run the new test and verify the missing-library failure.**

Run:

```powershell
bun test --timeout 30000 tests/multi-agent-paper-library.test.ts
```

Expected: FAIL with `UNKNOWN_LIBRARY: multi-agent-engineering` before configuration is added. Do not change production TypeScript to satisfy this failure.

- [x] **Step 3: Create the library and scheduling configuration.**

Create `config/multi-agent-engineering/library.yaml`:

```yaml
library_kind: paper
library_id: multi-agent-engineering
display_name: Multi-Agent Engineering（Multi-Agent 工程知识库）
start_date: 2026-01-01
overlap_hours: 48
download_after_hard_filter: true
current_task:
  max_papers: 180
  track_limits:
    mas-foundations: 10
    mas-topology: 10
    mas-roles-capabilities: 10
    mas-lifecycle-composition: 10
    mas-task-decomposition: 10
    mas-delegation-handoff: 10
    mas-planning-scheduling: 10
    mas-communication: 10
    mas-shared-state-memory: 10
    mas-coordination-consensus: 10
    mas-conflict-negotiation: 10
    mas-synthesis-verification: 10
    mas-security-governance: 10
    mas-fault-tolerance: 10
    mas-resource-governance: 10
    mas-observability: 10
    mas-human-oversight: 10
    mas-evaluation-methodology: 10
weekly_schedule:
  enabled: true
  task_name: paper-knowledge-engine-multi-agent-engineering-weekly
  day_of_week: monday
  interval_weeks: 4
  start_date: 2026-08-31
  local_time: '22:30'
  timezone: Asia/Shanghai
  max_papers: 18
```

- [x] **Step 4: Create the 18-Track arXiv query matrix.**

Create `config/multi-agent-engineering/query-matrix.yaml`:

```yaml
tracks:
  - id: mas-foundations
    query: multi-agent systems foundations architecture organization
    categories: [cs.MA, cs.AI, cs.CL]
    date_modes: [submitted, updated]
  - id: mas-topology
    query: multi-agent topology hierarchy supervisor worker swarm graph blackboard
    categories: [cs.MA, cs.AI]
    date_modes: [submitted, updated]
  - id: mas-roles-capabilities
    query: multi-agent roles capabilities specialization discovery allocation
    categories: [cs.MA, cs.AI]
    date_modes: [submitted, updated]
  - id: mas-lifecycle-composition
    query: multi-agent lifecycle dynamic creation composition team formation
    categories: [cs.MA, cs.AI, cs.SE]
    date_modes: [submitted, updated]
  - id: mas-task-decomposition
    query: multi-agent task decomposition assignment routing dependency
    categories: [cs.MA, cs.AI]
    date_modes: [submitted, updated]
  - id: mas-delegation-handoff
    query: multi-agent delegation handoff task contract cancellation failure
    categories: [cs.MA, cs.AI, cs.CL]
    date_modes: [submitted, updated]
  - id: mas-planning-scheduling
    query: multi-agent collaborative planning scheduling parallel execution
    categories: [cs.MA, cs.AI, cs.RO]
    date_modes: [submitted, updated]
  - id: mas-communication
    query: multi-agent communication messaging protocol channel asynchronous
    categories: [cs.MA, cs.AI, cs.CL]
    date_modes: [submitted, updated]
  - id: mas-shared-state-memory
    query: multi-agent shared state memory consistency ownership isolation
    categories: [cs.MA, cs.AI, cs.DC]
    date_modes: [submitted, updated]
  - id: mas-coordination-consensus
    query: multi-agent coordination consensus synchronization voting locking
    categories: [cs.MA, cs.AI, cs.DC, cs.GT]
    date_modes: [submitted, updated]
  - id: mas-conflict-negotiation
    query: multi-agent conflict negotiation debate competition incentives alignment
    categories: [cs.MA, cs.GT, cs.AI]
    date_modes: [submitted, updated]
  - id: mas-synthesis-verification
    query: multi-agent synthesis verification critic reviewer aggregation adjudication
    categories: [cs.MA, cs.AI, cs.CL]
    date_modes: [submitted, updated]
  - id: mas-security-governance
    query: multi-agent security trust permission isolation prompt injection governance
    categories: [cs.MA, cs.CR, cs.AI]
    date_modes: [submitted, updated]
  - id: mas-fault-tolerance
    query: multi-agent fault tolerance retry timeout partial failure recovery
    categories: [cs.MA, cs.DC, cs.SE]
    date_modes: [submitted, updated]
  - id: mas-resource-governance
    query: multi-agent resource allocation token budget cost concurrency fairness
    categories: [cs.MA, cs.DC, cs.SE]
    date_modes: [submitted, updated]
  - id: mas-observability
    query: multi-agent observability tracing causal debugging replay audit
    categories: [cs.MA, cs.SE]
    date_modes: [submitted, updated]
  - id: mas-human-oversight
    query: multi-agent human oversight approval intervention takeover adjudication
    categories: [cs.MA, cs.HC, cs.AI]
    date_modes: [submitted, updated]
  - id: mas-evaluation-methodology
    query: multi-agent evaluation methodology collaboration communication cost reliability
    categories: [cs.MA, cs.AI, cs.CL]
    date_modes: [submitted, updated]
```

- [x] **Step 5: Create the shared-paper filtering policy.**

Create `config/multi-agent-engineering/paper-policy.yaml`:

```yaml
start_date: 2026-01-01
excluded_domains: []
ai_technique_terms:
  - multi-agent
  - multi agent
  - multiagent
  - multiple agents
  - agent team
  - agent society
  - collaborative agents
  - cooperating agents
  - interacting agents
  - communicating agents
  - llm agents
  - language model agents
  - agent-to-agent
  - agent swarm
  - multi-agent topology
  - multi-agent graph
program_structure_terms: []
engineering_task_terms:
  - coordination
  - collaboration
  - task decomposition
  - task allocation
  - delegation
  - handoff
  - planning
  - scheduling
  - communication
  - consensus
  - negotiation
  - synthesis
  - verification
  - fault tolerance
  - recovery
  - resource allocation
  - observability
  - human oversight
  - evaluation
term_variants:
  multi-agent:
    - multi-agent systems
    - multi-agent system
  multi agent:
    - multi agent systems
    - multi agent system
  multiagent:
    - multiagent systems
    - multiagent system
  agent team:
    - agent teams
  agent society:
    - agent societies
  agent swarm:
    - agent swarms
  multi-agent topology:
    - multi-agent topologies
  multi-agent graph:
    - multi-agent graphs
  delegation:
    - delegate
    - delegated
  handoff:
    - handoffs
    - hand-off
  fault tolerance:
    - fault-tolerant
  human oversight:
    - human-in-the-loop
    - hitl
  evaluation:
    - evaluations
track_priority:
  - mas-foundations
  - mas-topology
  - mas-roles-capabilities
  - mas-lifecycle-composition
  - mas-task-decomposition
  - mas-delegation-handoff
  - mas-planning-scheduling
  - mas-communication
  - mas-shared-state-memory
  - mas-coordination-consensus
  - mas-conflict-negotiation
  - mas-synthesis-verification
  - mas-security-governance
  - mas-fault-tolerance
  - mas-resource-governance
  - mas-observability
  - mas-human-oversight
  - mas-evaluation-methodology
```

- [x] **Step 6: Create the PDF category mapping.**

Create `config/multi-agent-engineering/categories.yaml`:

```yaml
tracks:
  mas-foundations:
    pdf: 01-MAS-Foundations
  mas-topology:
    pdf: 02-MAS-Topology
  mas-roles-capabilities:
    pdf: 03-MAS-Roles-Capabilities
  mas-lifecycle-composition:
    pdf: 04-MAS-Lifecycle-Composition
  mas-task-decomposition:
    pdf: 05-MAS-Task-Decomposition
  mas-delegation-handoff:
    pdf: 06-MAS-Delegation-Handoff
  mas-planning-scheduling:
    pdf: 07-MAS-Planning-Scheduling
  mas-communication:
    pdf: 08-MAS-Communication
  mas-shared-state-memory:
    pdf: 09-MAS-Shared-State-Memory
  mas-coordination-consensus:
    pdf: 10-MAS-Coordination-Consensus
  mas-conflict-negotiation:
    pdf: 11-MAS-Conflict-Negotiation
  mas-synthesis-verification:
    pdf: 12-MAS-Synthesis-Verification
  mas-security-governance:
    pdf: 13-MAS-Security-Governance
  mas-fault-tolerance:
    pdf: 14-MAS-Fault-Tolerance
  mas-resource-governance:
    pdf: 15-MAS-Resource-Governance
  mas-observability:
    pdf: 16-MAS-Observability
  mas-human-oversight:
    pdf: 17-MAS-Human-Oversight
  mas-evaluation-methodology:
    pdf: 18-MAS-Evaluation-Methodology
fallback_pdf: 99-Unclassified
```

- [x] **Step 7: Run the focused contract test and verify green.**

Run:

```powershell
bun test --timeout 30000 tests/multi-agent-paper-library.test.ts
```

Expected: 4 tests pass. If loading the four files requires a production TypeScript change, stop and report the violated “configuration-only direction” assumption instead of adding a library-ID special case.

- [ ] **Step 8: Commit the isolated Task 1 change set when commits are authorized.**

```powershell
git add -- tests/multi-agent-paper-library.test.ts config/multi-agent-engineering
git diff --cached --check
git commit -m "feat: add multi-agent engineering paper library"
```

In the current dirty checkout, skip this commit and leave the verified files unstaged.

---

### Task 2: Prove Generic Discovery, Menu, MinerU, and Isolation Reuse

**Files:**
- Modify: `tests/research-library-config.test.ts`
- Modify: `tests/cli-menu.test.ts`
- Modify: `tests/configured-task-limits.test.ts`
- Test: `tests/multi-agent-paper-library.test.ts`

**Interfaces:**
- Consumes: generic `listLibraries`, `main`, `runInteractiveMenu`, `runConfiguredTask`, the injected `harvest(shards, window, options)` seam, and the task-level `mineruSession` ownership already used by Agent Engineering.
- Produces: regression evidence that the third direction is discovered automatically, shows the paper menu, owns a task-level MinerU session, supplies 36 shared harvest shards, and remains isolated without production routing changes.

- [x] **Step 1: Run the existing library-listing test after adding the new config.**

Run:

```powershell
bun test --timeout 30000 tests/research-library-config.test.ts
```

Expected: the exact library-list assertion fails because `multi-agent-engineering` is now discovered between `fsd` and `research-fixture`. Other failures must be investigated separately rather than hidden by changing broad expectations.

- [x] **Step 2: Update the exact library-list assertion.**

In `tests/research-library-config.test.ts`, change only the expected list in `keeps active files, library listing, paths, and Evidence policies isolated by library kind`:

```ts
assert.deepEqual(listLibraries(root).map(library => library.libraryId), [
  'agent-engineering', 'fsd', 'multi-agent-engineering', researchFixtureId,
]);
```

Add this adjacent assertion to bind the new direction to the paper four-file policy snapshot:

```ts
assert.deepEqual(configurationFiles('multi-agent-engineering', 'paper').slice(-4), [
  join('multi-agent-engineering', 'library.yaml'),
  join('multi-agent-engineering', 'query-matrix.yaml'),
  join('multi-agent-engineering', 'paper-policy.yaml'),
  join('multi-agent-engineering', 'categories.yaml'),
]);
```

- [x] **Step 3: Add a paper-menu regression test.**

In `tests/cli-menu.test.ts`, add immediately after the Agent paper-menu test:

```ts
test('Multi-Agent Engineering uses the same paper menu as FSD and Agent Engineering', async () => {
  const lines: string[] = [];
  await main(['--library', 'multi-agent-engineering'], {
    root: projectRoot,
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.equal(lines[1], '当前方向库：Multi-Agent Engineering（Multi-Agent 工程知识库）（multi-agent-engineering）');
  assert.deepEqual(lines.slice(3), [
    '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
    '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
    '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络',
    '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
  ]);
});
```

- [x] **Step 4: Add a shared harvest/checkpoint regression test.**

In `tests/configured-task-limits.test.ts`, add after `Agent Engineering uses the shared paper harvest and checkpoint seam`:

```ts
test('Multi-Agent Engineering uses the shared paper harvest and checkpoint seam', async () => {
  let observedShards = 0;
  let observedCheckpoint = false;
  const result = await runConfiguredTask(['--mode', 'current', '--limit', '0'], process.cwd(), {
    libraryId: 'multi-agent-engineering' as never,
    openStateStore: () => openStateStore(':memory:'),
    bootstrap: async () => {},
    harvest: async (shards, _window, options) => {
      observedShards = shards.length;
      observedCheckpoint = typeof options.checkpoint.start === 'function';
      assert.equal(options.network?.openCliProxyMode, 'direct');
      return [];
    },
    executeTask: async (options, dependencies) => {
      const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' };
      const run = dependencies.store.startRun(window, options.mode);
      await dependencies.discovery.harvest({ window, run });
      return {
        status: 'completed', mode: options.mode, runId: run.id,
        window, selected: [], paperCount: 0,
      };
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(observedShards, 36);
  assert.equal(observedCheckpoint, true);
});
```

- [x] **Step 5: Add a task-level MinerU ownership regression test.**

In `tests/cli-menu.test.ts`, duplicate the structure of the existing Agent MinerU boundary test but use these exact Multi-Agent-specific values:

```ts
test('Multi-Agent Engineering paper tasks create the shared MinerU session boundary', () => fixture(async stateRoot => {
  const prompts: string[] = [];
  const trackers: ReturnType<typeof createSessionTracker>[] = [];
  let observedSession = false;

  await main(['--library', 'multi-agent-engineering'], {
    root: projectRoot,
    dataRoot: stateRoot,
    operationsRoot: join(stateRoot, 'operations'),
    interactive: true,
    output: () => {},
    readLine: async (prompt: string) => {
      prompts.push(prompt);
      const menuChoices = prompts.filter(value => value === '请选择操作').length;
      if (prompt === '请选择操作') return ['2', '0'][menuChoices - 1] ?? '0';
      throw new Error(`unexpected prompt: ${prompt}`);
    },
    writeLine: () => {},
    createMineruSession: () => {
      const tracker = createSessionTracker();
      trackers.push(tracker);
      return tracker.session;
    },
    execute: async (input: { root: string; jobId: string }, dependencies: any) => executeOperation(input, {
      ...dependencies,
      runTask: async (_operation: unknown, workflowContext: any) => {
        observedSession = Boolean(workflowContext.mineruSession);
        await workflowContext.mineruSession?.ensureReady();
        return { status: 'completed', runId: 'multi-agent-paper-run' };
      },
    }),
  } as any);

  assert.equal(trackers.length, 1);
  assert.equal(observedSession, true);
  assert.deepEqual(trackers[0]!.history, ['ensureReady', 'dispose']);
}));
```

- [x] **Step 6: Run the focused reuse and isolation tests.**

Run:

```powershell
bun test --timeout 30000 tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts tests/research-fsd-isolation.test.ts tests/research-cli.test.ts
```

Expected: all focused tests pass. `src/cli/menu.ts`, `src/cli/routes.ts`, `src/library/execution.ts`, and `src/library/workflow.ts` require no Multi-Agent-specific change because all behavior is selected by `library.kind` and `libraryId`.

- [x] **Step 7: Verify no production TypeScript hard-codes the new library.**

Run:

```powershell
$matches = rg -n --glob '*.ts' "multi-agent-engineering" src
if ($LASTEXITCODE -eq 0) { $matches; throw 'Production TypeScript must not hard-code multi-agent-engineering' }
if ($LASTEXITCODE -ne 1) { throw 'rg failed while checking production TypeScript' }
```

Expected: no matches and the command completes successfully.

- [ ] **Step 8: Commit the isolated Task 2 change set when commits are authorized.**

```powershell
git add -- tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts
git diff --cached --check
git commit -m "test: verify multi-agent paper workflow reuse"
```

In the current dirty checkout, skip this commit and leave the verified files unstaged.

---

### Task 3: Document the Third Paper Direction and Remove Stale Multi-Source Claims

**Files:**
- Modify: `README.md`
- Modify: `config/README.md`
- Modify: `CONTEXT.md`
- Modify: `src/README.md`
- Verify: `docs/superpowers/specs/2026-09-06-multi-agent-engineering-design.md`

**Interfaces:**
- Consumes: the final four-file configuration, 18 Track IDs, command behavior, and isolated roots from Tasks 1–2.
- Produces: operator-facing documentation that identifies three paper directions and states that both Agent directions are arXiv-only for automatic acquisition.

- [x] **Step 1: Update the root README overview and library picker.**

Replace the opening direction description with:

~~~~markdown
论文知识引擎是基于 Bun 1.4 / TypeScript 的确定性资料库工具，当前包含三个互不共享状态的 paper 方向库：**FSD（fsd）**、**Agent Engineering（agent-engineering）** 和 **Multi-Agent Engineering（multi-agent-engineering）**。

```text
FSD：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Agent Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
Multi-Agent Engineering：OpenCLI / arXiv → 规则筛选 → PDF 下载 → 本地 MinerU → Archive v2 → Evidence v3
```
~~~~

Update the picker example to the actual alphabetical `listLibraries` order:

```text
1. Agent Engineering（Agent 工程知识库）（agent-engineering）
2. FSD 论文知识库（fsd）
3. Multi-Agent Engineering（Multi-Agent 工程知识库）（multi-agent-engineering）
0. 退出
```

- [x] **Step 2: Add the Multi-Agent command and configuration examples.**

Add this command block beside the Agent block:

```powershell
bun src/cli.ts --library multi-agent-engineering harvest-plan --mode current --format json
bun src/cli.ts --library multi-agent-engineering mineru-config --format json
bun src/cli.ts --library multi-agent-engineering arxiv-check --format json
bun src/cli.ts --library multi-agent-engineering schedule-config --format json
bun src/cli.ts --library multi-agent-engineering run-task --mode current
bun src/cli.ts --library multi-agent-engineering run-task --mode weekly
bun src/cli.ts --library multi-agent-engineering import-local --path D:\papers\multi-agent
bun src/cli.ts --library multi-agent-engineering parse-local --base-id BASE_ID
bun src/cli.ts --library multi-agent-engineering evidence-publish --run-id RUN_ID
bun src/cli.ts --library multi-agent-engineering reconcile
```

Extend the configuration tree with `config/multi-agent-engineering/` and its four paper files. Add an 18-row Track table in this order:

```text
mas-foundations
mas-topology
mas-roles-capabilities
mas-lifecycle-composition
mas-task-decomposition
mas-delegation-handoff
mas-planning-scheduling
mas-communication
mas-shared-state-memory
mas-coordination-consensus
mas-conflict-negotiation
mas-synthesis-verification
mas-security-governance
mas-fault-tolerance
mas-resource-governance
mas-observability
mas-human-oversight
mas-evaluation-methodology
```

Use the research-scope wording from the corresponding Track rows in the spec. State that automatic acquisition is arXiv-only and that explicit local PDF import is the only non-arXiv ingestion path.

- [x] **Step 3: Add Multi-Agent data roots and Evidence layout to the root README.**

Add these rows to the data-location table:

```markdown
| `D:/agent-data/data/paper-libraries/multi-agent-engineering` | Multi-Agent Engineering 的 SQLite、Archive、runs、operations 和 work |
| `D:/agent-data/backups/paper-libraries/multi-agent-engineering` | Multi-Agent Engineering 的备份目标根 |
| `D:/paper/paper-knowledge-engine/multi-agent-engineering` | Multi-Agent Engineering 的 arXiv PDF 和手工导入 PDF |
| `D:/obsidian/data/paper-knowledge-engine/multi-agent-engineering` | Multi-Agent Engineering Vault；publisher 只拥有 `Evidence/` |
```

State that its Evidence layout is the same `Evidence/papers/<baseId>-v<version>/` plus authors/categories/tracks/years indexes used by FSD and Agent.

- [x] **Step 4: Update `config/README.md` with the exact paper-only contract.**

Add a `### Multi-Agent Engineering 方向库` section containing:

- `library_kind: paper` and the same four-file contract as FSD/Agent.
- `start_date: 2026-01-01`, Current 180, 10 per Track, Weekly 18, overlap 48 hours.
- 18 Track IDs and 36 submitted/updated shards.
- Automatic discovery only through OpenCLI/arXiv.
- Manual `import-local`/`parse-local` remains available and does not affect arXiv watermarks or automatic candidate counts.
- Research `source-config`, `import-source`, and `run-task --mode backfill` are unavailable.

Add the Multi-Agent command block from Step 2 and state that the same five unique-paper counters are used: `candidates`, `accepted`, `newVersions`, `archived`, and `published`.

- [x] **Step 5: Correct `CONTEXT.md` domain terms.**

Replace the current Multi-Agent and “研究来源” definitions with these authoritative meanings:

```markdown
**Multi-Agent Engineering 方向库**:
以多个具有独立 Context、State 或决策边界的 Agent 组成的系统为研究范围；当前稳定标识为 multi-agent-engineering，活动实现是仅通过 OpenCLI/arXiv 自动获取论文的 paper 库。它复用 FSD/Agent 的 PDF、MinerU、Archive v2 和 Evidence v3 路径，并保留用户显式触发的本地 PDF 导入。
用户参与 Agent 团队的审批、授权、共享状态和人工接管属于本库的交叉主题，但基础用户、租户和组织定义引用 Agent Engineering。
_Avoid_: 单 Agent 的多个 Tool、简单并行请求、没有协作关系的模型集合、Research 多来源工作流

**Agent 方向论文来源**:
Agent Engineering 与 Multi-Agent Engineering 的活动自动来源都限定为 2026-01-01 起的 arXiv 论文。`import-local`/`parse-local` 是用户显式提供本地 PDF 的共享维护入口，不属于自动来源发现；官方文档、规范、仓库、Release、博客和网页不进入这两个方向的自动任务。
_Avoid_: 多来源 Research 方向、自动网页抓取、把本地导入计入 arXiv 水位
```

Keep the generic `src/research/` vocabulary only where it describes future or fixture-covered Research libraries; do not describe either Agent direction as a Research library.

- [x] **Step 6: Generalize `src/README.md` paths and configuration wording.**

Change the configuration paragraph to say that paper directions load the four paper files from `config/<libraryId>/`, while Research directions use their separate four-file contract. Replace FSD-only runtime/PDF/Vault examples with `<libraryId>`-derived paths and list `fsd`, `agent-engineering`, and `multi-agent-engineering` as current paper values.

- [x] **Step 7: Run documentation scope assertions.**

Run:

```powershell
$docs = @('README.md', 'config/README.md', 'CONTEXT.md', 'src/README.md')
foreach ($doc in $docs) {
  if (-not (Select-String -LiteralPath $doc -Quiet -Pattern 'multi-agent-engineering')) {
    throw "$doc does not document multi-agent-engineering"
  }
}
$stale = Select-String -LiteralPath 'CONTEXT.md' -Pattern '两个 Agent 方向库可采集论文、技术报告、官方文档、规范、公开代码仓库'
if ($stale) { throw 'CONTEXT.md still claims both Agent directions use multi-source Research acquisition' }
```

Expected: all four docs mention the new direction and the stale multi-source claim is absent.

- [ ] **Step 8: Commit the isolated Task 3 change set when commits are authorized.**

```powershell
git add -- README.md config/README.md CONTEXT.md src/README.md docs/superpowers/specs/2026-09-06-multi-agent-engineering-design.md
git diff --cached --check
git commit -m "docs: document multi-agent paper-only workflow"
```

In the current dirty checkout, skip this commit and leave the verified files unstaged.

---

### Task 4: Full Verification and Plan Bookkeeping

**Files:**
- Modify: `docs/superpowers/plans/2026-09-07-multi-agent-engineering-paper-only.md`
- Verify: `config/multi-agent-engineering/*.yaml`
- Verify: `tests/multi-agent-paper-library.test.ts`
- Verify: all files changed in Tasks 1–3

**Interfaces:**
- Consumes: the completed configuration, regression tests, CLI behavior, and documentation.
- Produces: fresh proof that the new direction works through shared paper modules without regressing FSD, Agent Engineering, or generic Research fixtures.

- [x] **Step 1: Validate the read-only CLI projections.**

Run:

```powershell
bun src/cli.ts --library multi-agent-engineering harvest-plan --mode current --format json
bun src/cli.ts --library multi-agent-engineering schedule-config --format json
```

Expected: harvest output reports `trackCount: 18`, `totalShards: 36`, `submittedShards: 18`, `updatedShards: 18`, and `maxPapers: 180`; schedule output reports `maxPapers: 18` and the Multi-Agent weekly command.

- [x] **Step 2: Run all focused direction and shared-paper tests.**

Run:

```powershell
bun test --timeout 30000 tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/research-cli.test.ts tests/research-fsd-isolation.test.ts tests/cli-menu.test.ts tests/config-source.test.ts tests/configured-task-limits.test.ts tests/library-config.test.ts tests/workflow.test.ts tests/run-task.test.ts
```

Expected: all focused tests pass. Record any pre-existing sandbox or dirty-fixture failure by exact test name and error; do not modify user-owned configuration to hide it.

- [x] **Step 3: Run the type checker.**

Run:

```powershell
bun run typecheck
```

Expected: exit code 0.

- [x] **Step 4: Run the complete test suite.**

Run:

```powershell
bun test --timeout 30000
```

Expected: all tests pass. If unrelated pre-existing failures remain, report exact totals and test names; the Multi-Agent tests and all directly affected FSD/Agent tests must still pass.

- [x] **Step 5: Check changed files, formatting, and forbidden runtime coupling.**

Run:

```powershell
git diff --check
$newFiles = @(
  'tests/multi-agent-paper-library.test.ts',
  'config/multi-agent-engineering/library.yaml',
  'config/multi-agent-engineering/query-matrix.yaml',
  'config/multi-agent-engineering/paper-policy.yaml',
  'config/multi-agent-engineering/categories.yaml',
  'docs/superpowers/plans/2026-09-07-multi-agent-engineering-paper-only.md'
)
foreach ($file in $newFiles) {
  $bad = Select-String -LiteralPath $file -Pattern '[ \t]+$'
  if ($bad) { throw "$file contains trailing whitespace" }
}
$runtimeCoupling = rg -n --glob '*.ts' "multi-agent-engineering" src
if ($LASTEXITCODE -eq 0) { $runtimeCoupling; throw 'Production TypeScript hard-codes the new direction' }
if ($LASTEXITCODE -ne 1) { throw 'rg failed while checking production TypeScript' }
```

Expected: no whitespace errors, no conflict markers from `git diff --check`, and no `multi-agent-engineering` match under `src/**/*.ts`.

- [x] **Step 6: Review the final diff against every acceptance criterion in the spec.**

Confirm all of the following from the diff and fresh command output:

- four and only four active Multi-Agent paper config files;
- 18 unique Track IDs in the query, policy priority, limits, and categories;
- 36 harvest shards and the 180/18 limits;
- paper menu, MinerU session, checkpoint, manual PDF import, Archive v2, and Evidence v3 reuse;
- no Research commands or production library-ID special case;
- isolated FSD/Agent/Multi-Agent roots;
- root/config/context/source documentation agrees with the implementation.

- [x] **Step 7: Mark completed plan steps and record verification evidence.**

#### Verification Results

- CLI projections: both exit 0. Harvest: 18 Tracks, 36 shards (18 submitted/18 updated), max 180. Schedule: max 18; `--library multi-agent-engineering run-task --mode weekly`.
- Final policy regression: RED was 4 pass / 2 fail because a singular `llm agent` and standalone `shared memory` each admitted an out-of-scope candidate. After restricting eligibility terms to explicit multi-Agent or inter-Agent evidence, the contract test is 6 pass / 0 fail; both negative cases reject and the existing positive case accepts.
- Focused suite: exit 1; 114 pass, 1 fail, 0 skip. Confirmed unrelated failure: `loads fsd through exactly the engine, machine, and library documents` (FSD limit fixture expects 1/3 but current configuration is 5/6/15).
- Typecheck: exit 0. The Multi-Agent MinerU test now uses contextual `MainContext`/`WorkflowDependencies` types, and the configured-task test uses `asLibraryId('multi-agent-engineering')`.
- Full suite: exit 1; 1359 pass, 30 fail, 4 skip. Multi-Agent and directly affected FSD/Agent paper tests passed. Confirmed unrelated failures are recorded in `.superpowers/sdd/2026-09-07-multi-agent-engineering-paper-only/task-4-report.md`; most are Windows `EPERM lstat C:\\Users\\yyc` fixture failures.
- Hygiene: `git diff --check` exit 0 (CRLF warnings only); no trailing whitespace in scoped files; `rg --glob '*.ts' multi-agent-engineering src` exit 1 (no production runtime coupling).
- Final independent review: PASS after the policy-boundary and test-type-safety fixes; no remaining findings in the scoped implementation. Controller reran the six directly affected test files: 44 pass / 0 fail, and typecheck: exit 0.
- Delivery state: all implementation changes remain unstaged and uncommitted. The plan-scoped review records are retained because the work has not been committed or merged.

Change each completed checkbox from `[ ]` to `[x]`. Under this task, append a short `Verification Results` subsection containing the exact typecheck exit status, focused-test pass/fail counts, full-suite pass/fail/skip counts, and any confirmed pre-existing failures.

- [ ] **Step 8: Commit the final bookkeeping when commits are authorized.**

```powershell
git add -- docs/superpowers/plans/2026-09-07-multi-agent-engineering-paper-only.md
git diff --cached --check
git commit -m "docs: record multi-agent implementation verification"
```

In the current dirty checkout, skip this commit and report that all verified changes remain uncommitted.
