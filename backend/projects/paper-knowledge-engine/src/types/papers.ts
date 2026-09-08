export interface PaperIdentity {
  baseId: string;
  arxivId: string;
  version: number;
}

export interface PdfPaper extends PaperMetadata {
  baseId: string; arxivId: string; version: number; pdfUrl?: string;
}
export interface LocalPaper extends PdfPaper {
  sha256: string; pdfPath: string; pageCount?: number; sourceType?: string;
}
export interface PdfPage { pageNumber: number; text: string; blockCount?: number }
export interface LocalPdfDocument { path: string; sha256: string; pageCount: number; title: string }

/** Discovery and legacy checkpoint inputs may omit fields populated downstream. */
export interface PaperMetadata {
  baseId?: string;
  arxivId?: string;
  id?: string;
  version?: number;
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  submittedAt?: string;
  updatedAt?: string;
  hasImportant2026Version?: boolean;
  matchedTracks?: string[];
  eligibleTracks?: string[];
  dateModes?: string[];
  primaryTrack?: string | null;
  categories?: string[];
  authors?: string[];
  sha256?: string | null;
  status?: string;
}

export interface StoredSourceMetadataV1 {
  schemaVersion: 1;
  baseId: string;
  arxivId: string;
  version: number;
  title: string;
  authors: string[];
  categories: string[];
  published: string;
  updated: string;
}

/** Enforce complete provenance only at the newly harvested arXiv boundary. */
export function assertHarvestedSourceMetadata(papers: PaperMetadata[]) {
  for (const paper of papers) {
    for (const field of ['baseId', 'arxivId', 'title', 'published', 'updated'] as const) {
      if (typeof paper[field] !== 'string') throw new TypeError(`source metadata ${field} must be text`);
    }
    if (typeof paper.version !== 'number' || !Number.isSafeInteger(paper.version) || paper.version < 1) throw new TypeError('source metadata version must be a positive safe integer');
    if (!Array.isArray(paper.authors) || paper.authors.length === 0 || !paper.authors.every((value) => typeof value === 'string')) {
      throw new TypeError('source metadata authors must be a non-empty text array');
    }
    if (!Array.isArray(paper.categories) || !paper.categories.every((value) => typeof value === 'string')) {
      throw new TypeError('source metadata categories must be a text array');
    }
  }
}
export interface CandidateDecision<P extends PaperMetadata = PaperMetadata> {
  accepted: boolean;
  primaryTrack?: string | null;
  paper: P;
}
export type DateMode = 'submitted' | 'updated';
export interface HarvestShard {
  key: string;
  track: string;
  dateMode: DateMode;
  query: string;
  categories: string[];
  maxResults: number;
}
export interface HarvestPlan {
  tracks: string[];
  shards: HarvestShard[];
  totalShards: number;
  maximumCandidateObservations: number;
}

