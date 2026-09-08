import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectPaths } from '../src/shared/config.ts';
import { absent, assertPlainPath, openCliHashes, openCliSourceHashes, openCliPaths, profilePackage, resolveOpenCliPackage, verifyOpenCliLink, withOpenCliLease } from '../src/runtime/opencli.ts';
import type { OpenCliInput, OpenCliInstallation, OpenCliManifest } from '../src/runtime/opencli.ts';

async function removeOwnedDirectory(path: string): Promise<void> {
  await assertPlainPath(path);
  const names = await readdir(path);
  if (names.some(name => !['harvest.js', 'retry.js', 'manifest.json'].includes(name))) throw new Error('Unknown OpenCLI staging contents; retained for inspection');
  for (const name of names) {
    const file = join(path, name); await assertPlainPath(file);
    if (!(await lstat(file)).isFile()) throw new Error('Unknown OpenCLI staging file');
  }
  for (const name of names) await unlink(join(path, name));
  await rmdir(path);
}

export async function buildOpenCliAdapter(input: OpenCliInput): Promise<OpenCliInstallation> {
  return withOpenCliLease(input, async () => {
    const paths = openCliPaths(input);
    const pkg = resolveOpenCliPackage(input.projectRoot);
    await assertPlainPath(paths.adapterRoot);
    await assertPlainPath(dirname(paths.link));
    await mkdir(dirname(paths.adapterRoot), { recursive: true });
    let previous = false;
    try {
      await lstat(paths.adapterRoot);
      await assertPlainPath(join(paths.adapterRoot, 'manifest.json'));
      const old: OpenCliManifest = JSON.parse(await readFile(join(paths.adapterRoot, 'manifest.json'), 'utf8'));
      if (old.schemaVersion !== 1 || old.projectRoot !== paths.projectRoot || old.homeRoot !== paths.homeRoot || old.adapterRoot !== paths.adapterRoot) throw new Error('Refusing unknown OpenCLI installation');
      previous = true;
    } catch (error) {
      if (!absent(error)) throw error;
      // An existing directory without an ownership manifest must not be replaced.
      try { await lstat(paths.adapterRoot); throw new Error('Refusing unowned OpenCLI adapter directory'); }
      catch (missing) { if (!absent(missing)) throw missing; }
    }
    try { await lstat(paths.link); await verifyOpenCliLink(input, pkg.packageRoot); }
    catch (error) {
      if (!absent(error)) throw error;
      // A dangling/unknown link is never adopted or recursively deleted.
      try { await lstat(paths.link); throw new Error('Refusing unknown OpenCLI package link'); }
      catch (missing) { if (!absent(missing)) throw missing; }
      await mkdir(dirname(paths.link), { recursive: true });
      const packagePath = join(paths.profileRoot, 'package.json');
      await assertPlainPath(packagePath);
      try { if (await readFile(packagePath, 'utf8') !== profilePackage) throw new Error('Refusing unknown OpenCLI profile package'); }
      catch (missing) { if (!absent(missing)) throw missing; await writeFile(packagePath, profilePackage, { flag: 'wx' }); }
      await symlink(pkg.packageRoot, paths.link, process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(paths.profileRoot, 'managed-link.json'), JSON.stringify({ schemaVersion: 1, projectRoot: paths.projectRoot, packageRoot: pkg.packageRoot }), { flag: 'wx' });
      await verifyOpenCliLink(input, pkg.packageRoot);
    }
    const stagingRoot = join(paths.homeRoot, `.staging-${randomUUID()}`);
    const previousRoot = join(paths.homeRoot, `.previous-${randomUUID()}`);
    await mkdir(stagingRoot);
    let switched = false;
    try {
      const inputsBefore = await openCliSourceHashes(input);
      const result = await Bun.build({
        entrypoints: [join(input.projectRoot, 'opencli/arxiv/harvest.ts'), join(input.projectRoot, 'opencli/arxiv/retry.ts')],
        outdir: stagingRoot, target: 'bun', format: 'esm', naming: '[name].js', external: ['@jackwener/opencli/*'],
      }).catch((cause: unknown) => { throw new Error('OpenCLI adapter build failed', { cause }); });
      if (!result.success) throw new Error(`OpenCLI adapter build failed: ${result.logs.map(String).join('\n')}`);
      const manifest: OpenCliManifest = { schemaVersion: 1, version: pkg.version, projectRoot: paths.projectRoot, homeRoot: paths.homeRoot, adapterRoot: paths.adapterRoot, entrypoint: pkg.entrypoint, ...await openCliHashes(input, stagingRoot) };
      if (manifest.installationHash !== inputsBefore.installationHash) throw new Error('OpenCLI sources changed during build; installation retained');
      await writeFile(join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      if (previous) await rename(paths.adapterRoot, previousRoot);
      try { await rename(stagingRoot, paths.adapterRoot); switched = true; }
      catch (error) { if (previous) await rename(previousRoot, paths.adapterRoot); throw error; }
      if (previous) await removeOwnedDirectory(previousRoot);
      return manifest;
    } finally {
      if (!switched) await removeOwnedDirectory(stagingRoot);
    }
  });
}

if (import.meta.main) {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const installation = await buildOpenCliAdapter({ projectRoot, tempRoot: loadProjectPaths({ root: projectRoot }).tempRoot });
  console.log(JSON.stringify(installation, null, 2));
}
