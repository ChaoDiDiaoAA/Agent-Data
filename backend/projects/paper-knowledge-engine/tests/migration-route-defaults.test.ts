import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.ts';
import { routeArchiveMigrate, routeLibraryMigrate } from '../src/cli/routes.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

async function emptyLegacyState(stateRoot: string) {
  await mkdir(join(stateRoot, 'extracted'), { recursive: true });
  const db = new Database(join(stateRoot, 'papers.sqlite'));
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => /^00[1-8]-/.test(name)).sort()) {
      db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }
    db.exec('ALTER TABLE papers ADD COLUMN downloaded_version INTEGER');
  } finally { db.close(); }
}

for (const command of ['archive-migrate', 'library-migrate'] as const) {
  for (const entry of ['route', 'CLI'] as const) {
    for (const explicitSource of [false, true]) {
      test(`${entry} ${command} ${explicitSource ? 'honors explicit --source-root' : 'defaults to the legacy fsd-code2doc source'}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'migration-route-defaults-'));
        try {
          // Same topology as D:/agent-data/data/paper-libraries/fsd. The
          // pre-refactor contract selects data/fsd-code2doc/state, not data/state.
          const paths = await writeLayeredConfigFixture({ root, dataLibrariesRoot: join(root, 'data', 'paper-libraries') });
          const legacyState = join(root, 'data', 'fsd-code2doc', 'state');
          const overrideState = join(root, 'explicit-source', 'state');
          // A valid decoy makes the regression fail on the chosen path, not ENOENT.
          for (const path of [legacyState, join(root, 'data', 'state'), overrideState]) await emptyLegacyState(path);
          const state = explicitSource ? overrideState : legacyState;
          const expectedSource = command === 'archive-migrate' ? join(state, 'extracted') : state;
          const field = command === 'archive-migrate' ? 'legacyArchiveRoot' : 'legacyStateRoot';
          const args = ['--dry-run', '--format', 'json'];
          if (command === 'library-migrate') args.push('--pdf-root', join(root, 'pdfs'));
          if (explicitSource) args.push('--source-root', expectedSource);
          const before = await readFile(join(state, 'papers.sqlite'));
          let result: unknown;
          if (entry === 'CLI') {
            await main(['--library', 'fsd', command, ...args], { root, output: value => { result = value; },
              execute: async () => { throw new Error('migration dry-run must not execute a task'); } });
          } else {
            result = await (command === 'archive-migrate' ? routeArchiveMigrate : routeLibraryMigrate)(args, { root });
          }
          expect(result).toHaveProperty(field, expectedSource);
          if (command === 'library-migrate') {
            const rewrites = (result as { pathRewrites: { from: string; to: string }[] }).pathRewrites;
            expect(rewrites).toContainEqual({ from: resolve('D:/agent-data/backend/projects/fsd-code2doc'), to: resolve(root) });
            expect(rewrites).toContainEqual({ from: resolve('D:/obsidian/data/fsd-code2doc'), to: paths.vaultRoot });
          }
          expect(await readFile(join(state, 'papers.sqlite'))).toEqual(before);
          expect(existsSync(paths.dataRoot)).toBe(false);
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    }
  }
}
