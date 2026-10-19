CREATE TABLE google_drive_generation (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL DEFAULT 0);
INSERT INTO google_drive_generation(id,generation) VALUES(1,0);
CREATE TABLE google_drive_connections (
 id INTEGER PRIMARY KEY CHECK(id=1), connection_id TEXT NOT NULL UNIQUE,
 account_json TEXT NOT NULL, refresh_cipher TEXT NOT NULL, access_cipher TEXT NOT NULL,
 access_expires INTEGER NOT NULL, refresh_owner TEXT, refresh_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE TABLE google_drive_oauth (
 state_hash TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, verifier_cipher TEXT NOT NULL,
 origin TEXT NOT NULL, admin_session_hash TEXT, generation INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX google_drive_oauth_expiry ON google_drive_oauth(expires_at);
CREATE TABLE google_drive_uploads (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL,
 session_cipher TEXT NOT NULL, file_id TEXT NOT NULL, size INTEGER NOT NULL,
 offset INTEGER NOT NULL DEFAULT 0, result_json TEXT,
 expires_at INTEGER NOT NULL, owner TEXT, lock_until INTEGER NOT NULL DEFAULT 0,
 cancelled INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(connection_id) REFERENCES google_drive_connections(connection_id) ON DELETE CASCADE
);
CREATE INDEX google_drive_upload_expiry ON google_drive_uploads(expires_at);
