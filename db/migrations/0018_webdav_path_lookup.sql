-- DAV resolves paths without case sensitivity for Windows clients. Keep pending
-- records in the lookup so an in-flight upload still blocks a conflicting path.
CREATE INDEX files_dav_path ON files(folder_id,name COLLATE NOCASE,deleted_at);
