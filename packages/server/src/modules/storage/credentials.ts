import { emit } from '../sync/index.js';
import { providerView } from '../providers/index.js';
import { connectionView } from '../mcp/connections.js';
import type pg from 'pg';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import { AppError, encrypt, decrypt, hash } from '../../security.js';
import { canonical } from '../mcp/schema.js';
import { command } from '../commands/index.js';
const fail = () =>
  new AppError(
    409,
    'credential_import_conflict',
    'Credential identity or selected revision changed',
  );
const tables = {
  provider: 'provider_connections',
  mcp: 'mcp_connections',
} as const;
function identity(kind: string, r: any) {
  return kind === 'provider'
    ? { base_url: r.base_url, model: r.model, protocol: r.protocol }
    : { url: r.url, auth_type: r.auth_type, header_name: r.header_name };
}
export async function credentialCommand(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
): Promise<any> {
  const p = input.payload;
  if (input.command === 'exportSelectedCredentials') {
    const items: any[] = [];
    for (const selection of p.selections) {
      const r = (
        await db.query(
          'SELECT * FROM ' +
            tables[selection.kind as keyof typeof tables] +
            ' WHERE id=$1 AND owner_id=$2',
          [selection.id, owner],
        )
      ).rows[0];
      if (!r || !r.credential?.data) throw fail();
      items.push({
        kind: selection.kind,
        id: r.id,
        name: r.name,
        identity: identity(selection.kind, r),
        secret: decrypt(
          r.credential,
          config,
          selection.kind === 'provider'
            ? owner + ':' + r.id
            : owner + ':mcp:' + r.id,
        ),
      });
    }
    const salt = randomBytes(16).toString('base64'),
      key = scryptSync(p.password, Buffer.from(salt, 'base64'), 32);
    try {
      return {
        format: 'echo-credentials',
        version: 1,
        salt,
        payload: encrypt(
          JSON.stringify({ items }),
          { masterKey: key, keyVersion: 1 } as Config,
          'echo-credentials-v1',
        ),
      };
    } finally {
      key.fill(0);
    }
  }
  if (input.command === 'previewSelectedCredentials') {
    const a = p.archive;
    if (
      a?.format !== 'echo-credentials' ||
      a.version !== 1 ||
      Buffer.from(a.salt ?? '', 'base64').length !== 16 ||
      JSON.stringify(a).length > 131072
    )
      throw fail();
    const key = scryptSync(p.password, Buffer.from(a.salt, 'base64'), 32);
    let pack: any;
    try {
      pack = JSON.parse(
        decrypt(
          a.payload,
          { masterKey: key, keyVersion: 1 } as Config,
          'echo-credentials-v1',
        ),
      );
    } finally {
      key.fill(0);
    }
    if (!Array.isArray(pack.items) || pack.items.length > 100) throw fail();
    const preview: any[] = [];
    for (const item of pack.items) {
      if (
        !['provider', 'mcp'].includes(item.kind) ||
        typeof item.secret !== 'string' ||
        item.secret.length > 16000
      )
        throw fail();
      const r = (
        await db.query(
          'SELECT * FROM ' +
            tables[item.kind as keyof typeof tables] +
            ' WHERE id=$1 AND owner_id=$2',
          [item.id, owner],
        )
      ).rows[0];
      if (!r || canonical(identity(item.kind, r)) !== canonical(item.identity))
        throw fail();
      preview.push({
        kind: item.kind,
        id: item.id,
        name: r.name,
        identity: item.identity,
        revision: r.revision,
      });
    }
    const id = randomUUID(),
      token = hash(canonical(preview));
    await db.query(
      "DELETE FROM credential_import_sessions WHERE owner_id=$1 AND created_at<now()-interval '1 hour'",
      [owner],
    );
    if (
      (
        await db.query(
          'SELECT count(*)::int n FROM credential_import_sessions WHERE owner_id=$1',
          [owner],
        )
      ).rows[0].n >= 5
    )
      throw new AppError(
        409,
        'credential_preview_limit',
        'Finish current previews or wait one hour',
      );
    await db.query(
      'INSERT INTO credential_import_sessions(id,owner_id,package,preview,token) VALUES($1,$2,$3,$4,$5)',
      [
        id,
        owner,
        JSON.stringify(
          encrypt(
            JSON.stringify(pack),
            config,
            owner + ':credential-import:' + id,
          ),
        ),
        JSON.stringify(preview),
        token,
      ],
    );
    return { id, preview_token: token, items: preview };
  }
  return command(
    db,
    owner,
    'credentials.import',
    input.operation_id,
    input,
    async (tx) => {
      const session = (
        await tx.query(
          "SELECT * FROM credential_import_sessions WHERE id=$1 AND owner_id=$2 AND created_at>now()-interval '1 hour' FOR UPDATE",
          [p.id, owner],
        )
      ).rows[0];
      if (!session || session.token !== p.preview_token) throw fail();
      const pack = JSON.parse(
        decrypt(session.package, config, owner + ':credential-import:' + p.id),
      );
      for (const selected of p.selections) {
        const item = pack.items.find(
            (x: any) => x.id === selected.id && x.kind === selected.kind,
          ),
          prior = session.preview.find(
            (x: any) => x.id === selected.id && x.kind === selected.kind,
          );
        if (!item || !prior) throw fail();
        const table = tables[selected.kind as keyof typeof tables],
          r = (
            await tx.query(
              'SELECT * FROM ' +
                table +
                ' WHERE id=$1 AND owner_id=$2 FOR UPDATE',
              [selected.id, owner],
            )
          ).rows[0];
        if (
          !r ||
          r.revision !== prior.revision ||
          canonical(identity(selected.kind, r)) !== canonical(item.identity)
        )
          throw fail();
        const credential = encrypt(
          item.secret,
          config,
          selected.kind === 'provider'
            ? owner + ':' + r.id
            : owner + ':mcp:' + r.id,
        );
        await tx.query(
          'UPDATE ' +
            table +
            ' SET credential=$2,revision=revision+1' +
            (selected.kind === 'mcp'
              ? ",enabled=false,tools='[]',discovered_at=NULL"
              : '') +
            ' WHERE id=$1',
          [r.id, JSON.stringify(credential)],
        );
        const changed = (
          await tx.query('SELECT * FROM ' + table + ' WHERE id=$1', [r.id])
        ).rows[0];
        await emit(
          tx,
          owner,
          selected.kind === 'provider' ? 'provider' : 'mcp_connection',
          r.id,
          selected.kind === 'provider'
            ? providerView(changed)
            : connectionView(changed),
        );
      }
      await tx.query('DELETE FROM credential_import_sessions WHERE id=$1', [
        session.id,
      ]);
      return { imported: p.selections.length, connections_tested: false };
    },
  );
}
