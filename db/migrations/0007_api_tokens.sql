CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE api_file_owners (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES api_tokens(id)
);
CREATE INDEX api_file_owners_token ON api_file_owners(token_id);
