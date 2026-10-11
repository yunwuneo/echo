import { AppError, hash } from '../../security.js';
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export const fingerprint = (tool: any) =>
  hash(
    canonical({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? {},
    }),
  );
// Deliberately bounded JSON Schema subset; unsupported constraints disable a tool, never silently remove validation.
const keys = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);
export function supported(schema: any, depth = 0): boolean {
  if (
    depth > 12 ||
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema)
  )
    return false;
  if (Object.keys(schema).some((k) => !keys.has(k))) return false;
  if (
    ![
      'object',
      'array',
      'string',
      'integer',
      'number',
      'boolean',
      'null',
    ].includes(schema.type)
  )
    return false;
  if (
    schema.properties &&
    (schema.type !== 'object' ||
      typeof schema.properties !== 'object' ||
      Array.isArray(schema.properties) ||
      Object.values(schema.properties).some((s) => !supported(s, depth + 1)))
  )
    return false;
  if (
    schema.required &&
    (!Array.isArray(schema.required) ||
      schema.required.some((s: any) => typeof s !== 'string'))
  )
    return false;
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean'
  )
    return false;
  if (schema.type === 'array' && !supported(schema.items, depth + 1))
    return false;
  for (const key of [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ])
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== 'number' ||
        !Number.isFinite(schema[key]) ||
        (key !== 'minimum' &&
          key !== 'maximum' &&
          (!Number.isInteger(schema[key]) || schema[key] < 0)))
    )
      return false;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    return false;
  return true;
}
export function matches(s: any, v: any): boolean {
  if (s.const !== undefined && canonical(s.const) !== canonical(v))
    return false;
  if (s.enum && !s.enum.some((x: any) => canonical(x) === canonical(v)))
    return false;
  switch (s.type) {
    case 'object':
      return (
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        (s.required ?? []).every((k: string) => Object.hasOwn(v, k)) &&
        Object.entries(v).every(([k, val]) =>
          Object.hasOwn(s.properties ?? {}, k)
            ? matches(s.properties[k], val)
            : s.additionalProperties !== false,
        )
      );
    case 'array':
      return (
        Array.isArray(v) &&
        v.length >= (s.minItems ?? 0) &&
        v.length <= (s.maxItems ?? Infinity) &&
        v.every((x) => matches(s.items, x))
      );
    case 'string':
      return (
        typeof v === 'string' &&
        [...v].length >= (s.minLength ?? 0) &&
        [...v].length <= (s.maxLength ?? Infinity)
      );
    case 'integer':
    case 'number':
      return (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        (s.type !== 'integer' || Number.isInteger(v)) &&
        v >= (s.minimum ?? -Infinity) &&
        v <= (s.maximum ?? Infinity)
      );
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return false;
  }
}
export function validateArguments(schema: any, args: any, scope: any) {
  if (
    Buffer.byteLength(canonical(args)) > 16384 ||
    !supported(schema) ||
    !matches(schema, args)
  )
    throw new AppError(
      400,
      'invalid_tool_arguments',
      'Arguments do not match the supported tool schema',
    );
  if (
    Object.entries(scope).some(
      ([key, value]) =>
        !Object.hasOwn(args, key) || canonical(args[key]) !== canonical(value),
    )
  )
    throw new AppError(
      403,
      'tool_scope_denied',
      'Arguments exceed the granted resource scope',
    );
}
export function boundedResult(result: any) {
  // No binary downloads, resource fetching or embedded executable actions.
  let raw = JSON.stringify({
    untrusted_tool_result: true,
    isError: result.isError === true,
    text: (result.content ?? [])
      .filter((x: any) => x.type === 'text')
      .map((x: any) => x.text),
    structured: result.structuredContent ?? null,
  });
  const bytes = Buffer.from(raw);
  const truncated = bytes.length > 4000;
  if (truncated)
    raw = new TextDecoder().decode(bytes.subarray(0, 3990)) + '…[截断]';
  return { text: raw, truncated };
}
