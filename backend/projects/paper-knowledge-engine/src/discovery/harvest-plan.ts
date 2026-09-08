import type { ArxivConfig } from '../types/config.ts';
import type { HarvestPlan, DateMode } from '../types/papers.ts';
import { createHash } from 'node:crypto';

const keyOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildHarvestPlan({ matrix: input, trackLimits, arxiv }: { matrix: unknown; trackLimits: Record<string, number>; arxiv: Pick<ArxivConfig, 'pageSize' | 'candidatePoolMultiplier' | 'maxResultsPerShard'> }): HarvestPlan {
  const matrix = input && typeof input === 'object' && 'tracks' in input ? input : undefined;
  const recipes: unknown[] = Array.isArray(matrix?.tracks) ? matrix.tracks : [];
  const recipeTracks = recipes.map((item) => String(recipeObject(item).id));
  const limitTracks = Object.keys(trackLimits);
  if (new Set(recipeTracks).size !== recipeTracks.length) throw new Error('duplicate harvest track');
  if (JSON.stringify([...recipeTracks].sort()) !== JSON.stringify([...limitTracks].sort())) {
    throw new Error('harvest tracks must exactly match track limits');
  }
  const shards = recipes.flatMap((input) => {
    const recipe = recipeObject(input);
    if (typeof recipe.query !== 'string' || !recipe.query.trim()) throw new Error('harvest query is required');
    if (!Array.isArray(recipe.categories) || recipe.categories.length === 0 || !recipe.categories.every((item: unknown) => typeof item === 'string')) throw new Error('harvest categories are required');
    const dateModes = recipe.dateModes ?? recipe.date_modes;
    if (!Array.isArray(dateModes) || dateModes.length !== 2
      || !dateModes.includes('submitted') || !dateModes.includes('updated')) {
      throw new Error('each harvest track must define submitted and updated');
    }
    const candidateBudget = Math.min(
      arxiv.maxResultsPerShard,
      Math.max(arxiv.pageSize, trackLimits[String(recipe.id)] * arxiv.candidatePoolMultiplier),
    );
    const { query, categories: recipeCategories } = recipe;
    return dateModes.map((mode: unknown) => {
      if (mode !== 'submitted' && mode !== 'updated') throw new Error('each harvest track must define submitted and updated');
      const dateMode: DateMode = mode;
      // Updated scans must reach the window boundary before declaring coverage.
      // A smaller download quota must not reduce this independent scan budget.
      const maxResults = dateMode === 'updated' ? arxiv.maxResultsPerShard : candidateBudget;
      const categories = [...recipeCategories].sort();
      return {
        key: keyOf([recipe.id, dateMode, recipe.query, categories, maxResults]),
        track: String(recipe.id),
        dateMode,
        query,
        categories,
        maxResults,
      };
    });
  });
  return {
    tracks: recipeTracks,
    shards,
    totalShards: shards.length,
    maximumCandidateObservations: shards.reduce((sum, shard) => sum + shard.maxResults, 0),
  };
}

function recipeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('harvest track must be an object');
  return value as Record<string, unknown>;
}
