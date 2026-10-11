ALTER TABLE worlds ADD COLUMN memory_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN memory_excluded boolean NOT NULL DEFAULT false;
CREATE TABLE memory_settings (
  world_id uuid PRIMARY KEY, owner_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false, embedding_provider_id uuid, embedding_dimensions integer NOT NULL DEFAULT 0 CHECK(embedding_dimensions BETWEEN 0 AND 4096), index_version integer NOT NULL DEFAULT 1,
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id), FOREIGN KEY(owner_id,embedding_provider_id) REFERENCES provider_connections(owner_id,id)
);
INSERT INTO memory_settings(world_id,owner_id) SELECT id,owner_id FROM worlds;
CREATE TABLE memory_sources (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, message_id uuid UNIQUE NOT NULL REFERENCES messages(id), room_id uuid NOT NULL REFERENCES rooms(id), committed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO memory_sources(message_id,room_id) SELECT id,room_id FROM messages WHERE status='completed' ORDER BY created_at,sequence;
CREATE TABLE memory_jobs (
  room_id uuid PRIMARY KEY REFERENCES rooms(id), cursor bigint NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text
);
INSERT INTO memory_jobs(room_id) SELECT id FROM rooms;
CREATE TABLE memories (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, world_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1,
  content text NOT NULL, content_hash text NOT NULL, topic text NOT NULL, kind text NOT NULL CHECK(kind IN ('statement','claim','preference','agreement','relationship')),
  status text NOT NULL CHECK(status IN ('active','claimed','conflict','superseded','deleted','invalidated')), manual boolean NOT NULL DEFAULT false, pinned boolean NOT NULL DEFAULT false,
  audience_actor_ids uuid[] NOT NULL, terms text[] NOT NULL, valid_from timestamptz NOT NULL DEFAULT now(), valid_to timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id)
);
CREATE INDEX memory_scope ON memories(owner_id,world_id,status);
CREATE INDEX memory_terms ON memories USING gin(terms);
CREATE TABLE memory_evidence (
  memory_id uuid NOT NULL REFERENCES memories(id), message_id uuid NOT NULL REFERENCES messages(id), PRIMARY KEY(memory_id,message_id)
);
CREATE TABLE memory_revisions (
  memory_id uuid NOT NULL REFERENCES memories(id), revision integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY(memory_id,revision)
);
CREATE TABLE memory_tombstones (
  owner_id uuid NOT NULL REFERENCES owners(id), world_id uuid NOT NULL REFERENCES worlds(id), content_hash text NOT NULL, PRIMARY KEY(owner_id,world_id,content_hash)
);
CREATE TABLE memory_vectors (
  memory_id uuid PRIMARY KEY REFERENCES memories(id), revision integer NOT NULL, index_version integer NOT NULL, embedding vector NOT NULL
);
CREATE TABLE message_dependencies (
  message_id uuid NOT NULL REFERENCES messages(id), source_id uuid NOT NULL REFERENCES messages(id), PRIMARY KEY(message_id,source_id)
);
CREATE INDEX message_dependencies_source ON message_dependencies(source_id);
CREATE TABLE background_usage (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), world_id uuid NOT NULL REFERENCES worlds(id), kind text NOT NULL,
  state text NOT NULL DEFAULT 'reserved', input_reserved integer NOT NULL, output_reserved integer NOT NULL,
  input_tokens integer, output_tokens integer, error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE background_daily (
  owner_id uuid NOT NULL REFERENCES owners(id), day date NOT NULL, requests integer NOT NULL DEFAULT 0, input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,day)
);
CREATE TABLE lore_activations (
  room_id uuid NOT NULL REFERENCES rooms(id), actor_id uuid NOT NULL REFERENCES world_characters(id), entry_id uuid NOT NULL REFERENCES lore_entries(id),
  revision integer NOT NULL, turn integer NOT NULL DEFAULT 0, sticky_until integer NOT NULL DEFAULT 0, cooldown_until integer NOT NULL DEFAULT 0, pending_since integer,
  PRIMARY KEY(room_id,actor_id,entry_id)
);
CREATE TABLE lore_commits (
  message_id uuid PRIMARY KEY REFERENCES messages(id), room_id uuid NOT NULL REFERENCES rooms(id), actor_id uuid NOT NULL REFERENCES world_characters(id), states jsonb NOT NULL
);
CREATE TABLE import_jobs (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), world_id uuid NOT NULL REFERENCES worlds(id), file_hash text NOT NULL, adapter_version integer NOT NULL,
  format text NOT NULL, raw bytea NOT NULL, preview jsonb NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,world_id,file_hash,adapter_version)
);
ALTER TABLE memory_settings ADD COLUMN index_error text, ADD COLUMN index_next_at timestamptz NOT NULL DEFAULT now();
