import type { PaperMetadata } from '../types/papers.ts';
const asArray = <T>(value: T[] | null | undefined): T[] => Array.isArray(value) ? value : [];
const uniqueSorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
export function mergeShardResults<P extends PaperMetadata>(results: { shard: { track: string; dateMode: string }; papers: P[] }[]) {
  const byBaseId = new Map<string, P & { baseId: string; version: number; matchedTracks: string[]; dateModes: string[] }>();
  for (const { shard, papers } of results) {
    for (const paper of asArray(papers)) {
      const arxivId = String(paper.arxivId ?? paper.id ?? '');
      const derivedBase = arxivId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '');
      const baseId = String(paper.baseId ?? derivedBase);
      if (!baseId) continue;
      const current = byBaseId.get(baseId);
      const currentVersion = Number(current?.version ?? 0);
      const version = Number(paper.version ?? String(arxivId).match(/v(\d+)$/)?.[1] ?? 1);
      const latest = !current || version >= currentVersion ? { ...paper, baseId, version } : current;
      const matchedTracks = uniqueSorted([...(current?.matchedTracks ?? []), shard.track]);
      const dateModes = uniqueSorted([...(current?.dateModes ?? []), shard.dateMode]);
      byBaseId.set(baseId, { ...latest, matchedTracks, dateModes });
    }
  }
  return [...byBaseId.values()].sort((a, b) => a.baseId.localeCompare(b.baseId));
}
