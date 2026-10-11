CREATE SCHEMA IF NOT EXISTS push_relay;
CREATE TABLE IF NOT EXISTS push_relay.metadata (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), key_check jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS push_relay.invitations (hash text PRIMARY KEY, topic text NOT NULL, environment text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE IF NOT EXISTS push_relay.tickets (
 hash text PRIMARY KEY, binding jsonb NOT NULL, topic text NOT NULL, environment text NOT NULL, apns_token jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS push_relay.deliveries (
 id uuid PRIMARY KEY, ticket_hash text NOT NULL REFERENCES push_relay.tickets(hash), event_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'sending', invalid_token boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_relay.limits (key text PRIMARY KEY, window_start timestamptz NOT NULL DEFAULT now(), count integer NOT NULL DEFAULT 1);
