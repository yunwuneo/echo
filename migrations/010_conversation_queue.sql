CREATE TABLE conversation_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  room_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  content text NOT NULL CHECK(octet_length(content) <= 64000),
  audience_actor_ids uuid[] NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','deleted')),
  consumed_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,room_id) REFERENCES rooms(owner_id,id),
  FOREIGN KEY(owner_id,consumed_run_id) REFERENCES runs(owner_id,id),
  CHECK((state='consumed') = (consumed_run_id IS NOT NULL))
);
CREATE INDEX conversation_inputs_pending ON conversation_inputs(owner_id,room_id,created_at,id) WHERE state='pending';
