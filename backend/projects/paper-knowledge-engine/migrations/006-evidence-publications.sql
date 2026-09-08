CREATE TABLE IF NOT EXISTS evidence_publications (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  publication_id TEXT NOT NULL UNIQUE,
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_path TEXT,
  receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR (length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
  reserved_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  error_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS evidence_publication_sources (
  run_id TEXT NOT NULL REFERENCES evidence_publications(run_id),
  base_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  archive_manifest_sha256 TEXT NOT NULL CHECK(length(archive_manifest_sha256)=64 AND archive_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_manifest_sha256 TEXT NOT NULL CHECK(length(evidence_manifest_sha256)=64 AND evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_id,base_id,version),
  FOREIGN KEY(base_id,version) REFERENCES paper_versions(base_id,version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_evidence_publication_sources_paper
ON evidence_publication_sources(base_id,version);
