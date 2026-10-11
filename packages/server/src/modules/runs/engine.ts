import { executeTool, proposeTool } from '../mcp/gateway.js';
import { queryEmbedding } from '../memory/embeddings.js';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { AppError } from '../../security.js';
import { ModelError, streamModel } from '../llm/index.js';
import { claim, finish, heartbeat, savePartial } from './repository.js';
export async function execute(
  db: pg.Pool,
  config: Config,
  runId: string,
  stopping?: AbortSignal,
) {
  const vector = await queryEmbedding(db, config, runId, stopping).catch(
    () => undefined,
  );
  const c = await claim(
    db,
    runId,
    config.leaseMs,
    config.dailyRequestLimit,
    config.modelTimeoutMs,
    vector,
    config,
  );
  if (!c) return;
  const controller = new AbortController();
  let content = '',
    lastSaved = 0,
    leaseLost = false,
    beatRunning = false;
  const abort = () => controller.abort();
  stopping?.addEventListener('abort', abort, { once: true });
  if (stopping?.aborted) abort();
  const timeout = setTimeout(
    abort,
    Math.max(
      1,
      Math.min(
        config.modelTimeoutMs,
        new Date(c.run.deadline_at).getTime() - Date.now(),
      ),
    ),
  );
  const beat = setInterval(
    () => {
      if (beatRunning) return;
      beatRunning = true;
      void heartbeat(db, c, config.leaseMs)
        .then((valid) => {
          if (!valid) {
            leaseLost = true;
            abort();
          }
        })
        .catch(() => {
          leaseLost = true;
          abort();
        })
        .finally(() => {
          beatRunning = false;
        });
    },
    Math.max(250, Math.floor(config.leaseMs / 3)),
  );
  try {
    if (c.toolOnly) {
      await executeTool(
        db,
        config,
        c,
        c.toolOnly,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      );
      return;
    }
    const result = await streamModel(
      c,
      config,
      controller.signal,
      async (text) => {
        content = text;
        if (c.tools?.length || c.run.trigger_kind !== 'foreground') return;
        if (Date.now() - lastSaved >= 250) {
          const valid = await savePartial(db, c, text);
          if (!valid) {
            leaseLost = true;
            abort();
            throw new ModelError('lease_lost');
          }
          lastSaved = Date.now();
        }
      },
    );
    if (result.tool) await proposeTool(db, c, result.tool, result.usage);
    else await finish(db, c, result.content, 'completed', null, result.usage);
  } catch (e) {
    if (!leaseLost) {
      const error =
        e instanceof ModelError
          ? e
          : e instanceof AppError
            ? new ModelError(e.code)
            : new ModelError('run_failed');
      await finish(
        db,
        c,
        content,
        content ? 'interrupted' : 'failed',
        error.code,
        null,
        error.retryable && !stopping?.aborted,
      );
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(beat);
    stopping?.removeEventListener('abort', abort);
  }
}
