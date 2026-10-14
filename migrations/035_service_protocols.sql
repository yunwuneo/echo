ALTER TABLE provider_connections ADD COLUMN protocol text NOT NULL DEFAULT 'openai' CHECK(protocol IN ('openai','claude','gemini','vertex'));
