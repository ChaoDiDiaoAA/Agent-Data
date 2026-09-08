import { resolve } from 'node:path';
import { buildOpenCliAdapter } from '../../scripts/build-opencli-adapter.ts';
import { loadProjectPaths } from '../shared/config.ts';
import { loadOpenCliRuntime, type OpenCliInput } from '../runtime/opencli.ts';

function canPrepareFrom(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /OpenCLI installation (manifest missing or invalid|stale (?:sourceHash|installationHash|outputHash))/i.test(message);
}

export async function prepareOpenCli(projectRoot: string) {
  const root = resolve(projectRoot);
  return buildOpenCliAdapter({ projectRoot: root, tempRoot: loadProjectPaths({ root }).tempRoot });
}

export async function ensureOpenCliPrepared(input: OpenCliInput): Promise<void> {
  try {
    await loadOpenCliRuntime(input);
  } catch (error) {
    if (!canPrepareFrom(error)) throw error;
    await buildOpenCliAdapter(input);
  }
}
