import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertProcessSafety, createProcessContext } from './process.ts';
import { currentOwner, processIdentity, type ProcessOwner } from './run-lock.ts';

export interface OpenCliInstallation {
  schemaVersion: 1; version: string; sourceHash: string; outputHash: string;
  projectRoot: string; homeRoot: string; adapterRoot: string; entrypoint: string;
}
export interface OpenCliRuntime {
  executable: string; prefixArgs: string[]; cwd: string;
  env: Record<string, string>; installation: OpenCliInstallation;
}
export interface OpenCliInput { projectRoot: string; tempRoot: string }
export interface OpenCliManifest extends OpenCliInstallation { installationHash: string }
export const openCliVersion = '1.8.6';
export const profilePackage = `${JSON.stringify({ name: 'opencli-user-runtime', private: true, type: 'module' }, null, 2)}\n`;

// Windows process start-time inspection uses the native Bun FFI boundary and
// can take several seconds on a cold process. Warm the identity while this module is
// being loaded so normal lease operations do not consume a test/request
// timeout merely to stamp their owner metadata. Failure remains fail-closed:
// withOpenCliLease retries currentOwner() when the warm-up was unavailable.
let warmedOwner: ProcessOwner | undefined;
try { warmedOwner = currentOwner(); } catch { /* resolved at lease acquisition */ }

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
export const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
function bunIdentity(): void {
  if (!process.versions.bun || typeof Bun === 'undefined') throw new Error('OpenCLI requires the Bun runtime');
}

export function resolveOpenCliPackage(projectRoot: string): { packageRoot: string; entrypoint: string; version: string } {
  const root = resolve(projectRoot);
  const ownPackage: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dependencies = (ownPackage as { dependencies?: Record<string, unknown> }).dependencies;
  if (dependencies?.['@jackwener/opencli'] !== openCliVersion) throw new Error(`OpenCLI dependency version must be exactly ${openCliVersion}`);
  try {
    const local = join(root, 'node_modules', '@jackwener', 'opencli');
    lstatSync(local); // Never let createRequire walk up to an ancestor dependency.
    const packageRoot = realpathSync(local);
    const metadata: { name?: unknown; version?: unknown; main?: unknown; bin?: { opencli?: unknown } } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    if (metadata.name !== '@jackwener/opencli' || metadata.version !== openCliVersion) throw new Error(`OpenCLI package version must be ${openCliVersion}`);
    if (typeof metadata.bin?.opencli !== 'string' || metadata.main !== metadata.bin.opencli) throw new Error('Invalid OpenCLI package entrypoint');
    const entrypoint = realpathSync(createRequire(join(root, 'package.json')).resolve('@jackwener/opencli'));
    if (!inside(packageRoot, entrypoint) || entrypoint !== realpathSync(join(packageRoot, metadata.bin.opencli))) throw new Error('OpenCLI package resolved outside the owned dependency');
    return { packageRoot, entrypoint, version: openCliVersion };
  } catch (error) {
    throw new Error(`OpenCLI local dependency/package unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Validate ancestors before any mkdir/rename/removal; managed dependency junctions
// are inspected separately and are never traversed for cleanup.
export async function assertPlainPath(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`OpenCLI refuses reparse path: ${current}`); }
    catch (error) { if (!absent(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function openCliPaths(input: OpenCliInput) {
  if (!isAbsolute(input.projectRoot) || !isAbsolute(input.tempRoot)) throw new Error('OpenCLI paths must be absolute');
  const projectRoot = resolve(input.projectRoot);
  const projectRootHash = createHash('sha256').update(process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot).digest('hex');
  const homeRoot = join(resolve(input.tempRoot), 'opencli-home', projectRootHash);
  const profileRoot = join(homeRoot, '.opencli');
  return { projectRoot, homeRoot, profileRoot, adapterRoot: join(profileRoot, 'clis', 'arxiv'), link: join(profileRoot, 'node_modules', '@jackwener', 'opencli') };
}

export async function withOpenCliLease<T>(input: OpenCliInput, operation: () => Promise<T>): Promise<T> {
  bunIdentity();
  const { homeRoot, projectRoot } = openCliPaths(input);
  await assertPlainPath(homeRoot);
  await mkdir(homeRoot, { recursive: true });
  const path = join(homeRoot, '.lease.json');
  const owner = warmedOwner ?? currentOwner();
  const identity = JSON.stringify({ schemaVersion: 1, id: randomUUID(), projectRoot, owner });
  const reclaimInterruptedLease = async (): Promise<void> => {
    let existing: string;
    try { existing = await readFile(path, 'utf8'); } catch (error) { if (absent(error)) return; throw error; }
    let record: unknown;
    try { record = JSON.parse(existing); } catch { throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying'); }
    if (!record || typeof record !== 'object' || Array.isArray(record) || Reflect.get(record, 'schemaVersion') !== 1
      || Reflect.get(record, 'projectRoot') !== projectRoot) throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying');
    const leaseOwner = Reflect.get(record, 'owner');
    if (!leaseOwner || typeof leaseOwner !== 'object' || Array.isArray(leaseOwner)
      || !Number.isSafeInteger(Reflect.get(leaseOwner, 'pid')) || typeof Reflect.get(leaseOwner, 'startedAt') !== 'string') {
      throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying');
    }
    const ownerPid = Number(Reflect.get(leaseOwner, 'pid'));
    if (processIdentity(ownerPid) !== null) throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying');
    await assertProcessSafety(createProcessContext(projectRoot));
    const guardPath = `${path}.recovery`;
    await assertPlainPath(guardPath);
    const guard = await open(guardPath, 'wx').catch(() => { throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying'); });
    try {
      if (await readFile(path, 'utf8') !== existing || processIdentity(ownerPid) !== null) throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying');
      await assertProcessSafety(createProcessContext(projectRoot));
      await unlink(path);
    } finally { await guard.close(); await unlink(guardPath).catch(() => undefined); }
  };
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (!absent(error) && (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await reclaimInterruptedLease();
    handle = await open(path, 'wx').catch(() => { throw new Error('OpenCLI lease busy or interrupted; inspect the isolated profile before retrying'); });
  }
  let durable = false;
  try {
    await handle.writeFile(identity); await handle.sync(); durable = true;
    await assertProcessSafety(createProcessContext(projectRoot));
    return await operation();
  } finally {
    await handle.close();
    // Failed/partial writes remain a conservative interruption marker.
    if (durable && await readFile(path, 'utf8') === identity) await unlink(path);
  }
}

async function hashFiles(root: string, names: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const name of names) {
    const path = join(root, name); await assertPlainPath(path);
    hash.update(name).update('\0').update(await readFile(path)).update('\0');
  }
  return hash.digest('hex');
}
export async function openCliSourceHashes(input: OpenCliInput) {
  const sourceHash = await hashFiles(input.projectRoot, ['opencli/arxiv/harvest.ts', 'opencli/arxiv/retry.ts', 'scripts/build-opencli-adapter.ts']);
  const lockHash = await hashFiles(input.projectRoot, ['bun.lock']);
  const installationHash = createHash('sha256').update(JSON.stringify([sourceHash, process.versions.bun, openCliVersion, lockHash])).digest('hex');
  return { sourceHash, installationHash };
}
export async function openCliHashes(input: OpenCliInput, outputRoot: string) {
  return { ...await openCliSourceHashes(input), outputHash: await hashFiles(outputRoot, ['harvest.js', 'retry.js']) };
}
export async function verifyOpenCliLink(input: OpenCliInput, packageRoot: string): Promise<void> {
  const { link, profileRoot } = openCliPaths(input);
  await assertPlainPath(dirname(link));
  const ownershipPath = join(profileRoot, 'managed-link.json');
  await assertPlainPath(ownershipPath);
  const ownership: unknown = JSON.parse(await readFile(ownershipPath, 'utf8'));
  if (JSON.stringify(ownership) !== JSON.stringify({ schemaVersion: 1, projectRoot: resolve(input.projectRoot), packageRoot })) throw new Error('Unknown OpenCLI package link ownership');
  if (!(await lstat(link)).isSymbolicLink() || await realpath(link) !== packageRoot) throw new Error('OpenCLI package link is not the owned dependency');
  await assertPlainPath(join(profileRoot, 'package.json'));
  if (await readFile(join(profileRoot, 'package.json'), 'utf8') !== profilePackage) throw new Error('OpenCLI profile package manifest mismatch');
}

async function validatedRuntime(input: OpenCliInput): Promise<OpenCliRuntime> {
  const paths = openCliPaths(input);
  const pkg = resolveOpenCliPackage(input.projectRoot);
  await assertPlainPath(paths.adapterRoot);
  let manifest: OpenCliManifest;
  try {
    await assertPlainPath(join(paths.adapterRoot, 'manifest.json'));
    manifest = JSON.parse(await readFile(join(paths.adapterRoot, 'manifest.json'), 'utf8')) as OpenCliManifest;
  } catch { throw new Error('OpenCLI installation manifest missing or invalid; run bun run opencli:prepare'); }
  for (const [key, expected] of Object.entries({ schemaVersion: 1, version: pkg.version, projectRoot: paths.projectRoot, homeRoot: paths.homeRoot, adapterRoot: paths.adapterRoot, entrypoint: pkg.entrypoint })) {
    if (!manifest || manifest[key as keyof OpenCliManifest] !== expected) throw new Error(`OpenCLI installation manifest mismatch: ${key}`);
  }
  await verifyOpenCliLink(input, pkg.packageRoot);
  const hashes = await openCliHashes(input, paths.adapterRoot);
  for (const key of ['sourceHash', 'installationHash', 'outputHash'] as const) {
    if (manifest[key] !== hashes[key]) throw new Error(`OpenCLI installation stale ${key}; run bun run opencli:prepare`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, { HOME: paths.homeRoot, USERPROFILE: paths.homeRoot, CI: '1', TEMP: input.tempRoot, TMP: input.tempRoot });
  return { executable: process.execPath, prefixArgs: [pkg.entrypoint], cwd: paths.projectRoot, env, installation: manifest };
}

export async function loadOpenCliRuntime(input: OpenCliInput): Promise<OpenCliRuntime> {
  return withOpenCliLease(input, () => validatedRuntime(input));
}
/** Hold validation and the entire supervised invocation in one install/use lease. */
export async function withOpenCliRuntime<T>(input: OpenCliInput, operation: (runtime: OpenCliRuntime) => Promise<T>): Promise<T> {
  return withOpenCliLease(input, async () => operation(await validatedRuntime(input)));
}
