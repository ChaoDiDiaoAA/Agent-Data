PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS harvest_retry_windows (
  run_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  retry_not_before TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('ARXIV_CAPACITY_LIMITED')),
  diagnostic TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, shard_key),
  FOREIGN KEY(run_id, shard_key) REFERENCES harvest_shards(run_id, shard_key) ON DELETE CASCADE
) STRICT;

