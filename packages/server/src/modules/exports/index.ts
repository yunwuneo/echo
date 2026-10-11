import { canonical } from '../mcp/schema.js';
import type pg from 'pg';
import { transaction } from '../../db/index.js';
import { AppError, hash } from '../../security.js';
// A portable, inspectable owner archive. Operational restore uses the separate
// pg_dump bundle, never these public API rows and never a public restore endpoint.
const tables: Record<string, string> = {
  worlds: 'owner_id',
  rooms: 'owner_id',
  character_templates: 'owner_id',
  character_versions: 'owner_id',
  world_characters: 'owner_id',
  lore_entries: 'owner_id',
  world_state: 'owner_id',
  world_events: 'owner_id',
  messages: 'owner_id',
  runs: 'owner_id',
  memories: 'owner_id',
  memory_settings: 'owner_id',
  memory_tombstones: 'owner_id',
  autonomy_settings: 'owner_id',
  autonomy_policies: 'owner_id',
  tool_grants: 'owner_id',
  usage_ledger: 'owner_id',
  background_usage: 'owner_id',
};
export async function exportOwner(db: pg.Pool, owner: string) {
  return transaction(
    db,
    async (tx) => {
      const sections: Record<string, unknown[]> = {};
      let bytes = 0;
      async function add(table: string, sql: string) {
        const cursor = 'export_' + table;
        await tx.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`, [
          owner,
        ]);
        const collected: unknown[] = [];
        try {
          while (true) {
            const rows = (await tx.query(`FETCH FORWARD 100 FROM ${cursor}`))
              .rows;
            if (!rows.length) break;
            bytes += Buffer.byteLength(JSON.stringify(rows));
            if (bytes > 32 * 1024 * 1024)
              throw new AppError(
                413,
                'export_too_large',
                'Use the offline backup tool for archives above 32 MiB',
              );
            collected.push(...rows);
          }
        } finally {
          await tx.query(`CLOSE ${cursor}`);
        }
        sections[table] = collected;
      }
      for (const [table, column] of Object.entries(tables))
        await add(
          table,
          `SELECT * FROM ${table} WHERE ${column}=$1 ORDER BY 1`,
        );
      await add(
        'provider_connections',
        'SELECT id,name,base_url,model,context_window,max_output_tokens,tools_enabled FROM provider_connections WHERE owner_id=$1 ORDER BY id',
      );
      await add(
        'mcp_connections',
        'SELECT id,name,url,transport,auth_type,header_name,enabled,revision,private_addresses FROM mcp_connections WHERE owner_id=$1 ORDER BY id',
      );
      await add(
        'room_memberships',
        'SELECT rm.* FROM room_memberships rm JOIN rooms r ON r.id=rm.room_id WHERE r.owner_id=$1 ORDER BY rm.room_id,rm.actor_id',
      );
      await add(
        'message_audiences',
        'SELECT a.* FROM message_audiences a JOIN messages m ON m.id=a.message_id WHERE m.owner_id=$1 ORDER BY a.message_id,a.actor_id',
      );
      await add(
        'memory_evidence',
        'SELECT e.* FROM memory_evidence e JOIN memories m ON m.id=e.memory_id WHERE m.owner_id=$1 ORDER BY e.memory_id',
      );
      await add(
        'memory_revisions',
        'SELECT e.* FROM memory_revisions e JOIN memories m ON m.id=e.memory_id WHERE m.owner_id=$1 ORDER BY e.memory_id,e.revision',
      );
      await add(
        'imports',
        "SELECT id,world_id,file_hash,adapter_version,format,encode(raw,'base64') AS raw_base64,result FROM import_jobs WHERE owner_id=$1 ORDER BY id",
      );
      const data = JSON.parse(
        JSON.stringify({ owner_id: owner, sections }),
      ) as { owner_id: string; sections: Record<string, unknown[]> };
      return {
        format: 'echo-owner-export',
        format_version: 1,
        created_at: new Date().toISOString(),
        checksum_algorithm: 'sha256-canonical-json-v1',
        checksum: hash(canonical(data)),
        data,
      };
    },
    'ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}
