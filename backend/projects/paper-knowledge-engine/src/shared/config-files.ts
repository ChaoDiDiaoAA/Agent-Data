import { join } from 'node:path';
import { asLibraryId } from './identity.ts';
import type { LibraryKind } from '../types/config.ts';

/** The complete active configuration set, also bound into operation policy snapshots. */
export function configurationFiles(libraryId = 'fsd', kind: LibraryKind = 'paper'): string[] {
  const id = asLibraryId(libraryId);
  return ['engine.yaml', 'machine.local.yaml',
    ...(kind === 'paper'
      ? ['library.yaml', 'query-matrix.yaml', 'paper-policy.yaml', 'categories.yaml']
      : ['library.yaml', 'query-matrix.yaml', 'source-policy.yaml', 'topic-taxonomy.yaml'])
      .map(name => join(id, name))];
}
