import type pg from 'pg';
import { AppError } from '../../security.js';
import type { Config } from '../../config.js';
import { command } from '../commands/index.js';
import { streamModel, ModelError } from '../llm/index.js';
export async function probeProvider(
  db: pg.Pool,
  config: Config,
  owner: string,
  id: string,
  input: {
    operation_id: string;
    expected_revision: number;
    confirm_billable: boolean;
  },
) {
  if (!input.confirm_billable)
    throw new AppError(
      400,
      'confirmation_required',
      'Explicit billable probe confirmation required',
    );
  const ack = await command(
    db,
    owner,
    'provider.probe',
    input.operation_id,
    { id, ...input },
    async (tx) => {
      const p = (
        await tx.query(
          'SELECT revision FROM provider_connections WHERE owner_id=$1 AND id=$2',
          [owner, id],
        )
      ).rows[0];
      if (!p) throw new AppError(404, 'not_found', 'Provider not found');
      if (p.revision !== input.expected_revision)
        throw new AppError(409, 'revision_conflict', 'Provider changed');
      await tx.query(
        'INSERT INTO usage_daily(owner_id,day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING',
        [owner],
      );
      if (
        !(
          await tx.query(
            'UPDATE usage_daily SET requests=requests+1 WHERE owner_id=$1 AND day=CURRENT_DATE AND requests<$2',
            [owner, config.dailyRequestLimit],
          )
        ).rowCount
      )
        throw new AppError(
          429,
          'request_budget_exceeded',
          'Daily request limit reached',
        );
      return (
        await tx.query(
          'INSERT INTO provider_probes(owner_id,provider_id,provider_revision) VALUES($1,$2,$3) RETURNING id',
          [owner, id, p.revision],
        )
      ).rows[0];
    },
  );
  const start = await db.query(
    "UPDATE provider_probes SET state='running' WHERE id=$1 AND state='pending' RETURNING *",
    [ack.id],
  );
  if (start.rowCount) {
    const p = (
      await db.query(
        'SELECT * FROM provider_connections WHERE owner_id=$1 AND id=$2',
        [owner, id],
      )
    ).rows[0];
    let state = 'failed',
      code: string | null = 'provider_changed',
      usage: unknown = null;
    if (p?.revision === input.expected_revision)
      try {
        const result = await streamModel(
          {
            provider: { ...p, max_output_tokens: 16, tools_enabled: false },
            run: { owner_id: owner },
            messages: [{ role: 'user', content: 'Reply OK.' }],
          },
          config,
          AbortSignal.timeout(15000),
          async () => {},
        );
        state = 'succeeded';
        code = null;
        usage = result.usage;
      } catch (e) {
        code = e instanceof ModelError ? e.code : 'probe_failed';
        state =
          code.startsWith('model_http_') || code === 'invalid_endpoint'
            ? 'failed'
            : 'unknown';
      }
    await db.query(
      'UPDATE provider_probes SET state=$2,error_code=$3,usage=$4,finished_at=now() WHERE id=$1',
      [ack.id, state, code, JSON.stringify(usage)],
    );
  }
  const r = (
    await db.query(
      'SELECT * FROM provider_probes WHERE owner_id=$1 AND id=$2',
      [owner, ack.id],
    )
  ).rows[0];
  // A crash after dispatch is never inferred to be a rejection or retried.
  return { ...r, state: r.state === 'running' ? 'unknown' : r.state };
}
