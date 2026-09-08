import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStateDatabase } from '../src/runtime/sqlite.ts';
import YAML from 'yaml';
import { openStateStore } from '../src/library/state/state-store.ts';
import { runConfiguredTask } from '../src/cli/routes.ts';
import { runTask } from '../src/library/pipeline.ts';
import { loadConfig } from '../src/shared/config.ts';
import { buildHarvestPlan } from '../src/discovery/harvest-plan.ts';
import { createHarvestCheckpointSession } from '../src/discovery/checkpoint.ts';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import type { CandidateDecision, PaperIdentity, PaperMetadata, HarvestShard } from '../src/types/papers.ts';
import type { ProgressEvent, RunWindow, TaskMode } from '../src/types/jobs.ts';

type FixturePaper = PaperMetadata & PaperIdentity;
type FixtureJob = FixturePaper & { pdfPath: string; model: string; cliBackend: string; method: string };
type HarvestOptions = { checkpoint: ReturnType<typeof createHarvestCheckpointSession>; [key: string]: unknown };

// A legacy run and its checkpoints are persisted in a temporary real database.
// Only the external downloader, parser and knowledge-preparation boundary are replaced.
for (const mode of ['current', 'weekly']) test(`${mode} resumes a legacy review run without receipts or new harvest requests`, async t => {
  const fx = await makeRuntimeFixture();
  const root = fx.root;
  const path = join(root, 'papers.sqlite');
  const store = openStateStore(path);
  const config = loadConfig({ root: process.cwd() });
  const matrix: unknown = YAML.parse(readFileSync('config/fsd/query-matrix.yaml', 'utf8'));
  const plan = buildHarvestPlan({ matrix, trackLimits: config.currentTask.trackLimits, arxiv: config.arxiv });
  const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-08-30T08:37:41.396Z' };
  const run = store.startRun(window, mode);
  const paper = (id: string, title: string) => ({ baseId:id, arxivId:`${id}v1`, version:1, title, summary:'', authors:['Fixture Author'], published:'2026-08-01', updated:'2026-08-01', categories:['cs.SE'] });
  const wiki = paper('2608.10001', 'GraphRAG for repository-level documentation');
  const ast = paper('2608.10002', 'Control flow graph for test generation');
  const unrelated = paper('2608.10003', 'LLM for function-level docstring generation');
  const checkpoint = createHarvestCheckpointSession({ store, runId:run.id, plan });
  for (const [index, shard] of plan.shards.entries()) {
    checkpoint.start(shard, index);
    checkpoint.complete(shard, index, shard.track === 'LLM-Wiki' ? [wiki, unrelated] : shard.track === 'AI-Program-Analysis-AST' ? [ast] : []);
  }
  const seed = createStateDatabase(path);
  seed.prepare("UPDATE runs SET status='awaiting_evidence_review' WHERE run_id=?").run(run.id);
  seed.close();
  // This is intentionally absent, as it will be after removal of the review API.
  Reflect.deleteProperty(store, 'findEvidenceReview');
  const downloads: string[] = [];
  const progress: ProgressEvent[] = [];
  const terminal: string[] = [];
  const stderr = t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    terminal.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  try {
    const result = await runConfiguredTask(['--mode', mode], process.cwd(), {
      openStateStore: () => store,
      bootstrap: async () => {},
      harvest: (shards: HarvestShard[], actualWindow: RunWindow, options) => {
        assert.deepEqual(actualWindow, window);
        assert.equal(options.checkpoint.completedKeys.size, 16);
        return runHarvestShards(shards, actualWindow, {
          ...options, onProgress: (event: ProgressEvent) => progress.push(event), sleep: async () => {},
          execFile: async () => { throw new Error('completed shards must not fetch again'); },
        });
      },
      executeTask: (options, deps) => runTask(options, {
        ...deps, lockPath:join(root,'lock'), runRoot:join(root,'runs'), withLock: async (_path, action) => action(),
        onProgress: (event: ProgressEvent) => progress.push(event),
        pdfStore: { download: async (decision) => {
          downloads.push(decision.paper.baseId);
          return { ...decision.paper, pdfPath:join(root,`${decision.paper.arxivId}.pdf`) };
        } },
        buildManifest: (runId: string, papers) => ({ runId,
          jobs: papers.map(paper => ({ ...paper, model: 'pipeline', cliBackend: 'pipeline', method: 'auto' })) }), writeManifest: async () => {},
        parseOne: async () => ({ status:'succeeded' }),
        publishEvidence: async (runId: string, manifest) => ({ publicationId: `evidence-${runId}`, sourceCount: manifest.jobs.length, replayed: false }),
      }),
    });
    assert.equal(result.runId, run.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(downloads.sort(), ['2608.10001', '2608.10002']);
    assert.deepEqual(progress.filter(event => event.type === 'parse-start').map(event => event.model), ['pipeline', 'pipeline']);
    assert.equal(progress.filter(event => event.type === 'parse-complete' && event.status === 'succeeded').length, 2);
    assert.equal(terminal.length, 1);
    assert.match(terminal[0], /恢复 run .*已完成 16\/16 个分片/);
    const verify = createStateDatabase(path, { readOnly:true });
    try {
      assert.equal(verify.prepare('SELECT status FROM papers WHERE base_id=?').get(unrelated.baseId)?.status, 'excluded');
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n, 1);
      assert.equal(verify.prepare("SELECT value FROM settings WHERE key='last_success'").get(), undefined);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM evidence_reviews').get()?.n, 0);
    } finally { verify.close(); }
  } finally {
    stderr.mock.restore();
    // runConfiguredTask owns and closes the injected store, including on failure.
    await fx.dispose();
  }
});
