ALTER TABLE messages ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN selected_version_id uuid;
ALTER TABLE messages ADD COLUMN context_stale boolean NOT NULL DEFAULT false;
CREATE TABLE message_versions (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  message_id uuid NOT NULL,
  content text NOT NULL,
  status text NOT NULL,
  base_context_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,message_id) REFERENCES messages(owner_id,id),
  UNIQUE(message_id,id)
);
INSERT INTO message_versions(id,owner_id,message_id,content,status,base_context_revision)
SELECT gen_random_uuid(),m.owner_id,m.id,m.content,m.status,w.revision FROM messages m
JOIN rooms r ON r.id=m.room_id JOIN worlds w ON w.id=r.world_id
WHERE m.status IN ('accepted','completed','interrupted') AND m.content<>'';
UPDATE messages m SET selected_version_id=v.id FROM message_versions v WHERE v.message_id=m.id;
ALTER TABLE messages ADD CONSTRAINT selected_version_belongs_to_message
  FOREIGN KEY(id,selected_version_id) REFERENCES message_versions(message_id,id) DEFERRABLE INITIALLY DEFERRED;

-- Stream fragments remain a single in-progress message. Only settled content
-- becomes a history version. Privacy erasure also removes every retained version.
CREATE FUNCTION capture_message_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_id uuid; context_revision integer;
BEGIN
  IF NEW.status='invalidated' AND NEW.content='' THEN
    NEW.selected_version_id := NULL;
    DELETE FROM message_versions WHERE message_id=NEW.id;
  ELSIF NEW.content<>'' AND NEW.status IN ('accepted','completed','interrupted') AND
    (TG_OP='INSERT' OR (NEW.selected_version_id IS NOT DISTINCT FROM OLD.selected_version_id
      AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.selected_version_id IS NULL))) THEN
    version_id := gen_random_uuid();
    SELECT w.revision INTO context_revision FROM rooms r JOIN worlds w ON w.id=r.world_id WHERE r.id=NEW.room_id;
    INSERT INTO message_versions(id,owner_id,message_id,content,status,base_context_revision)
      VALUES(version_id,NEW.owner_id,NEW.id,NEW.content,NEW.status,context_revision);
    NEW.selected_version_id := version_id;
  END IF;
  IF TG_OP='UPDATE' AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.selected_version_id IS DISTINCT FROM OLD.selected_version_id
    OR NEW.context_stale IS DISTINCT FROM OLD.context_stale OR NEW.status IS DISTINCT FROM OLD.status) THEN
    NEW.revision := OLD.revision+1;
  END IF;
  RETURN NEW;
END $$;
-- The parent message is inserted after this trigger: its FK is deferred as well.
ALTER TABLE message_versions DROP CONSTRAINT message_versions_owner_id_message_id_fkey;
ALTER TABLE message_versions ADD CONSTRAINT message_versions_owner_id_message_id_fkey
  FOREIGN KEY(owner_id,message_id) REFERENCES messages(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER message_version_capture BEFORE INSERT OR UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION capture_message_version();
