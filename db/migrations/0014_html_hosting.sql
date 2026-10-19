CREATE TABLE html_hosts (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL UNIQUE REFERENCES file_shares(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at INTEGER NOT NULL
);
CREATE INDEX html_hosts_created ON html_hosts(created_at DESC,file_id);

CREATE TRIGGER html_hosts_share_matches BEFORE INSERT ON html_hosts
WHEN NOT EXISTS(SELECT 1 FROM file_shares WHERE id=NEW.share_id AND file_id=NEW.file_id)
BEGIN
  SELECT RAISE(ABORT, 'HTML hosting share does not match file');
END;

-- Only newly registered HTML hosts participate. Existing shares are not modified.
-- File deletion and edits through ordinary sharing controls must invalidate stale actions too.
CREATE TRIGGER html_hosts_share_version AFTER UPDATE OF enabled,password_hash,expires_at,allow_download ON file_shares
WHEN OLD.enabled IS NOT NEW.enabled OR OLD.password_hash IS NOT NEW.password_hash
  OR OLD.expires_at IS NOT NEW.expires_at OR OLD.allow_download IS NOT NEW.allow_download
BEGIN
  UPDATE html_hosts SET version=version+1 WHERE share_id=NEW.id;
END;
