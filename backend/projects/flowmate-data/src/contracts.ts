export type OriginKind =
  | 'synthetic' | 'official_example' | 'public_redacted'
  | 'public_document' | 'unknown';

export type DocumentKind = 'invoice' | 'receipt' | 'invoice_template' | 'knowledge';

export interface FlowmatePaths {
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
  dataset_id?: string;
  reader: 'dataset-records' | 'public-files';
  homepage: string;
  record_count?: number;
  annotated_record_count?: number;
  revision: { kind: 'huggingface-api' | 'content-hash'; url: string };
  record_locator?: { index_path: string; file_url_template: string };
  files?: Array<{ id: string; url: string; document_kind: DocumentKind; parse: boolean }>;
  allowed_origins: string[];
  redirect_origins: string[];
  declared_license: string;
  license_evidence: string;
  applicable_period?: string;
  retention: 'allowed' | 'unknown' | 'denied';
  local_use: 'allowed' | 'unknown' | 'denied';
  redistribution: 'allowed' | 'unknown' | 'denied';
  origin_kind: OriginKind;
  language: string;
  document_kind: DocumentKind;
}

export interface WorkbenchConfig {
  schema_version: 1;
  sample: {
    source_id: string;
    dataset_id: string;
    selection_id: string;
    acquire_limit: number;
    parse_limit: number;
    publish_snapshot: boolean;
  };
  knowledge: {
    source_ids: string[];
    parse_source_ids: string[];
  };
  release: {
    version: string;
    include_originals: boolean;
  };
  backup: {
    verify: boolean;
    restore_smoke: boolean;
  };
}
