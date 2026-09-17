export const datasetIds = [
  'regulatory-affairs',
  'fda-recalls',
  'procurement-pricing',
  'hospital-resources',
] as const;

export type DatasetId = typeof datasetIds[number];
export type OriginKind = 'public_document' | 'public_redacted' | 'synthetic';
export type LicenseUse = 'allowed' | 'unknown' | 'denied';

export interface DataWatchPaths {
  projectRoot: string;
  paperEngineRoot: string;
  originalRoot: string;
  dataRoot: string;
  vaultRoot: string;
  backupRoot: string;
}

export interface SourceConfig {
  schema_version: 1;
  source_id: string;
  dataset_id: DatasetId;
  repository: string;
  homepage: string;
  revision: { kind: 'huggingface-api'; url: string };
  tree_url_template: string;
  file_url_template: string;
  allowed_origins: string[];
  redirect_origins: string[];
  declared_license: string;
  license_evidence: string;
  data_kind: string;
  origin_kind: OriginKind;
  retention: LicenseUse;
  local_use: LicenseUse;
  redistribution: LicenseUse;
  language: string;
  enabled: boolean;
}

export interface WorkbenchConfig {
  schema_version: 1;
  enabled_dataset_ids: DatasetId[];
  publish_snapshot: boolean;
  max_response_bytes: number;
  request_timeout_ms: number;
}

export interface DatasetFile {
  path: string;
  bytes: number;
  source_oid?: string;
  url: string;
  sha256?: string;
  retrieved_at?: string;
}

export interface DatasetManifest {
  schema_version: 1;
  dataset_id: DatasetId;
  source_id: string;
  repository: string;
  revision: string;
  homepage: string;
  declared_license: string;
  license_evidence: string;
  data_kind: string;
  origin_kind: OriginKind;
  retrieved_at: string;
  files: DatasetFile[];
  manifest_sha256?: string;
}

export type TaskStage = 'probe' | 'acquire' | 'catalog' | 'verify';
export type TaskStageStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskRun {
  schema_version: 1;
  run_id: string;
  dataset_ids: DatasetId[];
  config_sha256: string;
  status: 'running' | 'failed' | 'completed';
  stages: Record<TaskStage, TaskStageStatus>;
  revisions: Partial<Record<DatasetId, string>>;
  created_at: string;
  updated_at: string;
  failed_stage?: TaskStage;
  errors?: Array<{ dataset_id?: DatasetId; path?: string; code: string; message: string }>;
}

export interface DatasetResult {
  dataset_id: DatasetId;
  revision: string;
  files: number;
  bytes: number;
  skipped: number;
}

export interface TaskResult {
  status: 'completed' | 'failed';
  run_id: string;
  datasets: DatasetResult[];
  errors: Array<{ dataset_id?: DatasetId; path?: string; code: string; message: string }>;
}

export interface HttpResult {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export interface HttpClient {
  get(url: string, options: { maxBytes: number; timeoutMs: number; allowedOrigins: string[]; redirectOrigins: string[]; signal?: AbortSignal }): Promise<HttpResult>;
}
