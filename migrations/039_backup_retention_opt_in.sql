-- Existing explicit retention choices remain unchanged; new plans preserve all points.
ALTER TABLE remote_backup_plans DROP CONSTRAINT remote_backup_plans_keep_count_check;
ALTER TABLE remote_backup_plans ALTER COLUMN keep_count SET DEFAULT 0;
ALTER TABLE remote_backup_plans ADD CHECK(keep_count BETWEEN 0 AND 100);
