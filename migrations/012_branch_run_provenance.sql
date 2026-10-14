ALTER TABLE runs ADD COLUMN history_source_run_id uuid REFERENCES runs(id);
