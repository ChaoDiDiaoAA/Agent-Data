import { cp, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { writeLayeredConfigFixture } from '../fixtures/layered-config.ts';
import { removeOwnedTestDirectory } from '../fixtures/runtime-fixtures.ts';

export const paperLibraryIds = ['fsd', 'agent-engineering', 'multi-agent-engineering', 'llm-post-training'] as const;

export async function withPostTrainingFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const testRoot = process.env.FSD_TEST_ROOT;
  if (!testRoot) throw new Error('FSD_TEST_ROOT must be set by tests/preload.ts');
  const root = await mkdtemp(join(testRoot, 'post-training-'));
  try {
    await writeLayeredConfigFixture({ root });
    for (const id of paperLibraryIds.slice(1)) {
      await cp(join(import.meta.dirname, '../../config', id), join(root, 'config', id), { recursive: true });
    }
    return await run(root);
  } finally { await removeOwnedTestDirectory(root); }
}
