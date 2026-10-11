import { randomUUID } from 'node:crypto';
import type { ProviderInput } from '../../../../contracts/src/index.js';
import type { DB } from '../../db/index.js';
import type { Config } from '../../config.js';
import { AppError, encrypt, validateEndpoint } from '../../security.js';
export const providerView = (r: Record<string, any>) => ({
  id: r.id,
  name: r.name,
  base_url: r.base_url,
  model: r.model,
  context_window: r.context_window,
  max_output_tokens: r.max_output_tokens,
  credential_present: true,
  capabilities: {
    text: true,
    streaming: true,
    tools: r.tools_enabled ?? false,
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
    'INSERT INTO provider_connections(id,owner_id,name,base_url,model,context_window,max_output_tokens,credential,tools_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,base_url,model,context_window,max_output_tokens,tools_enabled',
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
    ],
  );
  return providerView(r.rows[0]);
}
