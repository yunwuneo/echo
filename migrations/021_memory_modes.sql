ALTER TABLE rooms ADD COLUMN memory_participation boolean NOT NULL DEFAULT true;
CREATE TABLE memory_policies (
 actor_id uuid PRIMARY KEY REFERENCES world_characters(id) DEFERRABLE INITIALLY IMMEDIATE,
 owner_id uuid NOT NULL REFERENCES owners(id), revision integer NOT NULL DEFAULT 1,
 mode text NOT NULL DEFAULT 'structured' CHECK(mode IN ('diary','structured')),
 recall text NOT NULL DEFAULT 'standard' CHECK(recall IN ('light','standard','deep')),
 vector_scope text NOT NULL DEFAULT 'both' CHECK(vector_scope IN ('user','both')),
 interval_seconds integer NOT NULL DEFAULT 300 CHECK(interval_seconds BETWEEN 60 AND 86400)
);
CREATE TABLE memory_materials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES owners(id),
 world_id uuid NOT NULL, actor_id uuid NOT NULL, room_id uuid REFERENCES rooms(id) DEFERRABLE,
 kind text NOT NULL CHECK(kind IN ('fact','profile','diary','structured','info','event')),
 title text NOT NULL, content text NOT NULL, summary text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1, content_hash text NOT NULL, source_snapshot jsonb NOT NULL DEFAULT '[]',
 source_missing boolean NOT NULL DEFAULT false, independent boolean NOT NULL DEFAULT false,
 feedback text NOT NULL DEFAULT 'normal' CHECK(feedback IN ('normal','less','outdated')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,world_id,actor_id) REFERENCES world_characters(owner_id,world_id,id) DEFERRABLE
);
CREATE TABLE memory_corrections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id),
 actor_id uuid NOT NULL REFERENCES world_characters(id) DEFERRABLE, changes jsonb NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applied','undone')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memory_organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id),
 room_id uuid NOT NULL REFERENCES rooms(id) DEFERRABLE,actor_id uuid NOT NULL REFERENCES world_characters(id) DEFERRABLE,
 mode text NOT NULL,source_hash text NOT NULL,source_snapshot jsonb NOT NULL,
 policy_revision integer NOT NULL,state text NOT NULL DEFAULT 'queued', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(room_id,actor_id,mode,source_hash)
);
ALTER TABLE memory_vectors DROP CONSTRAINT memory_vectors_pkey;
ALTER TABLE memory_vectors ADD PRIMARY KEY(memory_id,index_version);
ALTER TABLE memory_settings ADD COLUMN active_index_version integer NOT NULL DEFAULT 1;
CREATE TABLE memory_index_shards (
 memory_id uuid NOT NULL REFERENCES memories(id) DEFERRABLE,index_version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('failed','skipped')), error_code text,
 PRIMARY KEY(memory_id,index_version)
);
