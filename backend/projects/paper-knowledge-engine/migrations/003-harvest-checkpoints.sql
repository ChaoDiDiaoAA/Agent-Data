PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS harvest_shards (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  shard_key TEXT NOT NULL,
  shard_index INTEGER NOT NULL CHECK(shard_index > 0),
  total_shards INTEGER NOT NULL CHECK(total_shards > 0),
  track TEXT NOT NULL,
  date_mode TEXT NOT NULL CHECK(date_mode IN ('submitted','updated')),
  query TEXT NOT NULL,
  categories_json TEXT NOT NULL CHECK(json_valid(categories_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  paper_count INTEGER NOT NULL DEFAULT 0 CHECK(paper_count >= 0),
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  PRIMARY KEY(run_id, shard_key)
) STRICT;

CREATE TABLE IF NOT EXISTS harvest_observations (
  run_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  base_id TEXT NOT NULL,
  arxiv_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  PRIMARY KEY(run_id, shard_key, arxiv_id),
  FOREIGN KEY(run_id, shard_key) REFERENCES harvest_shards(run_id, shard_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_harvest_shards_status ON harvest_shards(run_id,status,shard_index);
CREATE INDEX IF NOT EXISTS idx_harvest_observations_base ON harvest_observations(run_id,base_id);
