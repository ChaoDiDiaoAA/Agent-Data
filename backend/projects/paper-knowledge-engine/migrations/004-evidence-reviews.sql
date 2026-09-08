CREATE TABLE IF NOT EXISTS evidence_reviews (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  base_id TEXT NOT NULL REFERENCES papers(base_id),
  source_hash TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('accept','reject','pending')),
  review_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id,base_id,source_hash)
) STRICT;
