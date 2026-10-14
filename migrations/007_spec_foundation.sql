-- Additive foundation. No legacy records are removed or reassigned.
ALTER TABLE messages ADD CONSTRAINT messages_owner_id_unique UNIQUE(owner_id,id);
ALTER TABLE world_characters ADD CONSTRAINT world_characters_owner_id_unique UNIQUE(owner_id,id);
ALTER TABLE provider_connections ADD COLUMN revision integer NOT NULL DEFAULT 1;

CREATE TABLE operation_receipts (
  owner_id uuid NOT NULL REFERENCES owners(id),
  command_type text NOT NULL,
  operation_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,command_type,operation_id)
);

CREATE TABLE assets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  world_id uuid NOT NULL,
  actor_id uuid,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  mime text NOT NULL,
  size integer NOT NULL CHECK(size BETWEEN 1 AND 1048576),
  content bytea NOT NULL CHECK(octet_length(content)=size),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id),
  FOREIGN KEY(owner_id,world_id,actor_id) REFERENCES world_characters(owner_id,world_id,id),
  UNIQUE(owner_id,id),
  UNIQUE NULLS NOT DISTINCT(owner_id,world_id,actor_id,content_hash,mime)
);
CREATE TABLE asset_references (
  owner_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  message_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('attachment','reference')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(asset_id,message_id,purpose),
  FOREIGN KEY(owner_id,asset_id) REFERENCES assets(owner_id,id),
  FOREIGN KEY(owner_id,message_id) REFERENCES messages(owner_id,id)
);

CREATE TABLE model_routes (
  owner_id uuid NOT NULL REFERENCES owners(id),
  subject_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK(subject_kind IN ('owner','actor')),
  capability text NOT NULL CHECK(capability IN ('chat','image','video','stt','tts','vision','embedding')),
  state text NOT NULL CHECK(state IN ('inherit','override','disabled')),
  provider_id uuid,
  revision integer NOT NULL CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state='override')=(provider_id IS NOT NULL)),
  FOREIGN KEY(owner_id,provider_id) REFERENCES provider_connections(owner_id,id),
  PRIMARY KEY(owner_id,subject_id,capability)
);
-- Non-secret connection snapshots; credentials are read from their owning
-- connection only at execution. Snapshots never contain encrypted Key material.
CREATE TABLE run_route_snapshots (
  run_id uuid NOT NULL REFERENCES runs(id),
  step_index integer NOT NULL,
  provider_id uuid NOT NULL REFERENCES provider_connections(id),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,step_index)
);
