CREATE TABLE admin_account (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL, totp_cipher TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1, created_at INTEGER NOT NULL);
CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE admin_setup (token_hash TEXT PRIMARY KEY, totp_cipher TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE admin_recovery (code_hash TEXT PRIMARY KEY);
CREATE INDEX admin_session_expiry ON admin_sessions(expires_at);
