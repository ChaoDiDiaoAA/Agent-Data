import type { PaperMetadata } from '../../types/papers.ts';

interface MetadataClient { name?: string; enabled?: boolean; lookup?: (paper: PaperMetadata) => Promise<unknown> }
export async function verifyPublication(paper: PaperMetadata, clients: MetadataClient[] = []) {
  for (const client of clients) {
    if (client?.enabled === false || typeof client?.lookup !== 'function') continue;
    try {
      const input: unknown = await client.lookup(paper);
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
      const result = input as Record<string, unknown>;
      if (result.verified === true && (result.status === undefined || typeof result.status === 'string') && (result.baseId === undefined || result.baseId === paper.baseId)) {
        return { publicationStatus: result.status ?? 'verified', metadataVerification: 'verified', source: client.name ?? null };
      }
    } catch {
      // External metadata is advisory. A timeout, rate limit, malformed response,
      // or outage must leave the paper eligible for the arXiv-only download path.
    }
  }
  return { publicationStatus: 'unverified', metadataVerification: 'pending', source: null };
}
