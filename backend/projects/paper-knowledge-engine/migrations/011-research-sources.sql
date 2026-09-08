PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS research_sources (
  source_id TEXT PRIMARY KEY CHECK(length(source_id)=32 AND source_id NOT GLOB '*[^0-9a-f]*'),
  identity_key TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('paper','technical-report','official-doc','specification','repository','release','evaluation-method','local-artifact')),
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  primary_track TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL CHECK(status IN ('discovered','accepted','rejected','archived','published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS research_source_versions (
  source_id TEXT NOT NULL REFERENCES research_sources(source_id),
  version_id TEXT NOT NULL,
  version_label TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  archive_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  published_at TEXT,
  updated_at TEXT,
  released_at TEXT,
  retrieved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('discovered','accepted','rejected','archived','published')),
  PRIMARY KEY(source_id, version_id)
) STRICT;

CREATE TABLE IF NOT EXISTS research_shards (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  shard_key TEXT NOT NULL,
  shard_index INTEGER NOT NULL CHECK(shard_index > 0),
  track TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('paper','technical-report','official-doc','specification','repository','release','evaluation-method','local-artifact')),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK(accepted_count >= 0 AND accepted_count <= candidate_count),
  new_version_count INTEGER NOT NULL DEFAULT 0 CHECK(new_version_count >= 0 AND new_version_count <= accepted_count),
  archived_count INTEGER NOT NULL DEFAULT 0 CHECK(archived_count >= 0 AND archived_count <= accepted_count),
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY(run_id, shard_key)
) STRICT;

CREATE TABLE IF NOT EXISTS research_observations (
  run_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  decision_status TEXT NOT NULL CHECK(decision_status IN ('discovered','accepted','rejected')),
  decision_reason TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(run_id, shard_key, source_id, version_id),
  FOREIGN KEY(run_id, shard_key) REFERENCES research_shards(run_id, shard_key),
  FOREIGN KEY(source_id, version_id) REFERENCES research_source_versions(source_id, version_id)
) STRICT;

CREATE TABLE IF NOT EXISTS research_evidence_publications (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  publication_id TEXT NOT NULL UNIQUE,
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
  receipt_path TEXT,
  receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR (length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  reserved_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  error_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS research_evidence_sources (
  run_id TEXT NOT NULL REFERENCES research_evidence_publications(run_id),
  source_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  archive_manifest_sha256 TEXT NOT NULL CHECK(length(archive_manifest_sha256)=64 AND archive_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_manifest_sha256 TEXT NOT NULL CHECK(length(evidence_manifest_sha256)=64 AND evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_id, source_id, version_id),
  FOREIGN KEY(source_id, version_id) REFERENCES research_source_versions(source_id, version_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_research_shards_status ON research_shards(run_id, status, shard_index);
CREATE INDEX IF NOT EXISTS idx_research_observations_source ON research_observations(source_id, version_id);
CREATE INDEX IF NOT EXISTS idx_research_evidence_sources_source ON research_evidence_sources(source_id, version_id);
