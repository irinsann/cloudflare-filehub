CREATE TABLE storage_allocations (object_key TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size>=0));
CREATE TABLE storage_quota_state (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0);
INSERT INTO storage_quota_state(id) VALUES(1);
