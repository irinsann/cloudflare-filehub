-- Keep exact quota accounting in the same transaction as every reservation change.
-- This one-time backfill also includes trash and outstanding upload reservations.
ALTER TABLE storage_quota_state ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0);
UPDATE storage_quota_state SET used_bytes=(SELECT COALESCE(SUM(size),0) FROM storage_allocations) WHERE id=1;

CREATE TRIGGER storage_allocation_insert AFTER INSERT ON storage_allocations BEGIN
  UPDATE storage_quota_state SET used_bytes=used_bytes+NEW.size WHERE id=1;
END;
CREATE TRIGGER storage_allocation_delete AFTER DELETE ON storage_allocations BEGIN
  UPDATE storage_quota_state SET used_bytes=used_bytes-OLD.size WHERE id=1;
END;
CREATE TRIGGER storage_allocation_resize AFTER UPDATE OF size ON storage_allocations
WHEN NEW.size<>OLD.size BEGIN
  UPDATE storage_quota_state SET used_bytes=used_bytes+NEW.size-OLD.size WHERE id=1;
END;

-- Reference checks must still see disabled, unpublished, and in-flight records.
CREATE INDEX pages_snapshot_key ON markdown_pages(snapshot_key) WHERE snapshot_key IS NOT NULL;
CREATE INDEX uploads_object_key ON upload_sessions(object_key);
CREATE INDEX images_object_key ON image_hosts(object_key);
CREATE INDEX cleanup_created_at ON cleanup_tasks(created_at);
