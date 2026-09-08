-- Explicit offline attestation, separate from immutable publication identities.
CREATE TABLE IF NOT EXISTS evidence_publication_baseline (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  canonical_json TEXT NOT NULL
) STRICT;
