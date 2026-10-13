CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE, upload_id TEXT NOT NULL, object_key TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE upload_parts (session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE, part_number INTEGER NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(session_id,part_number));
CREATE INDEX uploads_expiry ON upload_sessions(expires_at);
