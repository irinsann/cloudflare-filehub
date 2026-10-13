-- Enforce tree invariants inside SQLite as well as service checks, including concurrent moves.
CREATE TRIGGER folders_no_cycle BEFORE UPDATE OF parent_id ON folders
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'folder cycle') WHERE NEW.parent_id IN (
    WITH RECURSIVE tree(id) AS (
      SELECT OLD.id UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_id=t.id
    ) SELECT id FROM tree
  );
END;
CREATE TRIGGER folders_empty_before_trash BEFORE UPDATE OF deleted_at ON folders
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'folder not empty') WHERE EXISTS(SELECT id FROM files WHERE folder_id=OLD.id) OR EXISTS(SELECT id FROM folders WHERE parent_id=OLD.id);
END;
CREATE TRIGGER files_live_parent_insert BEFORE INSERT ON files
WHEN NEW.folder_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'parent folder unavailable') WHERE NOT EXISTS(SELECT id FROM folders WHERE id=NEW.folder_id AND deleted_at IS NULL);
END;
CREATE TRIGGER files_live_parent_update BEFORE UPDATE OF folder_id,deleted_at ON files
WHEN NEW.folder_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'parent folder unavailable') WHERE NOT EXISTS(SELECT id FROM folders WHERE id=NEW.folder_id AND deleted_at IS NULL);
END;
CREATE TRIGGER folders_live_parent_insert BEFORE INSERT ON folders
WHEN NEW.parent_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'parent folder unavailable') WHERE NOT EXISTS(SELECT id FROM folders WHERE id=NEW.parent_id AND deleted_at IS NULL);
END;
CREATE TRIGGER folders_live_parent_update BEFORE UPDATE OF parent_id,deleted_at ON folders
WHEN NEW.parent_id IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'parent folder unavailable') WHERE NOT EXISTS(SELECT id FROM folders WHERE id=NEW.parent_id AND deleted_at IS NULL);
END;
