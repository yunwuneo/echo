ALTER TABLE instance_metadata ADD COLUMN maintenance boolean NOT NULL DEFAULT false;
CREATE TABLE worker_health (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), seen_at timestamptz NOT NULL);
CREATE TABLE notification_bindings (
 device_id uuid PRIMARY KEY, owner_id uuid NOT NULL, challenge_hash text, challenge_expires_at timestamptz,
 ticket jsonb, enabled boolean NOT NULL DEFAULT false, expires_at timestamptz,
 revision integer NOT NULL DEFAULT 1, relay_url text, topic text, environment text,
 FOREIGN KEY(owner_id,device_id) REFERENCES devices(owner_id,id)
);
CREATE TABLE notification_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES owners(id),
 message_id uuid NOT NULL UNIQUE REFERENCES messages(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES notification_events(id),
 device_id uuid NOT NULL REFERENCES devices(id), binding_revision integer NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','failed','suppressed','unknown')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 error_code text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,device_id)
);
CREATE INDEX notification_dispatch ON notification_deliveries(state,next_attempt_at);
CREATE TABLE notification_revocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL, owner_id uuid NOT NULL REFERENCES owners(id),
 ticket jsonb NOT NULL, relay_url text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE privacy_deletions (
 owner_id uuid NOT NULL REFERENCES owners(id), entity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('message','memory')), deleted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,kind,entity_id)
);
-- Preserve deletion IDs already visible in pre-P5 state; no erased body is copied.
INSERT INTO privacy_deletions(owner_id,entity_id,kind) SELECT owner_id,id,'memory' FROM memories WHERE status IN ('deleted','invalidated');
INSERT INTO privacy_deletions(owner_id,entity_id,kind) SELECT owner_id,id,'message' FROM messages WHERE status='invalidated' AND content='';
