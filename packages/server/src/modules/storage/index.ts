import { credentialCommand } from './credentials.js';
import { canonical } from '../mcp/schema.js';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { transaction } from '../../db/index.js';
import { randomUUID } from 'node:crypto';
import { AppError, hash, encrypt, decrypt } from '../../security.js';
import { command } from '../commands/index.js';
import { matchRevision } from '../worlds/index.js';
import { submitHostJobTx } from '../hosts/index.js';
import { exportBackup } from '../backups/index.js';
const fail = (code: string) =>
  new AppError(409, code, 'External storage scope or revision changed');
const budget = { max_output_tokens: 1, tool_limit: 0 };
export async function storageCommand(
  db: pg.Pool,
  config: Config,
  owner: string,
  input: any,
): Promise<any> {
  const p = input.payload;
  if (
    [
      'exportSelectedCredentials',
      'previewSelectedCredentials',
      'importSelectedCredentials',
    ].includes(input.command)
  )
    return credentialCommand(db, config, owner, input);
  if (input.command === 'externalStorageLibrary')
    return {
      documents: (
        await db.query('SELECT * FROM external_documents WHERE owner_id=$1', [
          owner,
        ])
      ).rows,
      plans: (
        await db.query(
          'SELECT id,link_id,root,cadence,keep_count,enabled,next_at,revision FROM remote_backup_plans WHERE owner_id=$1',
          [owner],
        )
      ).rows,
      backups: (
        await db.query(
          'SELECT id,plan_id,link_id,root,slot,content_hash,state,chunk_index,chunk_count,job_id,error_code,created_at FROM remote_backups WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
          [owner],
        )
      ).rows,
    };
  if (input.command === 'runRemoteBackup') {
    const b = await command(
      db,
      owner,
      'backup.remote.prepare',
      input.operation_id,
      input,
      async (tx) => {
        const plan = (
          await tx.query(
            'SELECT * FROM remote_backup_plans WHERE owner_id=$1 AND id=$2',
            [owner, p.id],
          )
        ).rows[0];
        if (!plan) throw fail('backup_plan_missing');
        matchRevision(plan, input.expected_revision);
        return (
          await tx.query(
            'INSERT INTO remote_backups(owner_id,plan_id,plan_revision,link_id,root,slot) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
            [
              owner,
              plan.id,
              plan.revision,
              plan.link_id,
              plan.root,
              input.operation_id,
            ],
          )
        ).rows[0];
      },
    );
    await prepareBackup(db, config, b.id);
    return { id: b.id };
  }
  return command(
    db,
    owner,
    'storage.' + input.command,
    input.operation_id,
    input,
    async (tx) => {
      if (input.command === 'pauseBackupPlan') {
        const plan = (
          await tx.query(
            'SELECT * FROM remote_backup_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE',
            [p.id, owner],
          )
        ).rows[0];
        if (!plan) throw fail('backup_plan_missing');
        matchRevision(plan, input.expected_revision);
        await tx.query(
          "UPDATE host_jobs SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'unknown' END,error_code='backup_paused',revision=revision+1 WHERE owner_id=$1 AND scope->>'backup_plan_id'=$2 AND state IN ('pending','accepted','executing')",
          [owner, plan.id],
        );
        await tx.query(
          "UPDATE remote_backups SET state='paused',error_code='backup_paused' WHERE plan_id=$1 AND state NOT IN ('completed','failed')",
          [plan.id],
        );
        return (
          await tx.query(
            'UPDATE remote_backup_plans SET enabled=false,revision=revision+1 WHERE id=$1 RETURNING id,revision,enabled,keep_count',
            [plan.id],
          )
        ).rows[0];
      }
      if (input.command === 'saveBackupPlan') {
        if (!['daily', 'weekly'].includes(p.cadence) || p.password.length < 12)
          throw fail('backup_plan_invalid');
        if (
          !(
            await tx.query(
              "SELECT 1 FROM host_identity_links l JOIN host_nodes h ON h.id=l.host_id WHERE l.id=$1 AND l.owner_id=$2 AND l.enabled AND h.revoked_at IS NULL AND h.grants->'roots' ? $3",
              [p.link_id, owner, p.root],
            )
          ).rowCount
        )
          throw fail('host_directory');
        const id = p.id ?? randomUUID();
        const secret = encrypt(
          p.password,
          config,
          owner + ':remote-backup:' + id,
        );
        if (p.id) {
          const old = (
            await tx.query(
              'SELECT * FROM remote_backup_plans WHERE id=$1 AND owner_id=$2 FOR UPDATE',
              [id, owner],
            )
          ).rows[0];
          matchRevision(old, input.expected_revision);
          return (
            await tx.query(
              'UPDATE remote_backup_plans SET link_id=$2,root=$3,cadence=$4,enabled=$5,password=$6,keep_count=$7,revision=revision+1 WHERE id=$1 RETURNING id,revision',
              [
                id,
                p.link_id,
                p.root,
                p.cadence,
                p.enabled,
                JSON.stringify(secret),
                p.keep_count ?? old.keep_count,
              ],
            )
          ).rows[0];
        }
        return (
          await tx.query(
            'INSERT INTO remote_backup_plans(id,owner_id,link_id,root,cadence,enabled,password,next_at,keep_count) VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id,revision',
            [
              id,
              owner,
              p.link_id,
              p.root,
              p.cadence,
              p.enabled,
              JSON.stringify(secret),
              p.keep_count ?? 0,
            ],
          )
        ).rows[0];
      }
      if (input.command === 'bindExternalDocument') {
        const doc = (
          await tx.query(
            'SELECT d.*,p.actor_id FROM documents d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND d.owner_id=$2',
            [p.document_id, owner],
          )
        ).rows[0];
        const link = (
          await tx.query(
            'SELECT * FROM host_identity_links WHERE id=$1 AND owner_id=$2 AND enabled',
            [p.link_id, owner],
          )
        ).rows[0];
        if (!doc || !link || link.actor_id !== doc.actor_id)
          throw fail('external_document_scope');
        return (
          await tx.query(
            'INSERT INTO external_documents(owner_id,actor_id,link_id,root,path,document_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
            [owner, doc.actor_id, p.link_id, p.root, p.path, doc.id],
          )
        ).rows[0];
      }
      const binding = (
        await tx.query(
          'SELECT * FROM external_documents WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [p.id, owner],
        )
      ).rows[0];
      if (!binding) throw fail('external_document_missing');
      matchRevision(binding, input.expected_revision);
      const doc = (
        await tx.query('SELECT * FROM documents WHERE id=$1 AND owner_id=$2', [
          binding.document_id,
          owner,
        ])
      ).rows[0];
      if (!doc) throw fail('external_document_missing');
      if (
        input.command === 'refreshExternalDocument' ||
        input.command === 'writeExternalDocument'
      ) {
        if (binding.job_id) {
          const prior = (
            await tx.query('SELECT state FROM host_jobs WHERE id=$1', [
              binding.job_id,
            ])
          ).rows[0];
          if (
            ['pending', 'accepted', 'executing', 'unknown'].includes(
              prior?.state,
            )
          )
            throw fail('reconciliation_required');
        }
        if (
          input.command === 'writeExternalDocument' &&
          binding.state !== 'ready'
        )
          throw fail('external_baseline_required');
        const write = input.command === 'writeExternalDocument';
        const job = await submitHostJobTx(
          tx,
          owner,
          {
            link_id: binding.link_id,
            kind: write ? 'file_write' : 'file_read',
            scope: { root: binding.root },
            payload: {
              path: binding.path,
              ...(write
                ? {
                    content_base64: Buffer.from(doc.content).toString('base64'),
                    base_hash: binding.baseline_hash,
                  }
                : {}),
            },
            budget,
          },
          input.operation_id,
        );
        return (
          await tx.query(
            'UPDATE external_documents SET job_id=$2,baseline_document_revision=$3,state=$4,revision=revision+1 WHERE id=$1 RETURNING *',
            [binding.id, job.id, doc.revision, write ? 'writing' : 'reading'],
          )
        ).rows[0];
      }
      if (input.command === 'reconcileExternalDocument') {
        const job = (
          await tx.query('SELECT * FROM host_jobs WHERE id=$1', [
            binding.job_id,
          ])
        ).rows[0];
        if (!job || job.state !== 'completed')
          throw fail('reconciliation_required');
        const result = job.result;
        if (
          result.conflict ||
          doc.revision !== binding.baseline_document_revision
        ) {
          return (
            await tx.query(
              "UPDATE external_documents SET state='conflict',conflict=$2,revision=revision+1 WHERE id=$1 RETURNING *",
              [
                binding.id,
                JSON.stringify({
                  external: result,
                  local_content: doc.content,
                  local_revision: doc.revision,
                }),
              ],
            )
          ).rows[0];
        }
        // Refresh captures a baseline without overwriting either source. A later explicit write uses that hash.
        if (
          result.content_base64 &&
          hash(Buffer.from(result.content_base64, 'base64')) !==
            result.content_hash
        )
          throw fail('external_hash');
        return (
          await tx.query(
            "UPDATE external_documents SET state='ready',baseline_hash=$2,conflict=$3,revision=revision+1 WHERE id=$1 RETURNING *",
            [
              binding.id,
              result.content_hash,
              JSON.stringify(
                result.content_base64
                  ? {
                      external_content_base64: result.content_base64,
                      local_content: doc.content,
                    }
                  : null,
              ),
            ],
          )
        ).rows[0];
      }
      throw fail('unknown_command');
    },
  );
}
async function prepareBackup(db: pg.Pool, config: Config, id: string) {
  const b = (
    await db.query(
      "SELECT b.*,p.password,p.revision AS current_revision,p.enabled FROM remote_backups b JOIN remote_backup_plans p ON p.id=b.plan_id WHERE b.id=$1 AND b.state='preparing'",
      [id],
    )
  ).rows[0];
  if (!b) return;
  try {
    if (b.plan_revision !== b.current_revision)
      throw fail('backup_plan_changed');
    const password = decrypt(
      b.password,
      config,
      b.owner_id + ':remote-backup:' + b.plan_id,
    );
    const { archive } = await exportBackup(db, password);
    const bytes = Buffer.from(canonical(archive));
    await db.query(
      "UPDATE remote_backups SET archive=$2,content_hash=$3,chunk_count=$4,state='listing' WHERE id=$1 AND state='preparing'",
      [
        id,
        JSON.stringify(archive),
        hash(bytes),
        Math.ceil(bytes.length / 262144),
      ],
    );
  } catch (e) {
    await db.query(
      "UPDATE remote_backups SET state='failed',error_code=$2 WHERE id=$1 AND state='preparing'",
      [id, e instanceof AppError ? e.code : 'backup_prepare_failed'],
    );
  }
}
export async function tickRemoteBackups(db: pg.Pool, config: Config) {
  const plans = (
    await db.query(
      'SELECT * FROM remote_backup_plans WHERE enabled AND next_at<=now() LIMIT 10',
    )
  ).rows;
  for (const p of plans)
    await transaction(db, async (tx) => {
      const current = (
        await tx.query(
          'SELECT * FROM remote_backup_plans WHERE id=$1 FOR UPDATE',
          [p.id],
        )
      ).rows[0];
      if (!current.enabled || new Date(current.next_at).getTime() > Date.now())
        return;
      const step = (current.cadence === 'daily' ? 1 : 7) * 86400000,
        first = new Date(current.next_at).getTime(),
        latest = first + Math.floor((Date.now() - first) / step) * step;
      await tx.query('UPDATE remote_backup_plans SET next_at=$2 WHERE id=$1', [
        p.id,
        new Date(latest + step),
      ]);
      // At most one outstanding upload per plan; resume it instead of accumulating full copies.
      if (
        (
          await tx.query(
            "SELECT 1 FROM remote_backups WHERE plan_id=$1 AND state IN ('preparing','listing','uploading','pruning','unknown')",
            [p.id],
          )
        ).rowCount
      )
        return;
      await tx.query(
        'INSERT INTO remote_backups(owner_id,plan_id,plan_revision,link_id,root,slot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [
          p.owner_id,
          p.id,
          p.revision,
          p.link_id,
          p.root,
          new Date(latest).toISOString(),
        ],
      );
    });
  for (const row of (
    await db.query(
      "SELECT id FROM remote_backups WHERE state='preparing' LIMIT 1",
    )
  ).rows)
    await prepareBackup(db, config, row.id);
  for (const row of (
    await db.query(
      "SELECT id,owner_id FROM remote_backups WHERE state IN ('listing','uploading','pruning','unknown') ORDER BY created_at LIMIT 10",
    )
  ).rows)
    await transaction(db, async (tx) => {
      await tx.query('SELECT id FROM owners WHERE id=$1 FOR NO KEY UPDATE', [
        row.owner_id,
      ]);
      const b = (
        await tx.query('SELECT * FROM remote_backups WHERE id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0];
      const plan = (
        await tx.query(
          'SELECT revision,enabled,keep_count FROM remote_backup_plans WHERE id=$1',
          [b.plan_id],
        )
      ).rows[0];
      if (!plan || plan.revision !== b.plan_revision) {
        await tx.query(
          "UPDATE remote_backups SET state='paused',error_code='backup_plan_changed' WHERE id=$1",
          [b.id],
        );
        return;
      }
      if (b.job_id) {
        const job = (
          await tx.query('SELECT * FROM host_jobs WHERE id=$1', [b.job_id])
        ).rows[0];
        if (['pending', 'accepted', 'executing'].includes(job.state)) return;
        if (job.state === 'unknown') {
          await tx.query(
            "UPDATE remote_backups SET state='unknown' WHERE id=$1",
            [b.id],
          );
          return;
        }
        if (job.state !== 'completed') {
          await tx.query(
            "UPDATE remote_backups SET state='failed',error_code=$2 WHERE id=$1",
            [b.id, job.error_code],
          );
          return;
        }
        if (job.kind === 'backup_list') {
          b.manifest_revision = job.result.revision;
          b.state = 'uploading';
        } else {
          if (job.result.verified || job.kind === 'backup_delete') {
            const points = (job.result.points ?? [])
              .filter((x: any) => x.plan_id === b.plan_id && x.verified)
              .sort((a: any, c: any) =>
                a.created_at.localeCompare(c.created_at),
              );
            if (plan.keep_count > 0 && points.length > plan.keep_count) {
              const deletion = await submitHostJobTx(
                tx,
                b.owner_id,
                {
                  link_id: b.link_id,
                  kind: 'backup_delete',
                  scope: {
                    root: b.root,
                    backup_plan_id: b.plan_id,
                    backup_plan_revision: b.plan_revision,
                  },
                  payload: {
                    content_hash: points[0].content_hash,
                    expected_revision: job.result.revision,
                  },
                  budget,
                },
                randomUUID(),
              );
              await tx.query(
                "UPDATE remote_backups SET state='pruning',archive=NULL,job_id=$2 WHERE id=$1",
                [b.id, deletion.id],
              );
              return;
            }
            await tx.query(
              "UPDATE remote_backups SET state='completed',archive=NULL WHERE id=$1",
              [b.id],
            );
            return;
          }
          b.chunk_index++;
          b.state = 'uploading';
        }
      }
      const listing = b.state === 'listing';
      let payload: any = {};
      if (!listing) {
        const bytes = Buffer.from(canonical(b.archive)),
          chunk = bytes.subarray(
            b.chunk_index * 262144,
            (b.chunk_index + 1) * 262144,
          );
        if (!chunk.length) throw fail('backup_chunks_unverified');
        payload = {
          plan_id: b.plan_id,
          content_hash: b.content_hash,
          content_base64: chunk.toString('base64'),
          chunk_hash: hash(chunk),
          chunk_index: b.chunk_index,
          chunk_count: b.chunk_count,
          expected_revision: b.manifest_revision,
        };
      }
      const j = await submitHostJobTx(
        tx,
        b.owner_id,
        {
          link_id: b.link_id,
          kind: listing ? 'backup_list' : 'backup_put',
          scope: {
            root: b.root,
            backup_plan_id: b.plan_id,
            backup_plan_revision: b.plan_revision,
          },
          payload,
          budget,
        },
        randomUUID(),
      );
      await tx.query(
        'UPDATE remote_backups SET job_id=$2,state=$3,chunk_index=$4,manifest_revision=$5 WHERE id=$1',
        [b.id, j.id, b.state, b.chunk_index, b.manifest_revision],
      );
    });
}
