-- Keep the original records column for P5 rollback/read compatibility.
-- Old sessions (and sessions made by an older binary) use the legacy reader.
ALTER TABLE sync_snapshots ADD COLUMN record_count integer;
CREATE TABLE sync_snapshot_pages (
  snapshot_id uuid NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK(page_number>=0),
  records jsonb NOT NULL CHECK(jsonb_typeof(records)='array'),
  PRIMARY KEY(snapshot_id,page_number)
);
