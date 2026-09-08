/** Active publication policy, shared by configuration and the v3 renderer. */
export const EVIDENCE_POLICY_V3 = Object.freeze({
  schemaVersion: 3,
  root: 'Evidence',
  paperRoot: 'papers',
  indexRoots: Object.freeze({
    authors: 'indexes/authors.md', categories: 'indexes/categories.md',
    tracks: 'indexes/tracks.md', years: 'indexes/years.md',
  }),
  publisherVersion: 3,
} as const);
