import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarvestCheckpointSession } from '../src/discovery/checkpoint.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { runHarvestShards } from '../src/discovery/opencli-runner.ts';

const sourcePaper = (baseId: string, version = 1) => ({
  baseId,
  arxivId: `${baseId}v${version}`,
  version,
  title: `Paper ${baseId}`,
  authors: ['Nafiseh Soveizi'],
  categories: ['cs.SE'],
  published: '2026-08-01T00:00:00Z',
  updated: '2026-08-01T00:00:00Z',
});

for (const [expired, localCooldownEnabled] of [[false,true],[true,true],[false,false]]) test(`capacity cooldown gates transport and preserves completed shards (expired=${expired}, enabled=${localCooldownEnabled})`, async () => {
  const store = openStateStore(':memory:');
  const window = {from:'2026-08-01',to:'2026-08-30'};
  const plan = {shards:[
    {key:'done',track:'T1',dateMode:'submitted' as const,query:'all:test',categories:['cs.SE'],maxResults:1},
    {key:'retry',track:'T2',dateMode:'updated' as const,query:'all:test',categories:['cs.SE'],maxResults:1},
  ]};
  try {
    const run = store.startRun({from:'2026-08-01T00:00:00.000Z',to:'2026-08-30T23:59:59.999Z'}, 'current');
    const session = () => createHarvestCheckpointSession({store,runId:run.id,plan,localCooldownEnabled});
    const checkpoint=session();
    checkpoint.start(plan.shards[0]!,0);
    checkpoint.complete(plan.shards[0]!,0,[sourcePaper('2608.1')]);
    checkpoint.start(plan.shards[1]!,1);
    checkpoint.fail(plan.shards[1]!,1,Object.assign(new Error('limited'),{code:'ARXIV_CAPACITY_LIMITED',retryNotBefore:expired?'2000-01-01T00:00:00.000Z':'2999-01-01T00:00:00.000Z'}));
    const requests:string[]=[];
    const execute = () => runHarvestShards(plan.shards,window,{
      checkpoint:session(),
      arxiv:{pageSize:100,requestIntervalMs:6000,maxAttempts:6,maxBackoffMs:180000,requestTimeoutMs:60000,retryJitterMs:1000,capacityCooldownMs:900000},
      sleep:async()=>{},
      execFile:async(_file,args)=>{requests.push(args[args.indexOf('--track')+1]!);return {stdout:JSON.stringify({schemaVersion:1,dateMode:'updated',papers:[]})};},
    });
    if (expired || !localCooldownEnabled) {
      await execute();
      assert.deepEqual(requests,['T2']);
      assert.deepEqual(store.listCompletedHarvestShardKeys(run.id).sort(),['done','retry']);
    } else {
      await assert.rejects(execute(),{code:'ARXIV_COOLDOWN_ACTIVE'});
      assert.deepEqual(requests,[]);
      assert.deepEqual(store.listCompletedHarvestShardKeys(run.id),['done']);
    }
    assert.equal(session().loadMergedPapers()[0]!.baseId,'2608.1');
  } finally {store.close();}
});

test('checkpoint does not complete metadata-less harvested papers', () => {
  const store = openStateStore(':memory:');
  const plan = { shards: [{ key: 'key-1', track: 'T1', dateMode: 'submitted' as const, query: 'all:test', categories: ['cs.SE'] }] };
  try {
    const run = store.startRun({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, 'current');
    const checkpoint = createHarvestCheckpointSession({ store, runId: run.id, plan });
    checkpoint.start(plan.shards[0], 0);
    const { authors: _authors, ...withoutAuthors } = sourcePaper('2608.missing-authors');
    assert.throws(() => checkpoint.complete(plan.shards[0], 0, [withoutAuthors]), /source metadata.*authors/i);
    assert.deepEqual(store.listCompletedHarvestShardKeys(run.id), []);
  } finally {
    store.close();
  }
});

test('checkpoint does not complete harvested papers with no authors', () => {
  const store = openStateStore(':memory:');
  const plan = { shards: [{ key: 'key-empty-authors', track: 'T1', dateMode: 'submitted' as const, query: 'all:test', categories: ['cs.SE'] }] };
  try {
    const run = store.startRun({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, 'current');
    const checkpoint = createHarvestCheckpointSession({ store, runId: run.id, plan });
    checkpoint.start(plan.shards[0], 0);
    assert.throws(() => checkpoint.complete(plan.shards[0], 0, [{ ...sourcePaper('2608.empty-authors'), authors: [] }]), /source metadata.*authors/i);
    assert.deepEqual(store.listCompletedHarvestShardKeys(run.id), []);
  } finally {
    store.close();
  }
});

test('checkpoint session exposes completed keys and merges persisted observations', () => {
  const store = openStateStore(':memory:');
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  const plan = {
    shards: [
      { key: 'key-1', track: 'T1', dateMode: 'submitted', query: 'all:test', categories: ['cs.SE'] },
      { key: 'key-2', track: 'T2', dateMode: 'updated', query: 'all:test', categories: ['cs.PL'] },
    ],
  };
  try {
    const run = store.startRun(window, 'current');
    const first = createHarvestCheckpointSession({ store, runId: run.id, plan });
    first.start(plan.shards[0], 0);
    const paper = sourcePaper('2608.1');
    first.complete(plan.shards[0], 0, [paper]);

    const resumed = createHarvestCheckpointSession({ store, runId: run.id, plan });
    assert.deepEqual([...resumed.completedKeys], ['key-1']);
    assert.deepEqual(resumed.loadMergedPapers(), [{ ...paper, matchedTracks: ['T1'], dateModes: ['submitted'] }]);
  } finally {
    store.close();
  }
});

test('checkpoint merge excludes completed observations outside the current plan', () => {
  const store = openStateStore(':memory:');
  const window = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' };
  const stalePlan = {
    shards: [
      { key: 'stale-key', track: 'Stale', dateMode: 'submitted', query: 'all:old', categories: ['cs.SE'] },
    ],
  };
  const currentPlan = {
    shards: [
      { key: 'current-key', track: 'Current', dateMode: 'updated', query: 'all:new', categories: ['cs.PL'] },
    ],
  };
  try {
    const run = store.startRun(window, 'current');
    const stale = createHarvestCheckpointSession({ store, runId: run.id, plan: stalePlan });
    stale.start(stalePlan.shards[0], 0);
    stale.complete(stalePlan.shards[0], 0, [sourcePaper('2608.old')]);

    const current = createHarvestCheckpointSession({ store, runId: run.id, plan: currentPlan });
    current.start(currentPlan.shards[0], 0);
    const paper = sourcePaper('2608.new');
    current.complete(currentPlan.shards[0], 0, [paper]);

    assert.deepEqual(current.loadMergedPapers(), [{ ...paper, matchedTracks: ['Current'], dateModes: ['updated'] }]);
  } finally {
    store.close();
  }
});
