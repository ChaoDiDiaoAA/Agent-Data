import { mergeShardResults } from './merge-results.ts';
import type { openStateStore } from '../library/state/state-store.ts';
import { assertHarvestedSourceMetadata, type PaperMetadata } from '../types/papers.ts';
import type { HarvestShardInput } from '../types/jobs.ts';

type CheckpointShard = Pick<HarvestShardInput, 'track' | 'dateMode' | 'query' | 'categories'> & { key: string };
type CheckpointStore = Pick<ReturnType<typeof openStateStore>, 'listCompletedHarvestShardKeys' | 'beginHarvestShard' | 'completeHarvestShard' | 'failHarvestShard' | 'listHarvestObservations'>;

export function createHarvestCheckpointSession({ store, runId, plan }: { store: CheckpointStore; runId: string; plan: { shards: CheckpointShard[] } }) {
  const currentShardKeys = plan.shards.map((shard) => shard.key);
  const currentShardKeySet = new Set(currentShardKeys);
  const completedKeys = new Set(store.listCompletedHarvestShardKeys(runId).filter((key) => currentShardKeySet.has(key)));
  return {
    completedKeys,
    start(shard: CheckpointShard, index: number) {
      store.beginHarvestShard({
        runId,
        shardKey: shard.key,
        shardIndex: index + 1,
        totalShards: plan.shards.length,
        track: shard.track,
        dateMode: shard.dateMode,
        query: shard.query,
        categories: shard.categories,
      });
    },
    complete(shard: CheckpointShard, _index: number, papers: PaperMetadata[]) {
      assertHarvestedSourceMetadata(papers);
      store.completeHarvestShard({ runId, shardKey: shard.key }, papers);
      completedKeys.add(shard.key);
    },
    fail(shard: CheckpointShard, _index: number, error: unknown) {
      store.failHarvestShard({ runId, shardKey: shard.key }, error);
    },
    loadMergedPapers() {
      return mergeShardResults(store.listHarvestObservations(runId, currentShardKeys).map((observation) => ({
        shard: {
          track: observation.track,
          dateMode: observation.dateMode,
        },
        papers: [observation.paper],
      })));
    },
  };
}
