import { AppError } from '../../security.js';
import { memoryActor } from '../memory/materials.js';
import { policies, backgroundAllowed } from '../autonomy/policy.js';
import type { DB } from '../../db/index.js';
export async function validSchedule(db: DB, run: any) {
  if (!run.schedule_id) return true;
  return !!(
    await db.query(
      "SELECT 1 FROM schedules WHERE id=$1 AND owner_id=$2 AND revision=$3 AND epoch=$4 AND executor IN ('cloud','device')",
      [
        run.schedule_id,
        run.owner_id,
        run.schedule_revision,
        run.schedule_epoch,
      ],
    )
  ).rowCount;
}

export async function requireScheduledAuthority(
  db: DB,
  owner: string,
  actor: string,
) {
  const a = await memoryActor(db, owner, actor);
  const { g, p } = await policies(db, owner, a.world_id, true);
  if (!backgroundAllowed(g, p, 'contact'))
    throw new AppError(
      403,
      'autonomy_disabled',
      'Scheduled execution permission revoked',
    );
}
