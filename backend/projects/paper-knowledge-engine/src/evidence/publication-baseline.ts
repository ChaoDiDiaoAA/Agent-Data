import type { StateStore } from '../library/state/state-store.ts';
import { canonicalJson, hashCanonical } from '../shared/manifest.ts';
import { EvidenceReceiptError } from './receipt-store.ts';
import type { EvidencePublicationPlanV3 } from './publisher.ts';

export type CompletedPublication = ReturnType<StateStore['listCompletedEvidencePublications']>[number];
export type BaselinePublication = {
  original: Omit<CompletedPublication, 'receiptPath'>;
  projection: EvidencePublicationPlanV3;
};
export interface ArchiveV2PublicationBaseline {
  schemaVersion: 1;
  kind: 'archive-v2-publication-baseline';
  libraryId: string;
  migration: NonNullable<ReturnType<StateStore['getLibraryLayoutMigration']>>;
  plans: { archive: string; library: string; vault: string };
  publications: BaselinePublication[];
  sha256: string;
}
export interface RendererUpgradePublicationBaseline {
  schemaVersion: 1;
  kind: 'evidence-v3-renderer-upgrade-baseline';
  libraryId: string;
  vaultPlanSha256: string;
  publications: BaselinePublication[];
  sha256: string;
}
export type PublicationBaseline = ArchiveV2PublicationBaseline | RendererUpgradePublicationBaseline;

export function publicationIdentity({ receiptPath: _, ...identity }: CompletedPublication) { return identity; }

/** SQLite is the trust anchor. No external plan, old root, or sidecar is used at runtime. */
export function readPublicationBaseline(store: StateStore): PublicationBaseline | null {
  const row = store.getPublicationBaseline();
  if (!row) return null;
  try {
    const parsed: PublicationBaseline = JSON.parse(row.canonical_json);
    const { sha256, ...body } = parsed;
    if (sha256 !== row.sha256 || hashCanonical(body) !== sha256 || canonicalJson(parsed) !== row.canonical_json
      || parsed.schemaVersion !== 1 || !Array.isArray(parsed.publications) || !parsed.publications.length
      || new Set(parsed.publications.map(p => p.original.runId)).size !== parsed.publications.length) {
      throw new Error('invalid baseline');
    }
    if (parsed.kind === 'archive-v2-publication-baseline') {
      if (parsed.libraryId !== parsed.migration.library_id
        || canonicalJson(parsed.migration) !== canonicalJson(store.getLibraryLayoutMigration())) throw new Error('invalid baseline');
    } else if (parsed.kind === 'evidence-v3-renderer-upgrade-baseline') {
      const keys = Object.keys(parsed).sort().join('\0');
      if (keys !== ['kind', 'libraryId', 'publications', 'schemaVersion', 'sha256', 'vaultPlanSha256'].join('\0')
        || !/^[a-z][a-z0-9-]{1,31}$/.test(parsed.libraryId)
        || !/^[0-9a-f]{64}$/.test(parsed.vaultPlanSha256)
        || parsed.publications.some(entry => entry.projection.publisherVersion !== 3
          || entry.projection.runId !== entry.original.runId)) throw new Error('invalid baseline');
    } else {
      throw new Error('invalid baseline');
    }
    const completed = store.listCompletedEvidencePublications();
    if (completed.length < parsed.publications.length) throw new Error('baseline publication changed');
    for (let index = 0; index < parsed.publications.length; index++) {
      const entry = parsed.publications[index]!;
      const actual = completed[index];
      if (!actual || actual.runId !== entry.original.runId
        || canonicalJson(publicationIdentity(actual)) !== canonicalJson(entry.original)) throw new Error('baseline publication changed');
    }
    return parsed;
  } catch (error) { throw new EvidenceReceiptError(`publication baseline authentication failed: ${String(error)}`); }
}
