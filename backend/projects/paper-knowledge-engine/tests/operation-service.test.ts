import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BunOperationService } from '../src/library/operations/operation-service.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { admitOperation } from '../src/library/operations/operation-store.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

test('operation service exposes a stable list/read seam', async () => {
  const root = process.cwd();
  const service = new BunOperationService(root, asLibraryId('fsd'), ':memory:');
  expect(await service.list()).toEqual([]);
});

test('operation service isolates selected-library state and rejects cross-library admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operation-service-library-'));
  try {
    await writeLayeredConfigFixture({ root, additionalLibraryIds: ['ai-tdd'] });
    const aiTdd = asLibraryId('ai-tdd');
    const selectedRoot = loadEngineContext({ root, libraryId: aiTdd }).paths.operationsRoot;
    await admitOperation({ root, operationsRoot: selectedRoot, request: {
      libraryId: aiTdd,
      requestId: 'selected-library',
      operation: { kind: 'current' },
    } });

    const selected = new BunOperationService(root, aiTdd);
    const fsd = new BunOperationService(root, asLibraryId('fsd'));
    expect((await selected.list()).map((job) => job.libraryId)).toEqual([aiTdd]);
    expect(await fsd.list()).toEqual([]);
    await expect(selected.admit({
      libraryId: asLibraryId('fsd'),
      requestId: 'wrong-library',
      operation: { kind: 'current' },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
