CREATE TABLE conversation_branches (
  room_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  source_room_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  source_revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,room_id) REFERENCES rooms(owner_id,id),
  FOREIGN KEY(owner_id,source_room_id) REFERENCES rooms(owner_id,id),
  FOREIGN KEY(owner_id,source_message_id) REFERENCES messages(owner_id,id)
);
