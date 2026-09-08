import { cp, lstat, mkdir, mkdtemp, realpath, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import type { ProjectPaths } from '../../src/types/config.ts';

interface RuntimeFixture {
  root: string;
  projectRoot: string;
  paths: ProjectPaths;
  dispose(): Promise<void>;
}

/** Every launch owns a separate proof: later/concurrent success cannot clear uncertainty. */
export function realProcessFixtureCleanup(fixture: RuntimeFixture) {
  const unresolved = new Set<symbol>();
  const safetyRoot = join(fixture.paths.stateRoot, 'operations', 'locks', 'processes');
  async function records() {
    return readdir(safetyRoot).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
  }
  return {
    async invoke<T extends { cleanupConfirmed: boolean; activePids: number[] }>(launch: () => Promise<T>): Promise<T> {
      const attempt = Symbol('launch'); unresolved.add(attempt);
      const result = await launch();
      if (result.cleanupConfirmed === true && result.activePids.length === 0) unresolved.delete(attempt);
      return result;
    },
    protectRecord() {
      const record = Symbol('restored record'); unresolved.add(record);
      return { async confirmRemoved() {
        if ((await records()).length) throw new Error('restored process safety record is unresolved');
        unresolved.delete(record);
      } };
    },
    async dispose() {
      let remaining: string[];
      try { remaining = await records(); }
      catch { remaining = ['unreadable safety root']; }
      if (unresolved.size || remaining.length) {
        console.log('real-process-fixture-retained', JSON.stringify({ root: fixture.root, unresolved: unresolved.size, records: remaining }));
        return { disposed: false, root: fixture.root };
      }
      await fixture.dispose();
      return { disposed: true, root: fixture.root };
    },
  };
}

const fixtureConfigFiles = [
  'categories.yaml',
  'evidence-policy.yaml',
  'mineru-local.yaml',
  'paper-policy.yaml',
  'paths.example.yaml',
  'pipeline.yaml',
  'query-matrix.yaml',
  'runtime.yaml',
];

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

async function assertSafeFixturePath(testRoot: string, fixtureRoot: string): Promise<void> {
  const actualTestRoot = await realpath(testRoot);
  const actualFixtureRoot = await realpath(fixtureRoot);
  if (!isInside(actualTestRoot, actualFixtureRoot)) {
    throw new Error(`refusing to clean fixture outside test root: ${actualFixtureRoot}`);
  }

  const entry = await lstat(actualFixtureRoot);
  if (entry.isSymbolicLink()) throw new Error(`refusing to clean symbolic link fixture: ${actualFixtureRoot}`);

  async function rejectReparsePoints(directory: string): Promise<void> {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const childPath = join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`refusing to clean fixture with symbolic link: ${childPath}`);
      if (child.isDirectory()) await rejectReparsePoints(childPath);
    }
  }

  await rejectReparsePoints(actualFixtureRoot);
}

/** Remove only a test-owned directory, after the same containment/reparse checks. */
export async function removeOwnedTestDirectory(root: string): Promise<void> {
  const testRoot = process.env.FSD_TEST_ROOT;
  if (!testRoot) throw new Error('FSD_TEST_ROOT is required for fixture cleanup');
  await assertSafeFixturePath(resolve(testRoot), resolve(root));
  await rm(root, { recursive: true, force: true });
}

export async function makeRuntimeFixture(): Promise<RuntimeFixture> {
  const testRoot = resolve(process.env.FSD_TEST_ROOT ?? 'data/fsd-code2doc/validation/tmp/bun-tests');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'runtime-fixture-'));
  await assertSafeFixturePath(testRoot, root);
  const projectRoot = join(root, 'project');
  const sourceConfig = resolve(process.cwd(), 'tests/fixtures/legacy-config');
  const fixtureConfig = join(projectRoot, 'config');

  await mkdir(fixtureConfig, { recursive: true });
  await Promise.all(fixtureConfigFiles.map(file => cp(join(sourceConfig, file), join(fixtureConfig, file))));

  const paths = {
    pdfRoot: join(root, 'output', 'pdf'),
    vaultRoot: join(root, 'output', 'vault'),
    stateRoot: join(root, 'output', 'state'),
    tempRoot: join(root, 'output', 'tmp'),
    backupRoot: join(root, 'output', 'backups'),
  };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  await writeFile(join(fixtureConfig, 'paths.local.yaml'), YAML.stringify({
    pdf_root: paths.pdfRoot,
    vault_root: paths.vaultRoot,
    state_root: paths.stateRoot,
    temp_root: paths.tempRoot,
    backup_root: paths.backupRoot,
  }));

  return {
    root,
    projectRoot,
    paths,
    async dispose() {
      await assertSafeFixturePath(testRoot, root);
      await rm(root, { recursive: true, force: true });
    },
  };
}
