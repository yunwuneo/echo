ALTER TABLE remote_backup_plans ADD COLUMN keep_count integer NOT NULL DEFAULT 7 CHECK(keep_count BETWEEN 1 AND 100);
ALTER TABLE schedules ADD COLUMN notification_state text NOT NULL DEFAULT 'not_scheduled';
ALTER TABLE schedules ADD COLUMN notification_id text;
