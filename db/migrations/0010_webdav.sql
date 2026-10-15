CREATE TABLE webdav_credentials (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
  password_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE webdav_locks (
  path TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
  credential_id TEXT NOT NULL REFERENCES webdav_credentials(id) ON DELETE CASCADE,
  depth TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL
);
CREATE INDEX webdav_locks_expiry ON webdav_locks(expires_at);
CREATE TABLE webdav_properties (
  resource_id TEXT NOT NULL, namespace TEXT NOT NULL, name TEXT NOT NULL,
  value TEXT NOT NULL, PRIMARY KEY(resource_id,namespace,name)
);
CREATE TABLE storage_write_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO storage_write_lease(id) VALUES(1);
CREATE TABLE storage_web_writes (owner TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX storage_web_writes_expiry ON storage_web_writes(expires_at);
CREATE TRIGGER webdav_file_properties_delete AFTER DELETE ON files
BEGIN
  DELETE FROM webdav_properties WHERE resource_id='file:'||OLD.id;
END;
CREATE TRIGGER webdav_folder_properties_delete AFTER DELETE ON folders
BEGIN
  DELETE FROM webdav_properties WHERE resource_id='folder:'||OLD.id;
END;
-- DAV deletes a tree from leaves to root, keeping its hierarchy in the recycle bin.
DROP TRIGGER folders_empty_before_trash;
CREATE TRIGGER folders_empty_before_trash BEFORE UPDATE OF deleted_at ON folders
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'folder not empty') WHERE
    EXISTS(SELECT id FROM files WHERE folder_id=OLD.id AND deleted_at IS NULL) OR
    EXISTS(SELECT id FROM folders WHERE parent_id=OLD.id AND deleted_at IS NULL);
END;
