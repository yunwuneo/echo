import type { DB } from '../../db/index.js';
/** Unresolved effects outlive their source messages and must remain reconcilable. */
export async function unresolvedEffects(db: DB, owner: string, id: string) {
  return (
    await db.query(
      `
    SELECT 'host' kind,j.id,j.state FROM host_jobs j JOIN host_identity_links l ON l.id=j.link_id JOIN world_characters a ON a.id=l.actor_id LEFT JOIN runs r ON r.id=j.relay_run_id LEFT JOIN schedules s ON s.id=j.schedule_id WHERE j.owner_id=$1 AND (a.id=$2 OR a.world_id=$2 OR r.room_id=$2 OR s.room_id=$2) AND j.state IN ('accepted','executing','unknown')
    UNION ALL SELECT 'system',j.id,j.state FROM system_actions j JOIN world_characters a ON a.id=j.actor_id WHERE j.owner_id=$1 AND (a.id=$2 OR a.world_id=$2) AND j.state IN ('executing','unknown')
    UNION ALL SELECT 'tool',j.id,j.state FROM tool_calls j JOIN runs r ON r.id=j.run_id WHERE j.owner_id=$1 AND (j.actor_id=$2 OR r.world_id=$2 OR r.room_id=$2) AND j.state IN ('executing','outcome_unknown')
    UNION ALL SELECT 'media',j.id,j.state FROM media_jobs j WHERE j.owner_id=$1 AND (j.actor_id=$2 OR j.world_id=$2 OR j.input->>'room_id'=$2::text) AND j.state IN ('queued','submitting','polling','accepted','processing','unknown')
    ORDER BY kind,id`,
      [owner, id],
    )
  ).rows;
}
