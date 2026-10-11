ALTER TABLE provider_connections ADD COLUMN tools_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE worlds ADD COLUMN last_user_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE runs DROP CONSTRAINT runs_state_check;
ALTER TABLE runs ADD CONSTRAINT runs_state_check CHECK(state IN ('queued','running','awaiting_approval','completed','failed','cancelled','interrupted'));
ALTER TABLE runs ADD COLUMN trigger_kind text NOT NULL DEFAULT 'foreground' CHECK(trigger_kind IN ('foreground','contact','interaction')),
 ADD COLUMN policy_revision integer, ADD COLUMN global_revision integer, ADD COLUMN remaining_ms integer NOT NULL DEFAULT 120000,
 ADD COLUMN background_usage_id uuid REFERENCES background_usage(id);
ALTER TABLE messages ADD COLUMN internal boolean NOT NULL DEFAULT false;
CREATE TABLE autonomy_settings (
 owner_id uuid PRIMARY KEY REFERENCES owners(id), revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false, timezone text NOT NULL DEFAULT 'Asia/Shanghai',
 tools_read boolean NOT NULL DEFAULT false, tools_write boolean NOT NULL DEFAULT false,
 request_limit integer NOT NULL DEFAULT 20 CHECK(request_limit>=0), input_limit integer NOT NULL DEFAULT 100000 CHECK(input_limit>=0), output_limit integer NOT NULL DEFAULT 10000 CHECK(output_limit>=0)
);
INSERT INTO autonomy_settings(owner_id) SELECT id FROM owners;
CREATE TABLE autonomy_policies (
 world_id uuid PRIMARY KEY, owner_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false, memory boolean NOT NULL DEFAULT false, contact boolean NOT NULL DEFAULT false, interaction boolean NOT NULL DEFAULT false,
 tools_read boolean NOT NULL DEFAULT false, tools_write boolean NOT NULL DEFAULT false,
 room_id uuid, max_turns integer NOT NULL DEFAULT 3 CHECK(max_turns BETWEEN 1 AND 3), contact_daily integer NOT NULL DEFAULT 3 CHECK(contact_daily BETWEEN 0 AND 3), interaction_daily integer NOT NULL DEFAULT 4 CHECK(interaction_daily BETWEEN 0 AND 4),
 interval_minutes integer NOT NULL DEFAULT 120 CHECK(interval_minutes>=120), quiet_start text NOT NULL DEFAULT '22:30', quiet_end text NOT NULL DEFAULT '08:00', quiet_interaction boolean NOT NULL DEFAULT false,
 request_limit integer NOT NULL DEFAULT 20 CHECK(request_limit>=0), input_limit integer NOT NULL DEFAULT 100000 CHECK(input_limit>=0), output_limit integer NOT NULL DEFAULT 10000 CHECK(output_limit>=0), category_limit integer NOT NULL DEFAULT 20 CHECK(category_limit>=0),
 next_contact_at timestamptz NOT NULL DEFAULT now(), next_interaction_at timestamptz NOT NULL DEFAULT now(), last_status text, recap_revision integer NOT NULL DEFAULT 0,
 FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id), FOREIGN KEY(owner_id,world_id,room_id) REFERENCES rooms(owner_id,world_id,id)
);
INSERT INTO autonomy_policies(world_id,owner_id) SELECT id,owner_id FROM worlds;
CREATE TABLE autonomy_daily (world_id uuid NOT NULL REFERENCES worlds(id), day date NOT NULL, kind text NOT NULL, count integer NOT NULL DEFAULT 0, PRIMARY KEY(world_id,day,kind));
CREATE TABLE background_scopes (world_id uuid NOT NULL REFERENCES worlds(id),day date NOT NULL,kind text NOT NULL,requests integer NOT NULL DEFAULT 0,input_tokens integer NOT NULL DEFAULT 0,output_tokens integer NOT NULL DEFAULT 0,PRIMARY KEY(world_id,day,kind));
ALTER TABLE background_usage ADD COLUMN day date, ADD COLUMN global_revision integer, ADD COLUMN policy_revision integer;
CREATE TABLE mcp_connections (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), revision integer NOT NULL DEFAULT 1,
 name text NOT NULL, url text NOT NULL, transport text NOT NULL CHECK(transport IN ('streamable_http','sse')),
 enabled boolean NOT NULL DEFAULT true, auth_type text NOT NULL CHECK(auth_type IN ('none','bearer','api_key')), header_name text NOT NULL DEFAULT 'X-API-Key', credential jsonb,
 private_addresses text[] NOT NULL DEFAULT '{}', tools jsonb NOT NULL DEFAULT '[]', discovery_error text, discovered_at timestamptz, UNIQUE(owner_id,id)
);
CREATE TABLE tool_grants (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, world_id uuid NOT NULL, actor_id uuid NOT NULL, connection_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true, tool_name text NOT NULL, schema_hash text NOT NULL,
 effect text NOT NULL CHECK(effect IN ('read','write')), approval_mode text NOT NULL CHECK(approval_mode IN ('each','scoped')),
 argument_scope jsonb NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL,
 FOREIGN KEY(owner_id,world_id,actor_id) REFERENCES world_characters(owner_id,world_id,id), FOREIGN KEY(owner_id,connection_id) REFERENCES mcp_connections(owner_id,id), UNIQUE(owner_id,id)
);
CREATE TABLE tool_calls (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, run_id uuid NOT NULL, step_index integer NOT NULL, ordinal integer NOT NULL,
 actor_id uuid NOT NULL, grant_id uuid NOT NULL REFERENCES tool_grants(id), grant_revision integer NOT NULL, connection_revision integer NOT NULL,
 tool_name text NOT NULL, model_name text NOT NULL, model_call_id text NOT NULL, schema_hash text NOT NULL, arguments jsonb NOT NULL, arguments_hash text NOT NULL,
 effect text NOT NULL, state text NOT NULL CHECK(state IN ('pending','approved','executing','succeeded','failed','denied','expired','outcome_unknown','resolved')),
 world_revision integer NOT NULL, global_revision integer NOT NULL, policy_revision integer NOT NULL,
 result text, truncated boolean NOT NULL DEFAULT false, error_code text, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
 FOREIGN KEY(owner_id,run_id) REFERENCES runs(owner_id,id), UNIQUE(run_id,ordinal)
);
CREATE INDEX tool_calls_pending ON tool_calls(state,expires_at);
ALTER TABLE runs ADD COLUMN max_background_turns integer NOT NULL DEFAULT 3 CHECK(max_background_turns BETWEEN 1 AND 3);
ALTER TABLE tool_calls ADD COLUMN authorization_snapshot jsonb NOT NULL DEFAULT '{}', ADD COLUMN decision text, ADD COLUMN decided_at timestamptz;
