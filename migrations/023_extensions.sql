ALTER TABLE mcp_connections ADD COLUMN handle text;
UPDATE mcp_connections SET handle=id::text;
ALTER TABLE mcp_connections ALTER COLUMN handle SET NOT NULL;
ALTER TABLE mcp_connections ALTER COLUMN handle SET DEFAULT gen_random_uuid()::text;
ALTER TABLE mcp_connections ADD UNIQUE(owner_id,handle);
CREATE TABLE extension_installs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id),manifest jsonb NOT NULL,resources jsonb NOT NULL,state text NOT NULL DEFAULT 'installed',revision integer NOT NULL DEFAULT 1,adopted_connections uuid[] NOT NULL DEFAULT '{}',owned_connections uuid[] NOT NULL DEFAULT '{}',late_receipts jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE skill_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id),install_id uuid NOT NULL REFERENCES extension_installs(id) DEFERRABLE,actor_id uuid NOT NULL REFERENCES world_characters(id) DEFERRABLE,mode text NOT NULL CHECK(mode IN ('off','manual','candidate','auto')),revision integer NOT NULL DEFAULT 1,UNIQUE(install_id,actor_id));
CREATE TABLE run_skill_refs(run_id uuid NOT NULL REFERENCES runs(id) DEFERRABLE,install_id uuid NOT NULL REFERENCES extension_installs(id) DEFERRABLE,actor_id uuid NOT NULL REFERENCES world_characters(id) DEFERRABLE,PRIMARY KEY(run_id,install_id,actor_id));
