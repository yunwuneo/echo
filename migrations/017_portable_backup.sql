CREATE TABLE backup_origins(owner_id uuid NOT NULL REFERENCES owners(id),source_instance uuid NOT NULL,table_name text NOT NULL,source_key text NOT NULL,target_key jsonb NOT NULL,baseline_hash text NOT NULL,PRIMARY KEY(owner_id,source_instance,table_name,source_key));
CREATE TABLE restore_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES owners(id),fingerprint text NOT NULL,package jsonb NOT NULL,preview jsonb NOT NULL,state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','completed')),report jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_id,fingerprint));
-- Restoring an authenticated package preserves selected versions verbatim.
-- This is a transaction-local server setting, never an input field or SQL endpoint.
DROP TRIGGER message_version_capture ON messages;
CREATE TRIGGER message_version_capture BEFORE INSERT OR UPDATE ON messages FOR EACH ROW
WHEN (current_setting('echo.restore',true) IS DISTINCT FROM 'on') EXECUTE FUNCTION capture_message_version();
-- Relationship validation is deferred only by the restore transaction, so cycles
-- (selected versions, regeneration provenance) remain checked at commit.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint
 WHERE contype='f' AND connamespace=current_schema()::regnamespace AND NOT condeferrable
 AND conrelid IN (SELECT business.oid FROM pg_class business WHERE business.relnamespace=current_schema()::regnamespace AND business.relname=ANY(ARRAY['worlds','world_characters','rooms','runs','messages','message_versions','world_leases','character_templates','character_versions','room_memberships','lore_entries','world_state','world_events','background_usage','message_audiences','memories','memory_evidence','memory_revisions','memory_tombstones','message_dependencies','memory_settings','lore_activations','lore_commits','import_jobs','mcp_connections','tool_grants','tool_calls','autonomy_settings','autonomy_policies','assets','asset_references','model_routes','conversation_defaults','conversation_inputs','conversation_branches','prompt_presets','prompt_profiles','projects','documents','document_versions','document_assets','document_version_assets','privacy_deletions','usage_ledger','usage_daily','background_daily','background_scopes','autonomy_daily','provider_connections','configuration_revisions']))
 LOOP EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',c.tbl,c.conname); END LOOP;
END $$;
