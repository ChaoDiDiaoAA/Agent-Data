import { archivePath } from '../shared/archive-v2.ts';
import type { VerifiedArchiveSource } from './archive-reader.ts';
import type { VerifiedArchiveV2 } from '../shared/archive-v2.ts';
import type { RenderedFile } from './render-paper.ts';
import { EVIDENCE_POLICY_V3 } from '../shared/evidence-policy.ts';
export const EVIDENCE_LAYOUT_V3 = Object.freeze({
  schemaVersion: EVIDENCE_POLICY_V3.schemaVersion,
  root: EVIDENCE_POLICY_V3.root,
  papersRoot: `${EVIDENCE_POLICY_V3.root}/${EVIDENCE_POLICY_V3.paperRoot}`,
  indexes: Object.freeze({
    authors: `${EVIDENCE_POLICY_V3.root}/${EVIDENCE_POLICY_V3.indexRoots.authors}`,
    categories: `${EVIDENCE_POLICY_V3.root}/${EVIDENCE_POLICY_V3.indexRoots.categories}`,
    tracks: `${EVIDENCE_POLICY_V3.root}/${EVIDENCE_POLICY_V3.indexRoots.tracks}`,
    years: `${EVIDENCE_POLICY_V3.root}/${EVIDENCE_POLICY_V3.indexRoots.years}`,
  }),
} as const);
export type EvidenceFile = RenderedFile;
export type BufferedEvidenceSource = VerifiedArchiveSource & { pdfContents: Uint8Array };
export type EvidenceInput = VerifiedArchiveSource | VerifiedArchiveV2 | BufferedEvidenceSource;

export function evidencePaperRoot(baseId: string, version: number): string {
  archivePath(baseId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(baseId) || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('unsafe Evidence paper identity');
  }
  return `${EVIDENCE_LAYOUT_V3.papersRoot}/${baseId}-v${version}`;
}
