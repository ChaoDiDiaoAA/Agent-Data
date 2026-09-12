export type TaskMode = 'current' | 'weekly';

export type MinerUModel = 'pipeline' | 'vlm';

export interface RunWindow { from: string; to: string }
export interface RunIdentity extends RunWindow { id: string }

/** Validated recovery fields; unknown extra legacy fields remain untouched. */
export interface TaskSelection extends Record<string, unknown> {
  schemaVersion: 1;
  runId: string;
  mode: TaskMode;
  window: RunWindow;
  requestedLimit: number;
  selected: {
    accepted: true;
    primaryTrack: string;
    paper: { baseId: string; version?: number; [field: string]: unknown };
    [field: string]: unknown;
  }[];
  /** Candidates retained to replace a permanently unavailable PDF. */
  fallbacks?: TaskSelection['selected'];
}

/** Fields emitted by the existing discovery/download/parse progress producers. */
export interface ProgressEvent {
  type: string;
  phase?: string;
  mode?: string;
  window?: RunWindow;
  configPath?: string;
  configuredLimit?: number;
  requestedLimit?: number;
  runId?: string;
  inputFingerprint?: string;
  completedShards?: number;
  totalShards?: number;
  current?: number;
  total?: number;
  track?: string;
  dateMode?: string;
  categories?: string[];
  httpStatus?: number;
  attempt?: number;
  maxAttempts?: number;
  waitMs?: number;
  retryAfterMs?: number;
  scannedEntries?: number;
  retryNotBefore?: string;
  rateLimitKind?: string;
  diagnostic?: string;
  transportCode?: string;
  shardPaperCount?: number;
  discoveredCount?: number;
  elapsedMs?: number;
  totalElapsedMs?: number;
  error?: string;
  evaluatedCount?: number;
  acceptedCount?: number;
  existingCount?: number;
  newCandidateCount?: number;
  selectedCount?: number;
  quotaCount?: number;
  spilloverCount?: number;
  selectedByTrack?: Record<string, number>;
  parseReady?: boolean;
  fallbackCount?: number;
  arxivId?: string;
  baseId?: string;
  status?: string;
  replacementArxivId?: string;
  bytes?: number | null;
  model?: string;
  errorClass?: string | null;
  attemptId?: string;
  paperCount?: number;
  failedPhase?: string;
  sourceCount?: number;
  publicationId?: string;
  replayed?: boolean;
}
export type ProgressReporter = (event: ProgressEvent) => void;

export interface HarvestShardIdentity { runId: string; shardKey: string }
export interface HarvestShardInput extends HarvestShardIdentity {
  shardIndex: number; totalShards: number; track: string; dateMode: string; query: string; categories: string[];
}
export interface ParseIdentity { baseId: string; version: number; sha256: string; model: string; method?: string }
export interface ParseAttemptInput extends ParseIdentity {
  cliBackend: string; sourcePath?: string | null; fileSource?: string | null; outputDir?: string | null;
}
export interface ParseArtifacts {
  /** Set only by the verified Archive installation boundary for atomic PDF adoption. */
  archivePdfPath?: string;
  cleanupPending?: import('../shared/archive-v2.ts').ArchiveCleanupPending;
  rawOutputDir?: string; normalizedDir?: string;
  previousOutputDir?: string; archivedOutputDir?: string;
  sourcePath?: string | null; fileSource?: string | null; outputDir?: string | null;
  markdownPath?: string | null; contentListPath?: string | null; pageTextPath?: string | null;
  pageCount?: number | null; elapsedMs?: number | null; exitCode?: number | null;
}

export interface MinerUCliJob {
  model: string; fileSource: string; outputDir: string; arxivId?: string;
  method?: string; language?: string; formula?: boolean; table?: boolean; timeoutMs?: number;
}
export interface LocalParseJob extends Partial<MinerUCliJob> {
  libraryId?: import('../shared/identity.ts').LibraryId;
  libraryPaths?: import('../shared/paths.ts').LibraryPaths;
  mineruVersion?: string;
  baseId: string; version: number; model: string; cliBackend: string; sha256: string;
  reparse?: boolean; isOcr?: boolean; retryOfMethod?: string; pageCount?: number; attemptStartedAt?: number;
  arxivId?: string; title?: string; authors?: string[]; categories?: string[];
  published?: string; updated?: string; primaryTrack?: string | null; matchedTracks?: string[];
  sourceType?: string;
  /** Bound by runLocalParse before the Archive workspace is atomically installed. */
  parseAttemptId?: string; parserConfigKey?: string;
}
export interface MinerUExecution {
  exitCode: number; elapsedMs?: number; stderrSummary?: string; stdoutSummary?: string;
  clientStderrSummary?: string; apiStderrSummary?: string;
  errorCode?: string | null; cleanupConfirmed?: boolean; timedOut?: boolean; timeoutMs?: number;
}
export interface NormalizedArtifact extends ParseArtifacts {
  model?: string; cliBackend?: string; contentHash?: string; pages?: import('./papers.ts').PdfPage[];
  markdown?: string; contentList?: unknown[]; pageText?: string;
}

/** Existing orchestration checkpoints may predate full local-parser job fields. */
export type TaskPaper = import('./papers.ts').PaperMetadata & { baseId: string };
export type TaskParseJob = TaskPaper & Partial<Omit<LocalParseJob, 'sha256'>> & {
  pdfPath?: string; mineruVersion?: string; sourceCommit?: string; sourceType?: string;
};
export interface TaskParseManifest { runId: string; window?: Partial<RunWindow>; jobs: TaskParseJob[] }
export type TaskDecision = import('./papers.ts').CandidateDecision<TaskPaper> & { reasons?: unknown; selectionReason?: string };
export type TaskDownloadedPaper = TaskPaper & { pdfPath: string; pageCount?: number; sourceType?: string; bytes?: number; skipped?: boolean | string; duplicateOf?: string };
export type TaskResult =
  | { status: 'disabled'; mode: TaskMode; selected: TaskDecision[]; runId?: never; paperCount?: never; window?: never; replayed?: never }
  | { status: 'completed'; mode: TaskMode; runId: string; window: RunWindow; selected: TaskDecision[]; paperCount?: number; replayed?: boolean };
