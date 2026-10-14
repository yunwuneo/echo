export function requiredSpace(bytes: number): number;
export function assertSpace(
  available: number,
  bytes: number,
): { available_bytes: number; required_bytes: number };
export function databaseSpace(
  df: string,
  bytes: number,
): ReturnType<typeof assertSpace>;
export function localSpace(
  path: string,
  bytes: number,
  inspect?: (
    path: string,
  ) => Promise<{ bavail: number | bigint; bsize: number | bigint }>,
): Promise<ReturnType<typeof assertSpace>>;
