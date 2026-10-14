import type pg from 'pg';
import type { DB } from '../../db/index.js';
import type { RouteCommand } from '../../../../contracts/src/spec.js';
import { AppError } from '../../security.js';
import { command } from '../commands/index.js';
import { emit } from '../sync/index.js';

export async function listModelRoutes(db: DB, owner: string) {
  return (
    await db.query(
      'SELECT id,subject_id,subject_kind,capability,state,provider_id,revision FROM model_routes WHERE owner_id=$1 ORDER BY subject_id,capability',
      [owner],
    )
  ).rows;
}
export async function saveModelRoute(
  db: pg.Pool,
  owner: string,
  input: RouteCommand,
) {
  return command(
    db,
    owner,
    'model-route.save',
    input.operation_id,
    input,
    async (tx) => {
      if (input.subject_kind === 'owner') {
        if (input.subject_id !== owner)
          throw new AppError(404, 'not_found', 'Owner not found');
      } else if (
        !(
          await tx.query(
            'SELECT id FROM world_characters WHERE owner_id=$1 AND id=$2 AND NOT deleted',
            [owner, input.subject_id],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Actor not found');
      const previous = (
        await tx.query(
          'SELECT revision FROM model_routes WHERE owner_id=$1 AND subject_id=$2 AND capability=$3',
          [owner, input.subject_id, input.capability],
        )
      ).rows[0];
      if ((previous?.revision ?? 0) !== input.expected_revision)
        throw new AppError(
          409,
          'revision_conflict',
          'Route changed; reload and preserve your draft',
        );
      if (
        input.route.state === 'override' &&
        !(
          await tx.query(
            'SELECT id FROM provider_connections WHERE owner_id=$1 AND id=$2',
            [owner, input.route.provider_id],
          )
        ).rowCount
      )
        throw new AppError(404, 'not_found', 'Provider not found');
      const row = (
        await tx.query(
          `INSERT INTO model_routes(owner_id,subject_id,subject_kind,capability,state,provider_id,revision) VALUES($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT(owner_id,subject_id,capability) DO UPDATE SET state=$5,provider_id=$6,revision=model_routes.revision+1,updated_at=now()
       RETURNING id,subject_id,subject_kind,capability,state,provider_id,revision`,
          [
            owner,
            input.subject_id,
            input.subject_kind,
            input.capability,
            input.route.state,
            input.route.state === 'override' ? input.route.provider_id : null,
          ],
        )
      ).rows[0];
      // Routes are independently revisioned; an in-flight run retains its snapshot.
      await emit(tx, owner, 'model_route', row.id, row);
      return row;
    },
  );
}

export type Route = {
  state: 'inherit' | 'override' | 'disabled';
  provider_id?: string | null;
  revision: number;
};
/** Explicit disabled is terminal and never falls through to any default. */
export function resolveRoute(
  actor: Route | undefined,
  global: Route | undefined,
  legacyProvider?: string,
) {
  for (const [source, route] of [
    ['actor', actor],
    ['owner', global],
  ] as const) {
    if (route && route.state !== 'inherit')
      return {
        state: route.state,
        provider_id: route.state === 'override' ? route.provider_id : null,
        source,
        revision: route.revision,
      };
  }
  return {
    state: legacyProvider ? 'override' : 'unconfigured',
    provider_id: legacyProvider ?? null,
    source: legacyProvider ? 'legacy_room' : 'none',
    revision: 0,
  };
}

/** Called inside claim's transaction. Resolves once per actor step and survives restart. */
export async function claimProvider(
  db: DB,
  run: any,
  room: any,
  actor: string | null,
) {
  let snapshot = (
    await db.query(
      'SELECT data FROM run_route_snapshots WHERE run_id=$1 AND step_index=$2',
      [run.id, run.step_index],
    )
  ).rows[0]?.data;
  if (!snapshot) {
    const routes = await listModelRoutes(db, run.owner_id);
    const route = resolveRoute(
      routes.find((r) => r.subject_id === actor && r.capability === 'chat'),
      routes.find(
        (r) => r.subject_id === run.owner_id && r.capability === 'chat',
      ),
      room.provider_id,
    );
    if (route.state === 'disabled')
      throw new AppError(409, 'capability_disabled', 'Chat route disabled');
    const p = (
      await db.query(
        'SELECT * FROM provider_connections WHERE owner_id=$1 AND id=$2',
        [run.owner_id, route.provider_id],
      )
    ).rows[0];
    if (!p)
      throw new AppError(409, 'provider_missing', 'Configure a chat provider');
    snapshot = {
      id: p.id,
      revision: p.revision,
      base_url: p.base_url,
      protocol: p.protocol,
      model: p.model,
      context_window: p.context_window,
      max_output_tokens: p.max_output_tokens,
      tools_enabled: p.tools_enabled,
      vision_enabled: p.vision_enabled ?? false,
      route,
      actor_id: actor,
    };
    await db.query(
      'INSERT INTO run_route_snapshots(run_id,step_index,provider_id,data) VALUES($1,$2,$3,$4)',
      [run.id, run.step_index, p.id, snapshot],
    );
  }
  const current = (
    await db.query(
      'SELECT revision,credential FROM provider_connections WHERE owner_id=$1 AND id=$2',
      [run.owner_id, snapshot.id],
    )
  ).rows[0];
  // Never send a replacement credential to an endpoint frozen before a connection edit.
  if (!current || current.revision !== snapshot.revision)
    throw new AppError(
      409,
      'provider_changed',
      'Connection changed during this turn',
    );
  if (!current.credential?.data)
    throw new AppError(
      409,
      'credential_required',
      'Configure credentials after restore',
    );
  return { ...snapshot, credential: current.credential };
}
