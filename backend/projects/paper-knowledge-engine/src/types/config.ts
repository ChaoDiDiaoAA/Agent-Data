import type { LibraryPaths } from '../shared/paths.ts';
import type { EVIDENCE_POLICY_V3 } from '../shared/evidence-policy.ts';
import type { LEGACY_EVIDENCE_POLICY } from '../shared/historical-compatibility.ts';

export interface ProjectPaths {
  pdfRoot: string;
  vaultRoot: string;
  stateRoot: string;
  tempRoot: string;
  backupRoot: string;
}

export interface RuntimePolicy {
  processCleanupTimeoutMs: number;
  diagnosticTimeoutMs: number;
  maxOutputBytes: number;
}

export interface TaskLimitConfig {
  currentTask: { maxPapers: number };
  weeklySchedule: { maxPapers: number };
}
export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export interface WeeklySchedule {
  enabled: boolean;
  taskName: string;
  dayOfWeek: Weekday;
  intervalWeeks: number;
  startDate: string;
  localTime: string;
  timezone: string;
  maxPapers: number;
}
export interface ArxivConfig {
  pageSize: number;
  requestIntervalMs: number;
  maxAttempts: number;
  maxBackoffMs: number;
  requestTimeoutMs: number;
  retryJitterMs: number;
  capacityCooldownMs: number;
  candidatePoolMultiplier: number;
  maxResultsPerShard: number;
}

export type MinerUModel = 'pipeline' | 'vlm';
export type LibraryDateModes = ['submitted', 'updated'] | ['updated', 'submitted'];

export interface EngineMinerUConfig {
  modelSourceRuntime: string;
  model: MinerUModel;
  allowedModels: MinerUModel[];
  maxConcurrency: number;
  processingWindowSize: number;
  pipelineBatchRatio: PipelineBatchRatio;
  pipelineMethod: string;
  pipelineLanguage: string;
  formulaEnabled: boolean;
  tableEnabled: boolean;
  vlmLmdeployBackend: string;
  vlmBatchSize: number;
  vlmCacheMaxEntryCount: number;
  taskTimeoutMs: number;
  resultDownloadTimeoutMs: number;
  apiHost: string;
  apiPort: number;
  apiStartupTimeoutMs: number;
  localImport: LocalImportConfig;
}

export interface EngineConfig {
  engineName: string;
  arxiv: ArxivConfig;
  runtime: RuntimePolicy;
  server: { host: string; port: number; sseHeartbeatMs: number };
  mineru: EngineMinerUConfig;
  evidence: typeof EVIDENCE_POLICY_V3;
  researchEvidence: ResearchEvidencePolicy;
}

export interface ResearchEvidencePolicy {
  schemaVersion: 1;
  root: 'Evidence';
  sourceRoot: 'sources';
  indexRoots: {
    topics: 'indexes/topics.md';
    sourceTypes: 'indexes/source-types.md';
    lifecycles: 'indexes/lifecycles.md';
    concepts: 'indexes/concepts.md';
  };
  publisherVersion: 1;
}

export type OpenCliProxyMode = 'configured' | 'direct' | 'inherit';

export interface MachineConfig {
  network?: { httpProxy?: string; openCliProxyMode?: OpenCliProxyMode; arxivApiBase?: string };
  roots: { dataLibrariesRoot: string; backupLibrariesRoot: string; vaultsRoot: string; pdfLibrariesRoot?: string };
  mineru: {
    sourceRoot: string;
    expectedVersion: string;
    expectedCommit: string;
    pythonVersion: string;
    venvRoot: string;
    modelSourceSetup: string;
    modelScopeRevision: string;
    modelDownloadType: string;
    modelsRoot: string;
    modelScopeCacheRoot: string;
    mineruToolsConfig: string;
    pipelineModelsDir: string;
    vlmModelsDir: string;
    pipelineModelRepository: string;
    pipelineRequiredPaths: string[];
    vlmModelRepository: string;
    expectedGpuName: string;
    mineruInstallExtras: string;
    torchIndexUrl: string;
    lmdeployWheelUrl: string;
    cudaRuntimeDll: string;
    cudaVisibleDevices: string;
    pipelineDeviceMode: string;
    vlmDevice: string;
  };
}

export interface LibraryTrackConfig {
  id: string;
  query: string;
  categories: string[];
  dateModes: LibraryDateModes;
}

export interface LibraryCategoryConfig {
  tracks: Record<string, { pdf: string }>;
  fallbackPdf: string;
}

export type LibraryKind = 'paper' | 'research';
export type ResearchSourceKind =
  | 'paper' | 'technical-report' | 'official-doc' | 'specification'
  | 'repository' | 'release' | 'evaluation-method' | 'local-artifact';
export type ResearchDateField = 'published' | 'updated' | 'released' | 'retrieved';

export interface ResearchTrackConfig {
  id: string;
  query: string;
  sourceKinds: ResearchSourceKind[];
  arxivCategories: string[];
  domains: string[];
  dateFields: ResearchDateField[];
}

export interface ResearchTaskLimits {
  maxSources: number;
  trackLimits: Record<string, number>;
  sourceKindLimits: Partial<Record<ResearchSourceKind, number>>;
}

export interface ResearchWeeklySchedule {
  enabled: boolean;
  taskName: string;
  dayOfWeek: Weekday;
  intervalWeeks: number;
  startDate: string;
  localTime: string;
  timezone: string;
  maxSources: number;
}

export interface SourcePolicyConfig {
  dateLowerBound: string;
  sourceKinds: ResearchSourceKind[];
  allowedDomains: string[];
  identityVersionRules: Record<ResearchSourceKind, string>;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  retainAllVersions: true;
  contentHash: 'sha256';
}

export interface TopicTaxonomyConfig {
  tracks: string[];
  lifecycles: string[];
  controlBoundaries: string[];
  evidenceLevels: string[];
  testingLevels: string[];
  evaluationDimensions: {
    objects: string[];
    units: string[];
    adjudicators: string[];
    metrics: string[];
    replayStrategies: string[];
  };
}

export interface PaperLibraryConfig {
  kind: 'paper';
  libraryId: string;
  displayName: string;
  startDate: string;
  overlapHours: number;
  currentTask: { maxPapers: number; trackLimits: Record<string, number> };
  weeklySchedule: WeeklySchedule;
  downloadAfterHardFilter: boolean;
  tracks: LibraryTrackConfig[];
  paperPolicy: PaperPolicy;
  categories: LibraryCategoryConfig;
}

export interface ResearchLibraryConfig {
  kind: 'research';
  libraryId: string;
  displayName: string;
  startDate: string;
  currentTask: ResearchTaskLimits;
  weeklySchedule: ResearchWeeklySchedule;
  tracks: ResearchTrackConfig[];
  sourcePolicy: SourcePolicyConfig;
  topicTaxonomy: TopicTaxonomyConfig;
}

export type LibraryConfig = PaperLibraryConfig | ResearchLibraryConfig;

export function isPaperLibrary(library: LibraryConfig): library is PaperLibraryConfig {
  return library.kind === 'paper';
}

export function isResearchLibrary(library: LibraryConfig): library is ResearchLibraryConfig {
  return library.kind === 'research';
}

export interface EngineContext {
  engine: EngineConfig;
  machine: MachineConfig;
  library: LibraryConfig;
  paths: LibraryPaths;
}
export interface SelectionConfig extends TaskLimitConfig {
  currentTask: { maxPapers: number; trackLimits: Record<string, number> };
}
export interface PipelineConfig extends ProjectPaths, SelectionConfig {
  libraryKind?: LibraryKind;
  network?: MachineConfig['network'];
  startDate: string;
  overlapHours: number;
  arxiv: ArxivConfig;
  downloadAfterHardFilter: boolean;
  weeklySchedule: WeeklySchedule;
  evidencePolicy: EvidencePolicy;
}
export type EvidencePolicy = typeof EVIDENCE_POLICY_V3 | typeof LEGACY_EVIDENCE_POLICY;
export interface PaperPolicy {
  startDate?: string;
  excludedDomains: string[];
  aiTechniqueTerms: string[];
  programStructureTerms: string[];
  engineeringTaskTerms: string[];
  termVariants: Record<string, string[]>;
  trackPriority: string[];
}

export interface LocalImportConfig {
  recursive: boolean;
  maxFiles: number;
  maxPdfPages: number;
  maxPdfSizeMb: number;
  defaultTrack: string;
  /** Explicit FSD-owned roots that the browser preview bridge may inspect. */
  roots?: { id: string; path: string }[];
}
/** Configuration consumed by job construction; loaders fill every optional switch. */
export interface MinerUParseConfig {
  libraryPaths?: LibraryPaths;
  libraryId?: import('../shared/identity.ts').LibraryId;
  model: string; cliBackend: string; outputRoot: string;
  pipelineMethod?: string; pipelineLanguage?: string; formulaEnabled?: boolean; tableEnabled?: boolean;
  expectedVersion?: string; expectedCommit?: string;
}
export interface MinerUCliConfig {
  libraryPaths?: LibraryPaths;
  libraryId?: import('../shared/identity.ts').LibraryId;
  model: string; cliBackend: string; sourceRoot: string; venvRoot: string; tempRoot: string;
  taskTimeoutMs: number; resultDownloadTimeoutMs: number; modelSourceRuntime: string; mineruToolsConfig: string; modelScopeCacheRoot: string;
  cudaVisibleDevices: string; pipelineDeviceMode: string; vlmDevice: string; vlmLmdeployBackend: string;
  maxConcurrency: number; processingWindowSize: number; pipelineBatchRatio: PipelineBatchRatio;
  vlmBatchSize: number; vlmCacheMaxEntryCount: number;
  apiHost: '127.0.0.1'; apiPort: number; apiStartupTimeoutMs: number;
  pipelineMethod: string; pipelineLanguage: string; formulaEnabled: boolean; tableEnabled: boolean;
  cudaPath?: string; pipelineModelsDir?: string; vlmModelsDir?: string;
  expectedVersion?: string; expectedCommit?: string; enforceSourcePin?: boolean; enforceRuntimePolicy?: boolean;
  allowDirtySource?: boolean; sourceProvenance?: unknown;
}
export type PipelineBatchRatio = 1 | 2 | 4 | 8 | 16;
export interface LocalPdfConfig extends MinerUParseConfig {
  stateRoot: string; vaultRoot: string; localImport: LocalImportConfig;
}
