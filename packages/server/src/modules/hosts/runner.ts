import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, sign, createPrivateKey } from 'node:crypto';
import type { Config } from '../../config.js';
import { hash, AppError } from '../../security.js';
import { canonical } from '../mcp/schema.js';
import { hostHTTP } from './client.js';
import { journalWrite, readScoped, writeScoped, listScoped } from './files.js';
import { runPython } from '../miniapps/python.js';
export interface HostConfiguration {
  cloud_url: string;
  host_id: string;
  token: string;
  private_key: string;
  journal: string;
  roots: Record<string, string>;
  identities: Record<string, { room_id: string }>;
  local_echo?: { url: string; access_token: string; refresh_token: string };
}
export class HostRunner {
  private busy = false;
  constructor(
    readonly config: Config,
    readonly host: HostConfiguration,
    readonly persistConfig?: (h: HostConfiguration) => Promise<void>,
  ) {
    if (host.local_echo && !persistConfig)
      throw Error('Local Echo token rotation requires durable configuration');
  }
  async rpc(action: string, payload: any) {
    const body = {
      protocolVersion: 1,
      host_id: this.host.host_id,
      timestamp: Date.now(),
      action,
      payload,
    };
    return hostHTTP(this.config, this.host.cloud_url, '/v1/hosts/rpc', body, {
      Authorization: 'Bearer ' + this.host.token,
      'X-Echo-Signature': sign(
        null,
        Buffer.from(canonical(body)),
        createPrivateKey(this.host.private_key),
      ).toString('base64'),
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await mkdir(this.host.journal, { recursive: true, mode: 0o700 });
      const catalog = [
        'file_read',
        'file_write',
        'file_list',
        'plugin',
        'backup_put',
        'backup_list',
        'backup_delete',
        ...(this.host.local_echo ? ['chat'] : []),
      ];
      const data = await this.rpc('poll', { capabilities: catalog });
      await journalWrite(
        join(this.host.journal, 'shared-facts.json'),
        data.snapshots ?? [],
      );
      for (const revoke of data.revocations)
        await this.rpc('ackRevoke', revoke).catch(() => {});
      for (const job of data.jobs) {
        try {
          await this.process(job);
        } catch {
          /* Persisted intent remains queryable; no new operation ID or automatic local fallback. */
        }
      }
    } finally {
      this.busy = false;
    }
  }
  /** Owner-operated reconciliation only: supplies evidence, never reruns the external action. */
  async resolve(
    jobID: string,
    resolution: {
      state: 'completed' | 'failed';
      result: any;
      error_code?: string;
    },
  ) {
    if (
      !/^[a-f0-9-]{36}$/i.test(jobID) ||
      !['completed', 'failed'].includes(resolution.state) ||
      Buffer.byteLength(JSON.stringify(resolution.result)) > 2097152
    )
      throw new AppError(
        400,
        'receipt_invalid',
        'Bounded evidence and job ID required',
      );
    const file = join(this.host.journal, jobID + '.json'),
      r = JSON.parse(await readFile(file, 'utf8'));
    const current = await this.rpc('query', { job_id: jobID });
    if (
      current.execution_id !== r.execution_id ||
      !['unknown', 'executing', 'accepted'].includes(current.state)
    )
      throw new AppError(
        409,
        'receipt_state',
        'Refresh the authoritative job before resolving',
      );
    r.state = resolution.state;
    r.result = resolution.result;
    r.error_code = resolution.error_code ?? null;
    r.receipt_id = randomUUID();
    await journalWrite(file, r);
    await this.receipt(r, file);
    return { job_id: jobID, state: r.state };
  }
  private async process(job: any) {
    const file = join(this.host.journal, job.id + '.json');
    let record: any;
    try {
      record = JSON.parse(await readFile(file, 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (record && record.payload_hash !== job.payload_hash)
      throw Error('Host operation identity conflict');
    if (!record) {
      record = {
        job,
        execution_id: randomUUID(),
        payload_hash: job.payload_hash,
        state: 'prepared',
      };
      await journalWrite(file, record);
    }
    if (record.state === 'executing' && job.kind === 'chat') {
      const found = await this.local('/v1/milestone', {
        action: 'feature',
        command: 'hostConversationResult',
        operation_id: randomUUID(),
        expected_revision: 0,
        payload: { operation_id: job.id },
      });
      if (found.found) {
        record.state = 'waiting_local';
        record.result = { local_run_id: found.id };
        await journalWrite(file, record);
      }
    }
    if (record.state === 'waiting_local') {
      const found = await this.local('/v1/milestone', {
        action: 'feature',
        command: 'hostConversationResult',
        operation_id: randomUUID(),
        expected_revision: 0,
        payload: { operation_id: job.id },
      });
      if (
        !found.found ||
        !['completed', 'failed', 'interrupted', 'cancelled'].includes(
          found.state,
        )
      )
        return;
      record.state = found.state === 'completed' ? 'completed' : 'failed';
      record.result = found;
      await journalWrite(file, record);
      await this.receipt(record, file);
      return;
    }
    if (record.state === 'executing') {
      record.state = 'unknown';
      record.result = { reason: 'host_process_interrupted' };
      record.error_code = 'host_process_interrupted';
      await journalWrite(file, record);
    }
    if (['completed', 'failed', 'unknown', 'rejected'].includes(record.state)) {
      await this.receipt(record, file);
      return;
    }
    if (job.schedule_id)
      await this.rpc('lease', {
        schedule_id: job.schedule_id,
        epoch: job.epoch,
      });
    const accepted = await this.rpc('accept', {
      job_id: job.id,
      execution_id: record.execution_id,
    });
    if (!['accepted', 'executing'].includes(accepted.state)) return;
    record.state = 'accepted';
    await journalWrite(file, record);
    const begun = await this.rpc('begin', {
      job_id: job.id,
      execution_id: record.execution_id,
    });
    if (begun.state !== 'executing') return;
    if (!begun.started_now) {
      record.state = 'unknown';
      record.result = { reason: 'begin_response_lost' };
      record.error_code = 'begin_response_lost';
      await journalWrite(file, record);
      await this.receipt(record, file);
      return;
    }
    record.state = 'executing';
    await journalWrite(file, record);
    try {
      record.result = await this.execute(job);
      record.state = job.kind === 'chat' ? 'waiting_local' : 'completed';
    } catch (e) {
      record.state =
        e instanceof AppError &&
        [
          'path_scope',
          'symlink_denied',
          'file_limit',
          'directory_authorization_lost',
          'host_identity_missing',
          'plugin_network',
        ].includes(e.code)
          ? 'failed'
          : 'unknown';
      record.error_code =
        e instanceof AppError ? e.code : 'host_execution_unknown';
      record.result = { error: record.error_code };
    }
    await journalWrite(file, record);
    if (record.state !== 'waiting_local') await this.receipt(record, file);
  }
  private async receipt(r: any, file: string) {
    r.receipt_id ??= randomUUID();
    await journalWrite(file, r);
    await this.rpc('receipt', {
      job_id: r.job.id,
      execution_id: r.execution_id,
      receipt_id: r.receipt_id,
      state: r.state,
      result: r.result,
      error_code: r.error_code ?? null,
      not_accepted: r.state === 'rejected',
    });
  }
  private async local(path: string, body: unknown) {
    const local = this.host.local_echo;
    if (!local)
      throw new AppError(
        409,
        'host_identity_missing',
        'Host local Echo unavailable',
      );
    try {
      return await hostHTTP(this.config, local.url, path, body, {
        Authorization: 'Bearer ' + local.access_token,
      });
    } catch (e) {
      if (!(e instanceof AppError) || e.status !== 401) throw e;
      const updated = await hostHTTP(
        this.config,
        local.url,
        '/v1/sessions/refresh',
        { refresh_token: local.refresh_token },
      );
      local.access_token = updated.access_token;
      local.refresh_token = updated.refresh_token;
      await this.persistConfig?.(this.host);
      return hostHTTP(this.config, local.url, path, body, {
        Authorization: 'Bearer ' + local.access_token,
      });
    }
  }
  private async execute(job: any): Promise<any> {
    const root = this.host.roots[job.scope.root],
      p = job.payload;
    if (
      [
        'file_read',
        'file_write',
        'file_list',
        'backup_put',
        'backup_list',
        'backup_delete',
      ].includes(job.kind) &&
      !root
    )
      throw new AppError(409, 'path_scope', 'Directory not granted locally');
    if (job.kind === 'file_read') return readScoped(root!, p.path);
    if (job.kind === 'file_list') return listScoped(root!, p.path ?? '');
    if (job.kind === 'file_write')
      return writeScoped(
        root!,
        p.path,
        Buffer.from(p.content_base64, 'base64'),
        p.base_hash ?? null,
      );
    if (
      job.kind === 'backup_put' ||
      job.kind === 'backup_delete' ||
      job.kind === 'backup_list'
    ) {
      const { restorePointOperation } =
        await import('../storage/restore-points.js');
      return restorePointOperation(root!, job.kind, p);
    }
    if (job.kind === 'plugin')
      return runPython(p.source, p.input, async (url) => {
        if (!p.network.includes(new URL(url).origin))
          throw new AppError(
            403,
            'plugin_network',
            'Plugin network source not granted',
          );
        return hostHTTP(
          this.config,
          new URL(url).origin,
          new URL(url).pathname + new URL(url).search,
          undefined,
        );
      });
    if (job.kind === 'chat') {
      const identity = this.host.identities[p.remote_identity];
      if (!identity)
        throw new AppError(
          409,
          'host_identity_missing',
          'Unknown independent Host identity',
        );
      const ack = await this.local('/v1/milestone', {
        action: 'feature',
        command: 'receiveHostConversation',
        operation_id: job.id,
        expected_revision: 0,
        payload: {
          room_id: identity.room_id,
          content: p.content,
          budget: job.budget,
        },
      });
      return {
        local_run_id: ack.run_id,
        local_room_id: identity.room_id,
        state: 'accepted',
      };
    }
    throw new AppError(
      409,
      'host_capability',
      'Host capability not implemented',
    );
  }
}
