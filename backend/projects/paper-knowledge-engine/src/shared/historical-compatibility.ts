import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Historical compatibility only. These exact identities authenticate old data
 * and locate migration sources; they are not active engine/library settings.
 * This is the sole source-file exclusion from the active old-name scan.
 * Keep the original source roots until the real migration has been verified.
 */
export const LEGACY_PROJECT_ID = 'fsd-code2doc';
export const LEGACY_EVIDENCE_ROOT = '01-Evidence';
export const LEGACY_CODE_ROOT = 'D:/agent-data/backend/projects/fsd-code2doc';
export const LEGACY_DATA_ROOT = 'D:/agent-data/data/fsd-code2doc';
export const LEGACY_STATE_RELATIVE_PATH = '../../fsd-code2doc/state';
export const LEGACY_ARCHIVE_RELATIVE_PATH = '../../fsd-code2doc/state/extracted';
export const LEGACY_CODE_RELATIVE_PATH = '../../fsd-code2doc';
export const LEGACY_PDF_ROOT = 'D:/paper/fsd-code2doc';
export const LEGACY_VAULT_ROOT = 'D:/obsidian/data/fsd-code2doc';

export interface HistoricalRootTopology {
  code: string;
  data: string;
  pdf: string;
  vault: string;
}

export const LEGACY_ROOT_TOPOLOGY: Readonly<HistoricalRootTopology> = {
  code: LEGACY_CODE_ROOT,
  data: LEGACY_DATA_ROOT,
  pdf: LEGACY_PDF_ROOT,
  vault: LEGACY_VAULT_ROOT,
};

/** Pure topology resolver. Cleanup uses only the no-argument production form. */
export function resolveHistoricalCleanupTopology(roots: HistoricalRootTopology = LEGACY_ROOT_TOPOLOGY) {
  const normalized = {
    code: resolve(roots.code),
    data: resolve(roots.data),
    pdf: resolve(roots.pdf),
    vault: resolve(roots.vault),
  };
  if (Object.values(normalized).some(path => !isAbsolute(path))) {
    throw new Error('HISTORICAL_TOPOLOGY_INVALID: every historical root must be absolute');
  }
  return {
    roots: normalized,
    oldBunTests: [
      join(normalized.data, 'tmp', 'bun-tests'),
      join(normalized.data, 'validation', 'tmp', 'bun-tests'),
    ],
    oldEvidenceStaging: join(normalized.data, 'tmp', 'evidence-publications'),
    emptyValidation: join(normalized.data, 'validation'),
    oldVaultRebuildParent: dirname(normalized.vault),
    oldVaultRebuildPrefix: '.fsd-rebuild-',
  };
}

export const LEGACY_EVIDENCE_POLICY = {
  schemaVersion: 1,
  root: LEGACY_EVIDENCE_ROOT,
  paperRoot: 'sources/papers',
  indexRoots: {
    authors: 'indexes/authors', categories: 'indexes/categories',
    tracks: 'indexes/tracks', years: 'indexes/years',
  },
  publisherVersion: 1,
} as const;
