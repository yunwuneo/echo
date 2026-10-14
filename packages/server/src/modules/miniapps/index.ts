import type pg from 'pg';
import { Agent, fetch } from 'undici';
import type { Config } from '../../config.js';
import { AppError, hash, resolveEndpoint } from '../../security.js';
import { command } from '../commands/index.js';
import { matchRevision } from '../worlds/index.js';
import { memoryActor } from '../memory/materials.js';
import { canonical } from '../mcp/schema.js';
import { runPython } from './python.js';
const fail = (code = 'permission_denied') =>
  new AppError(409, code, 'Runtime permission, state or session changed');
const size = (value: unknown) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576)
    throw fail('runtime_state_limit');
};
export async function runtimeNetwork(
  db: pg.Pool,
  config: Config,
  owner: string,
  session: string,
  url: string,
) {
  const s = (
    await db.query(
      "SELECT s.*,a.run_enabled,a.revision FROM runtime_sessions s JOIN miniapps a ON a.id=s.app_id WHERE s.id=$1 AND s.owner_id=$2 AND s.status IN ('open','executing') AND s.expires_at>now()",
      [session, owner],
    )
  ).rows[0];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw fail();
  }
  if (
    !s?.run_enabled ||
    s.app_revision !== s.revision ||
    !s.network.includes(u.origin) ||
    u.username ||
    u.password
  )
    throw fail();
  const { base, addresses } = await resolveEndpoint(u.origin, config);
  const dispatcher = new Agent({
    connect: {
      lookup: (_h, options, cb) => {
        const a = addresses[0]!;
        cb(null, options.all ? addresses : a.address, a.family);
      },
    },
  });
  try {
    const r = await fetch(base + u.pathname + u.search, {
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw fail('network_failed');
    let body = '';
    if (r.body)
      for await (const chunk of r.body) {
        body += Buffer.from(chunk).toString('utf8');
        if (Buffer.byteLength(body) > 65536) throw fail('network_limit');
      }
    return body;
  } finally {
    await dispatcher.close();
  }
}
export async function miniappCommand(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
) {
  const p = input.payload;
  if (p.session_id) {
    const a = (
      await db.query(
        'SELECT m.actor_id FROM runtime_sessions s JOIN miniapps m ON m.id=s.app_id WHERE s.id=$1 AND s.owner_id=$2',
        [p.session_id, owner],
      )
    ).rows[0];
    if (!a) throw fail();
    if (input.command !== 'closeRuntime')
      await memoryActor(db, owner, a.actor_id);
  }
  if (input.command === 'appLibrary')
    return {
      conflicts: (
        await db.query(
          'SELECT * FROM runtime_conflicts WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
      apps: (
        await db.query(
          'SELECT * FROM miniapps WHERE owner_id=$1 ORDER BY title,id',
          [owner],
        )
      ).rows,
    };
  if (input.command === 'runtimeRequest')
    return runtimeNetwork(db, config, owner, p.session_id, p.url);
  if (input.command === 'runPython') {
    const session = (
      await db.query(
        "UPDATE runtime_sessions s SET status='executing',input_hash=$3 FROM miniapps a WHERE s.id=$1 AND s.owner_id=$2 AND s.app_id=a.id AND s.status='open' AND s.expires_at>now() AND a.run_enabled AND a.revision=s.app_revision AND a.language='python' RETURNING s.*,a.source",
        [p.session_id, owner, hash(canonical(p.input))],
      )
    ).rows[0];
    if (!session) {
      const old = (
        await db.query(
          'SELECT status,result,error_code,input_hash FROM runtime_sessions WHERE id=$1 AND owner_id=$2',
          [p.session_id, owner],
        )
      ).rows[0];
      if (old) {
        if (old.input_hash && old.input_hash !== hash(canonical(p.input)))
          throw fail('operation_conflict');
        return old.result ?? old;
      }
      throw fail();
    }
    // A session is single-use for execution; a lost response is not rerun automatically.
    try {
      const result = await runPython(session.source, p.input, (url) =>
        runtimeNetwork(db, config, owner, session.id, url),
      );
      await db.query(
        "UPDATE runtime_sessions SET status='finished',network='[]',result=$2 WHERE id=$1",
        [session.id, JSON.stringify(result)],
      );
      return result;
    } catch (e) {
      await db.query(
        "UPDATE runtime_sessions SET status='failed',network='[]',error_code=$2 WHERE id=$1",
        [session.id, e instanceof AppError ? e.code : 'runtime_failed'],
      );
      throw e;
    }
  }
  return command(
    db,
    owner,
    input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (['saveMiniApp', 'importMiniApp'].includes(input.command)) {
        await memoryActor(tx, owner, p.actor_id);
        size(p.resources);
        size(p.source);
        for (const path of Object.keys(p.resources))
          if (
            !/^[a-zA-Z0-9_./-]+$/.test(path) ||
            path.startsWith('/') ||
            path.split('/').some((v) => v === '..' || v === '')
          )
            throw fail('invalid_resource');
        if (p.id) {
          const old = (
            await tx.query(
              'SELECT * FROM miniapps WHERE id=$1 AND owner_id=$2 FOR UPDATE',
              [p.id, owner],
            )
          ).rows[0];
          if (!old) throw fail();
          matchRevision(old, input.expected_revision);
          if (old.actor_id !== p.actor_id) throw fail();
          return (
            await tx.query(
              'UPDATE miniapps SET title=$3,source=$4,resources=$5,language=$6,revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING *',
              [
                p.id,
                owner,
                p.title,
                p.source,
                JSON.stringify(p.resources),
                p.language,
              ],
            )
          ).rows[0];
        }
        return (
          await tx.query(
            'INSERT INTO miniapps(owner_id,actor_id,title,language,source,resources) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [
              owner,
              p.actor_id,
              p.title,
              p.language,
              p.source,
              JSON.stringify(p.resources),
            ],
          )
        ).rows[0];
      }
      if (
        ['commitRuntimeState', 'closeRuntime', 'grantSessionNetwork'].includes(
          input.command,
        )
      ) {
        const s = (
          await tx.query(
            'SELECT * FROM runtime_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.session_id, owner],
          )
        ).rows[0];
        if (!s) throw fail();
        if (input.command === 'closeRuntime') {
          await tx.query(
            "UPDATE runtime_sessions SET status='closed',network='[]' WHERE id=$1",
            [s.id],
          );
          return { closed: true };
        }
        const a = (
          await tx.query('SELECT * FROM miniapps WHERE id=$1 FOR UPDATE', [
            s.app_id,
          ])
        ).rows[0];
        if (
          s.status !== 'open' ||
          new Date(s.expires_at).getTime() < Date.now() ||
          !a.run_enabled ||
          a.revision !== s.app_revision
        )
          throw fail();
        if (input.command === 'grantSessionNetwork') {
          if (s.principal !== 'owner') throw fail();
          const origins = p.origins.map((v: string) => {
            const u = new URL(v);
            if (
              u.protocol !== 'https:' ||
              u.origin !== v ||
              u.username ||
              u.password
            )
              throw fail('invalid_origin');
            return u.origin;
          });
          await tx.query('UPDATE runtime_sessions SET network=$2 WHERE id=$1', [
            s.id,
            JSON.stringify(origins),
          ]);
          return { origins };
        }
        size(p.state);
        if (!a.persistence || (s.principal === 'ai' && a.ai_state !== 'write'))
          return { saved: false, state_revision: a.state_revision };
        if (
          a.state_revision !== input.expected_revision ||
          s.state_revision !== input.expected_revision
        ) {
          const c = (
            await tx.query(
              'INSERT INTO runtime_conflicts(owner_id,app_id,base_revision,state) VALUES($1,$2,$3,$4) RETURNING id',
              [owner, a.id, input.expected_revision, JSON.stringify(p.state)],
            )
          ).rows[0];
          return {
            saved: false,
            conflict_id: c.id,
            state_revision: a.state_revision,
          };
        }
        const changed = (
          await tx.query(
            'UPDATE miniapps SET state=$2,state_revision=state_revision+1 WHERE id=$1 RETURNING state_revision',
            [a.id, JSON.stringify(p.state)],
          )
        ).rows[0];
        await tx.query(
          'UPDATE runtime_sessions SET state_revision=$2 WHERE id=$1',
          [s.id, changed.state_revision],
        );
        return { saved: true, ...changed };
      }
      const a = (
        await tx.query(
          'SELECT * FROM miniapps WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [p.id, owner],
        )
      ).rows[0];
      if (!a) throw fail();
      if (input.command === 'openRuntime')
        await memoryActor(tx, owner, a.actor_id);
      if (input.command === 'exportMiniApp')
        return {
          format: 'echo-miniapp',
          version: 1,
          title: a.title,
          language: a.language,
          source: a.source,
          resources: a.resources,
        };
      if (input.command === 'openRuntime') {
        if (!a.run_enabled) throw fail();
        const s = (
          await tx.query(
            'INSERT INTO runtime_sessions(owner_id,app_id,app_revision,principal,state_revision) VALUES($1,$2,$3,$4,$5) RETURNING *',
            [owner, a.id, a.revision, p.principal, a.state_revision],
          )
        ).rows[0];
        return {
          ...s,
          source: a.source,
          resources: a.resources,
          language: a.language,
          persistence: a.persistence,
          state:
            a.persistence && (p.principal === 'owner' || a.ai_state !== 'none')
              ? a.state
              : {},
        };
      }
      matchRevision(a, input.expected_revision);
      if (input.command === 'setAppPermissions')
        return (
          await tx.query(
            'UPDATE miniapps SET run_enabled=$2,persistence=$3,ai_state=$4,revision=revision+1 WHERE id=$1 RETURNING *',
            [a.id, p.run_enabled, p.persistence, p.ai_state],
          )
        ).rows[0];
      if (input.command === 'previewResetState')
        return {
          preview_token: hash(
            canonical({
              id: a.id,
              revision: a.revision,
              state_revision: a.state_revision,
              state: a.state,
            }),
          ),
        };
      if (input.command === 'resetRuntimeState') {
        if (
          p.preview_token !==
          hash(
            canonical({
              id: a.id,
              revision: a.revision,
              state_revision: a.state_revision,
              state: a.state,
            }),
          )
        )
          throw fail('revision_conflict');
        return (
          await tx.query(
            "UPDATE miniapps SET state='{}',state_revision=state_revision+1 WHERE id=$1 RETURNING state_revision",
            [a.id],
          )
        ).rows[0];
      }
      throw fail('invalid_command');
    },
  );
}
