CREATE TABLE IF NOT EXISTS run_resume_policies (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  auto_resume INTEGER NOT NULL CHECK(auto_resume IN (0,1))
) STRICT;
