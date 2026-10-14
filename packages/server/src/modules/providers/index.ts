import { randomUUID } from 'node:crypto';
import type { ProviderInput } from '../../../../contracts/src/index.js';
import type { DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, encrypt, validateEndpoint } from '../../security.js';
import type pg from 'pg';
import { command } from '../commands/index.js';
import { emit } from '../sync/index.js';
import { matchRevision } from '../worlds/index.js';
export const providerView = (r: Record<string, any>) => ({
  media_options: r.media_options ?? {},
  protocol: r.protocol ?? 'openai',
  id: r.id,
  name: r.name,
  base_url: r.base_url,
  model: r.model,
  context_window: r.context_window,
  max_output_tokens: r.max_output_tokens,
  credential_present:
    r.credential_present ??
    (r.credential === undefined || !!r.credential?.data),
  revision: r.revision ?? 1,
  capabilities: {
    text: true,
    streaming: true,
    tools: r.tools_enabled ?? false,
    vision: r.vision_enabled ?? false,
    verification: 'declared',
  },
});
export async function createProvider(
  db: DB,
  config: Config,
  ownerId: string,
  input: ProviderInput,
) {
  const id = randomUUID(),
    baseURL = await validateEndpoint(input.base_url, config);
  if (input.max_output_tokens >= input.context_window)
    throw new AppError(
      400,
      'invalid_budget',
      'Output budget must be smaller than context window',
    );
  const r = await db.query(
    'INSERT INTO provider_connections(id,owner_id,name,base_url,model,context_window,max_output_tokens,credential,tools_enabled,vision_enabled,protocol) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [
      id,
      ownerId,
      input.name,
      baseURL,
      input.model,
      input.context_window,
      input.max_output_tokens,
      encrypt(input.api_key, config, `${ownerId}:${id}`),
      input.tools_enabled ?? false,
      input.vision_enabled ?? false,
      input.protocol ?? 'openai',
    ],
  );
  return providerView(r.rows[0]);
}
export async function updateProvider(
  db: pg.Pool,
  config: Config,
  owner: string,
  id: string,
  revision: number,
  input: Omit<ProviderInput, 'api_key'> & {
    operation_id: string;
    api_key?: string;
  },
) {
  const base = await validateEndpoint(input.base_url, config);
  if (input.max_output_tokens >= input.context_window)
    throw new AppError(
      400,
      'invalid_budget',
      'Output budget must be smaller than context window',
    );
  return command(
    db,
    owner,
    'provider.update',
    input.operation_id,
    { id, revision, ...input },
    async (tx) => {
      const previous = (
        await tx.query(
          'SELECT * FROM provider_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE',
          [owner, id],
        )
      ).rows[0];
      matchRevision(previous, revision);
      const row = (
        await tx.query(
          `UPDATE provider_connections SET name=$3,base_url=$4,model=$5,context_window=$6,max_output_tokens=$7,
       credential=$8,tools_enabled=$9,vision_enabled=$10,protocol=$11,revision=revision+1 WHERE owner_id=$1 AND id=$2 RETURNING *`,
          [
            owner,
            id,
            input.name,
            base,
            input.model,
            input.context_window,
            input.max_output_tokens,
            input.api_key === undefined
              ? previous.credential
              : encrypt(input.api_key, config, `${owner}:${id}`),
            input.tools_enabled ?? previous.tools_enabled,
            input.vision_enabled ?? previous.vision_enabled,
            input.protocol ?? previous.protocol,
          ],
        )
      ).rows[0];
      const result = providerView(row);
      await emit(tx, owner, 'provider', id, result);
      return result;
    },
  );
}
