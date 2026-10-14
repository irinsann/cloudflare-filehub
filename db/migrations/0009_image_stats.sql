ALTER TABLE image_hosts ADD COLUMN views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0);
ALTER TABLE image_hosts ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0);
ALTER TABLE image_hosts ADD COLUMN last_access_at INTEGER;
