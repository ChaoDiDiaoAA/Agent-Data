-- Copy/cutover provenance only. Absolute legacy paths belong in the external
-- reviewed plan, not in the active library database.
CREATE TABLE IF NOT EXISTS library_layout_migrations (
  layout_version INTEGER PRIMARY KEY CHECK(layout_version = 2),
  library_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  history_sha256 TEXT NOT NULL CHECK(length(history_sha256) = 64),
  rewritten_cells INTEGER NOT NULL CHECK(rewritten_cells >= 0)
) STRICT;
