CREATE TABLE site_shares (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  token_seed TEXT NOT NULL,
  password_hash TEXT,
  grant_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  views INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER
);
CREATE INDEX site_shares_folder ON site_shares(folder_id);
CREATE INDEX site_shares_created ON site_shares(created_at DESC,id);
CREATE INDEX files_site_path ON files(folder_id,name,deleted_at,status);
CREATE INDEX folders_site_path ON folders(parent_id,name,deleted_at);

-- Restoring a folder must never silently republish a previously revoked website.
CREATE TRIGGER site_shares_revoke_on_folder_trash AFTER UPDATE OF deleted_at ON folders
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE site_shares SET enabled=0,grant_version=grant_version+1
  WHERE enabled=1 AND folder_id IN (
    WITH RECURSIVE tree(id) AS (
      SELECT NEW.id UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id
    ) SELECT id FROM tree
  );
END;
