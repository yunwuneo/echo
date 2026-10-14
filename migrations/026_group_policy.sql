ALTER TABLE rooms ADD COLUMN parent_group_id uuid REFERENCES rooms(id) DEFERRABLE;
ALTER TABLE rooms ADD COLUMN lane_actor_id uuid REFERENCES world_characters(id) DEFERRABLE;
CREATE UNIQUE INDEX one_group_lane ON rooms(parent_group_id,lane_actor_id) WHERE parent_group_id IS NOT NULL AND NOT deleted;
CREATE TABLE group_policies(room_id uuid PRIMARY KEY REFERENCES rooms(id) DEFERRABLE,owner_id uuid NOT NULL REFERENCES owners(id),revision integer NOT NULL DEFAULT 1,instruction text NOT NULL DEFAULT '',mcp_ids uuid[] NOT NULL DEFAULT '{}',memory_enabled boolean NOT NULL DEFAULT false,image_provider_id uuid REFERENCES provider_connections(id) DEFERRABLE,reply_policy text NOT NULL DEFAULT 'turns' CHECK(reply_policy IN ('turns','random','silence')));
CREATE TABLE group_member_policies(room_id uuid NOT NULL REFERENCES rooms(id) DEFERRABLE,actor_id uuid NOT NULL REFERENCES world_characters(id) DEFERRABLE,revision integer NOT NULL DEFAULT 1,tools_enabled boolean NOT NULL DEFAULT false,memory_enabled boolean NOT NULL DEFAULT false,instruction text NOT NULL DEFAULT '',PRIMARY KEY(room_id,actor_id));
ALTER TABLE runs ADD COLUMN group_snapshot jsonb;
