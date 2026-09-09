import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Presentation only: shared canonical serialization and identities stay unchanged. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** Recover the exact compact source representation, preserving property order. */
export function compactJsonHash(bytes: Uint8Array, expected?: string): string {
  const text = Buffer.from(bytes).toString('utf8');
  const value: unknown = JSON.parse(text);
  const compact = JSON.stringify(value) + '\n';
  if (text !== compact && text !== compact.trimEnd() && text !== prettyJson(value)) throw new Error('JSON_REPRESENTATION_INVALID');
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  // Older imported JSON can omit the final newline; its frozen identity survives.
  if (expected && digest(compact.slice(0, -1)) === expected) return expected;
  return digest(compact);
}

export async function compactJsonFileHash(path: string, expected?: string): Promise<string> {
  return compactJsonHash(await readFile(path), expected);
}
