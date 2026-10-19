-- Associate provisional objects with the request that may still be writing them.
-- A generation fences cleanup acknowledgements from a late upload's recovery.
ALTER TABLE cleanup_tasks ADD COLUMN writer_owner TEXT;
ALTER TABLE cleanup_tasks ADD COLUMN generation TEXT NOT NULL DEFAULT '';
CREATE INDEX cleanup_retry_order ON cleanup_tasks(attempts,created_at);
