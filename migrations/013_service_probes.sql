CREATE TABLE provider_probes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES owners(id),
 provider_id uuid NOT NULL, provider_revision integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded','failed','unknown')),
 error_code text, usage jsonb, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(owner_id,provider_id) REFERENCES provider_connections(owner_id,id)
);
