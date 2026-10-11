ALTER TABLE worlds ADD COLUMN description text NOT NULL DEFAULT '', ADD COLUMN persona jsonb NOT NULL DEFAULT '{"name":"玩家","description":""}', ADD COLUMN deleted boolean NOT NULL DEFAULT false;
CREATE TABLE character_templates (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), revision integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false, UNIQUE(owner_id,id)
);
CREATE TABLE character_versions (
  template_id uuid NOT NULL, owner_id uuid NOT NULL, revision integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(template_id,revision), FOREIGN KEY(owner_id,template_id) REFERENCES character_templates(owner_id,id)
);
CREATE TABLE world_characters (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, world_id uuid NOT NULL, template_id uuid NOT NULL, template_revision integer NOT NULL, revision integer NOT NULL DEFAULT 1,
  name text NOT NULL, participation integer NOT NULL DEFAULT 50 CHECK(participation BETWEEN 0 AND 100), deleted boolean NOT NULL DEFAULT false,
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id), FOREIGN KEY(owner_id,template_id) REFERENCES character_templates(owner_id,id),
  FOREIGN KEY(template_id,template_revision) REFERENCES character_versions(template_id,revision), UNIQUE(owner_id,world_id,id)
);
ALTER TABLE rooms ADD COLUMN revision integer NOT NULL DEFAULT 1, ADD COLUMN kind text NOT NULL DEFAULT 'legacy' CHECK(kind IN ('legacy','direct','group')), ADD COLUMN max_replies integer NOT NULL DEFAULT 3 CHECK(max_replies BETWEEN 1 AND 3), ADD COLUMN deleted boolean NOT NULL DEFAULT false;
CREATE TABLE room_memberships (
  owner_id uuid NOT NULL, world_id uuid NOT NULL, room_id uuid NOT NULL, actor_id uuid NOT NULL, joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
  PRIMARY KEY(room_id,actor_id), FOREIGN KEY(owner_id,world_id,room_id) REFERENCES rooms(owner_id,world_id,id), FOREIGN KEY(owner_id,world_id,actor_id) REFERENCES world_characters(owner_id,world_id,id)
);
CREATE TABLE lore_entries (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, world_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false, data jsonb NOT NULL,
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id)
);
CREATE TABLE world_state (
  world_id uuid PRIMARY KEY, owner_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL DEFAULT '{"location":"","time":"","present_actor_ids":[],"open_topics":[]}', audience_actor_ids uuid[] NOT NULL DEFAULT '{}',
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id)
);
ALTER TABLE runs ADD COLUMN addressed_actor_ids uuid[] NOT NULL DEFAULT '{}', ADD COLUMN speaker_ids uuid[], ADD COLUMN step_index integer NOT NULL DEFAULT 0, ADD COLUMN step_attempts integer NOT NULL DEFAULT 0, ADD COLUMN context_revision integer, ADD COLUMN final_revision integer, ADD COLUMN regenerated_from uuid REFERENCES runs(id), ADD COLUMN deadline_at timestamptz, ADD COLUMN has_external_effects boolean NOT NULL DEFAULT false;
ALTER TABLE messages DROP CONSTRAINT messages_run_id_role_key, DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK(status IN ('accepted','streaming','completed','failed','cancelled','interrupted','invalidated'));
ALTER TABLE messages ADD COLUMN actor_id uuid, ADD COLUMN actor_name text, ADD COLUMN step_index integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX messages_run_step ON messages(run_id,role,step_index);
CREATE TABLE message_audiences (
  message_id uuid NOT NULL REFERENCES messages(id), actor_id uuid NOT NULL REFERENCES world_characters(id), PRIMARY KEY(message_id,actor_id)
);
CREATE INDEX message_audiences_actor ON message_audiences(actor_id,message_id);
CREATE TABLE prompt_manifests (
  run_id uuid NOT NULL REFERENCES runs(id), attempt integer NOT NULL, data jsonb NOT NULL, PRIMARY KEY(run_id,attempt)
);
CREATE TABLE world_events (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL, world_id uuid NOT NULL, run_id uuid REFERENCES runs(id), message_id uuid REFERENCES messages(id),
  kind text NOT NULL CHECK(kind IN ('user_message','character_claim','user_correction','regeneration')), revision integer NOT NULL, data jsonb NOT NULL,
  audience_actor_ids uuid[] NOT NULL DEFAULT '{}', invalidated boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id), UNIQUE(message_id,kind)
);
CREATE INDEX world_events_world ON world_events(owner_id,world_id,revision);
CREATE TABLE configuration_revisions (
  owner_id uuid NOT NULL REFERENCES owners(id), kind text NOT NULL, entity_id uuid NOT NULL, revision integer NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(owner_id,kind,entity_id,revision)
);
INSERT INTO configuration_revisions(owner_id,kind,entity_id,revision,data)
SELECT owner_id,'world',id,revision,jsonb_build_object('id',id,'name',name,'description',description,'persona',persona,'revision',revision) FROM worlds;
CREATE TABLE sync_snapshots (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), metadata jsonb NOT NULL, records jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX sync_snapshots_expiry ON sync_snapshots(expires_at);
