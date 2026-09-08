// Task 1 owns these configuration contracts; this boundary only re-exports types.
export type { ResearchSourceKind, SourcePolicyConfig, TopicTaxonomyConfig } from './config.ts';
import type { ResearchSourceKind } from './config.ts';

export interface SourceDimensions {
  lifecycles?: string[];
  controlBoundaries?: string[];
  evidenceLevel?: string;
  testingLevels?: string[];
  evaluation?: { objects?: string[]; units?: string[]; adjudicators?: string[]; metrics?: string[]; replayStrategies?: string[] };
  permissions?: { subjects?: string[]; capabilities?: string[]; resourceScopes?: string[]; grants?: string[]; denies?: string[]; approvals?: string[]; audits?: string[] };
  identityTenancy?: { subjects?: string[]; tenants?: string[]; organizations?: string[]; teams?: string[]; memberships?: string[]; roles?: string[]; ownership?: string[]; visibility?: string[]; quotas?: string[]; costs?: string[]; audits?: string[] };
  loop?: { iterationInputs?: string[]; actions?: string[]; observations?: string[]; termination?: string[]; retry?: string[]; maxIterations?: number };
}
export interface SourceProvenance { adapter: string; urls: string[]; parentSourceId?: string; revision?: string; notes?: string[] }
export interface ResearchSource {
  sourceId: string; identityKey: string; kind: ResearchSourceKind; canonicalUrl: string;
  title: string; publisher: string | null; authors: string[]; primaryTrack: string;
  secondaryTracks: string[]; dimensions: SourceDimensions;
}
export interface SourceVersion {
  sourceId: string; versionId: string; versionLabel: string;
  publishedAt: string | null; updatedAt: string | null; releasedAt: string | null; retrievedAt: string;
  contentSha256: string; archivePath: string; provenance: SourceProvenance;
}
export interface ResearchCandidate { source: ResearchSource; version: SourceVersion; matchedTracks: string[]; dateMatches: string[]; discoveryAdapter: string }
export interface SourceArtifact { path: string; contents: Uint8Array }
export interface CitationLocator { artifactPath: string; page?: number; section?: string; startLine?: number; endLine?: number; fragment?: string }
export interface FetchedSource { source: ResearchSource; version: SourceVersion; files: readonly SourceArtifact[]; locators: readonly CitationLocator[] }

export type ResearchRunMode = 'current' | 'weekly' | 'backfill';
export type ResearchRunKind = `research_${ResearchRunMode}`;
export interface ResearchRun { id: string; kind: ResearchRunKind; from: string; to: string; status: string; replayed?: boolean; resumed?: boolean; startedAt?: string }
export interface ResearchShardIdentity { runId: string; shardKey: string }
export interface ResearchShardInput extends ResearchShardIdentity { shardIndex: number; track: string; sourceKind: ResearchSourceKind }
export interface ResearchShardCounts { candidateCount: number; acceptedCount: number; newVersionCount: number; archivedCount: number }
export interface ResearchShardCompletion extends ResearchShardIdentity, ResearchShardCounts {}
export interface ResearchShardFailure extends ResearchShardIdentity { errorCode: string; errorMessage: string }
export interface ResearchShard extends ResearchShardInput, ResearchShardCounts {
  status: 'running' | 'completed' | 'failed'; errorCode: string | null; errorMessage: string | null; startedAt: string; finishedAt: string | null;
}
export interface ResearchObservation extends ResearchShardIdentity {
  sourceId: string; versionId: string; metadata: unknown; decisionStatus: 'discovered' | 'accepted' | 'rejected'; decisionReason: string | null; observedAt: string;
}
export interface ResearchEvidenceSource { sourceId: string; versionId: string; archiveManifestSha256: string; evidenceManifestSha256: string }
export interface ResearchEvidenceReservation { runId: string; publicationId: string; inputSha256: string }
export interface ResearchEvidenceCompletion { runId: string; publicationId: string; receiptPath: string; receiptSha256: string }
export interface ResearchEvidenceFailure { runId: string; publicationId: string; errorCode: string }
export interface ResearchEvidencePublication extends ResearchEvidenceReservation {
  status: 'reserved' | 'completed' | 'failed'; receiptPath: string | null; receiptSha256: string | null;
  reservedAt: string; completedAt: string | null; failedAt: string | null; errorCode: string | null;
}
