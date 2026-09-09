import { mkdir, readFile, rename, rm, readdir, lstat, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowmatePaths } from './contracts.ts';
import { resolveOwnedPath } from './config.ts';
import { writeCanonicalJson } from './file-store.ts';
import { sampleDirectory } from './layout.ts';

async function pruneOriginalWork(paths: FlowmatePaths): Promise<void> {
  for (const relative of ['work/t', 'work']) await rmdir(resolveOwnedPath(paths.originalRoot, relative)).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
/** Both the old and new trees stay on their target volume. The journal is the commit point. */
export async function publicationPaths(paths: FlowmatePaths, datasetId: string, sampleId: string) {
  const relative = sampleDirectory(datasetId, sampleId);
  const key = relative.replace('/', '-');
  const dataWork = resolveOwnedPath(paths.dataRoot, `work/t/${key}`);
  const originalWork = resolveOwnedPath(paths.originalRoot, `work/t/${key}`);
  return { dataWork, originalWork, journal: join(dataWork, 'journal.json'), swaps: [
    { stage: join(dataWork, 'new'), target: resolveOwnedPath(paths.dataRoot, relative), backup: join(dataWork, 'old') },
    { stage: join(originalWork, 'new'), target: resolveOwnedPath(paths.originalRoot, relative), backup: join(originalWork, 'old') },
  ] };
}
/** Must be called while holding the global run lock, before reading committed sample records. */
export async function recoverPublications(paths: FlowmatePaths): Promise<void> {
  const root = resolveOwnedPath(paths.dataRoot, 'work/t');
  let names: string[]; try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names) {
    const journal = resolveOwnedPath(root, `${name}/journal.json`);
    if (!await Bun.file(journal).exists()) continue;
    const value = JSON.parse(await readFile(journal, 'utf8'));
    if (value.schema_version !== 1 || typeof value.dataset_id !== 'string' || typeof value.sample_id !== 'string' || !Array.isArray(value.existed) || value.existed.length !== 2 || value.existed.some((item: unknown) => typeof item !== 'boolean')) throw new Error('PUBLICATION_JOURNAL_INVALID');
    const plan = await publicationPaths(paths, value.dataset_id, value.sample_id);
    if (plan.journal !== journal) throw new Error('PUBLICATION_JOURNAL_INVALID');
    for (const [index, swap] of [...plan.swaps.entries()].reverse()) {
      if (await exists(swap.backup)) {
        await rm(swap.target, { recursive: true, force: true }); await rename(swap.backup, swap.target);
      } else if (!value.existed[index] && !await exists(swap.stage)) {
        // No prior target existed: remove only a new target installed by this transaction.
        await rm(swap.target, { recursive: true, force: true });
      }
    }
    await rm(plan.dataWork, { recursive: true, force: true });
    await rm(plan.originalWork, { recursive: true, force: true });
    await pruneOriginalWork(paths);
  }
}
export async function commitPublication(paths: FlowmatePaths, datasetId: string, sampleId: string, verify: (path: string) => Promise<unknown>): Promise<void> {
  const plan = await publicationPaths(paths, datasetId, sampleId);
  for (const swap of plan.swaps) await verify(swap.stage);
  await writeCanonicalJson(plan.journal, { schema_version: 1, dataset_id: datasetId, sample_id: sampleId, existed: await Promise.all(plan.swaps.map(swap => exists(swap.target))) });
  try {
    for (const swap of plan.swaps) {
      await mkdir(join(swap.target, '..'), { recursive: true });
      if (await exists(swap.target)) await rename(swap.target, swap.backup);
      await rename(swap.stage, swap.target); await verify(swap.target);
    }
    // A crash before this unlink rolls back both roots. After it, both verified roots are committed.
    await rm(plan.journal);
  } catch (error) { await recoverPublications(paths); throw error; }
  await rm(plan.dataWork, { recursive: true, force: true });
  await rm(plan.originalWork, { recursive: true, force: true });
    await pruneOriginalWork(paths);
}
