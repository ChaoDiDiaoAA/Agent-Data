CREATE TABLE IF NOT EXISTS paper_source_metadata (
  base_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256)=64 AND metadata_sha256 NOT GLOB '*[^0-9a-f]*'),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(base_id,version)
) STRICT;
