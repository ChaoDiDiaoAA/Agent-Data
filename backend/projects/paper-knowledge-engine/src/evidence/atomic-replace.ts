import { rename as defaultRename } from 'node:fs/promises';

export interface ReplaceFileOptions {
  platform?: NodeJS.Platform;
  maxAttempts?: number;
  rename?: (source: string, destination: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

const defaultDelays = [50, 100, 200, 400];

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? Reflect.get(error, 'code') : undefined;
}

export function isTransientWindowsReplaceError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(String(errorCode(error)));
}

export async function replaceFileWithRetry(
  source: string,
  destination: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const requestedAttempts = options.maxAttempts ?? 5;
  const maxAttempts = Number.isSafeInteger(requestedAttempts) && requestedAttempts > 0 ? requestedAttempts : 5;
  const rename = options.rename ?? defaultRename;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientWindowsReplaceError(error, platform) || attempt === maxAttempts) throw error;
      await sleep(defaultDelays[Math.min(attempt - 1, defaultDelays.length - 1)]!);
    }
  }
}
