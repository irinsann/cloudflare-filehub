-- Retain the most recent revocation even after an explicit restore. A delayed
-- publication from an older upload must not override a newer revocation.
ALTER TABLE image_hosts ADD COLUMN revoked_at INTEGER;
UPDATE image_hosts SET revoked_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
WHERE enabled=0;

-- Also cover revocations caused by ordinary file deletion and WebDAV operations.
CREATE TRIGGER image_hosts_record_revocation
AFTER UPDATE OF enabled ON image_hosts
WHEN NEW.enabled=0 AND NEW.revoked_at IS OLD.revoked_at
BEGIN
  UPDATE image_hosts SET revoked_at=MAX(
    COALESCE(OLD.revoked_at,0)+1,
    CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  ) WHERE name=NEW.name;
END;
