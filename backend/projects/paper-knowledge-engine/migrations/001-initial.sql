PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS papers (
  base_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  pdf_path TEXT,
  note_path TEXT,
  sha256 TEXT UNIQUE,
  primary_track TEXT,
  status TEXT NOT NULL CHECK(status IN ('discovered','excluded','downloaded','parsed','synthesized','download_failed','parse_failed')),
  exclusion_reason TEXT,
  processing_error TEXT,
  publication_status TEXT NOT NULL DEFAULT 'unverified',
  metadata_verification TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS paper_versions (
  base_id TEXT NOT NULL REFERENCES papers(base_id),
  version INTEGER NOT NULL,
  arxiv_id TEXT NOT NULL UNIQUE,
  sha256 TEXT,
  submitted_at TEXT,
  updated_at TEXT,
  PRIMARY KEY(base_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  from_utc TEXT NOT NULL,
  to_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS wiki_ingests (
  base_id TEXT NOT NULL REFERENCES papers(base_id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','applied','failed')),
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  PRIMARY KEY(base_id, version, content_hash)
) STRICT;

CREATE TABLE IF NOT EXISTS wiki_pages (
  page_path TEXT PRIMARY KEY,
  page_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status='generated'),
  generated_hash TEXT,
  source_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
