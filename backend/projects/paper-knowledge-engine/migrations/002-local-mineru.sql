CREATE TABLE IF NOT EXISTS parse_attempts (
  attempt_id TEXT PRIMARY KEY,
  base_id TEXT NOT NULL REFERENCES papers(base_id),
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('pipeline','vlm')),
  cli_backend TEXT NOT NULL CHECK(cli_backend IN ('pipeline','vlm-engine')),
  method TEXT NOT NULL CHECK(method IN ('auto','txt','ocr')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
  source_path TEXT,
  output_dir TEXT,
  markdown_path TEXT,
  content_list_path TEXT,
  page_text_path TEXT,
  page_count INTEGER,
  elapsed_ms INTEGER,
  exit_code INTEGER,
  error_class TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS parse_attempt_identity
ON parse_attempts(base_id,version,sha256,model,method,started_at);
