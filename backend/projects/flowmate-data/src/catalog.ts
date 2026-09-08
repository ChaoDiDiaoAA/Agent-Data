import { lstat, link as hardLink, mkdir, readFile, readdir, realpath, rename, unlink, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, win32, posix } from 'node:path';
import { resolveOwnedPath } from './config.ts';
import type { FlowmatePaths } from './contracts.ts';
import { loadSampleRecords, type FileRef, type SampleRecord } from './task-store.ts';
import type { KnowledgeRecord } from './sources/public-files.ts';
import { loadWithdrawalList, withdrawalListPath } from './backup.ts';
import { withRunLock } from './engine-bridge.ts';

const generatedBy = 'flowmate-data';
const schemaVersion = 1;

export interface CatalogFile { path: string; content: string }
export interface CatalogPlan { vaultRoot: string; directories: string[]; files: CatalogFile[] }

function yaml(value: string): string { return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value); }
function frontmatter(properties: Record<string, string>): string {
  return ['---', `generated_by: ${generatedBy}`, `schema_version: ${schemaVersion}`, ...Object.entries(properties).map(([key, value]) => `${key}: ${yaml(value)}`), '---', ''].join('\n');
}
function fileUrl(path: string): string { return encodeURI(`file:///${path.replaceAll('\\', '/').replace(/^\/+/, '')}`); }
function link(label: string, path: string): string { return `[${label}](${fileUrl(path)})`; }
function ref(paths: FlowmatePaths, value: FileRef): string { return join(value.root === 'original' ? paths.originalRoot : paths.dataRoot, value.path); }
function internal(path: string): string { return `[[${path.replaceAll('\\', '/').replace(/\.md$/, '')}]]`; }
function samplePath(record: SampleRecord): string { return `03_InvoiceSamples/${catalogSegment(record.dataset_id)}/${catalogSegment(record.sample_id)}.md`; }
function sampleParseStatus(record: SampleRecord, withdrawn: boolean): string { return withdrawn ? 'withdrawn' : record.derived_ref ? 'parsed' : record.processing_status === 'failed' ? 'failed' : 'not_parsed'; }

function fail(code: string): never { throw new Error(code); }

function catalogSegment(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || /\p{Cc}/u.test(value)
    || value === '.' || value === '..' || value.includes('/') || value.includes('\\')
    || isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value) || win32.parse(value).root) {
    fail('CATALOG_PATH_INVALID');
  }
  return value;
}

function catalogPath(root: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || /\p{Cc}/u.test(value)) fail('CATALOG_PATH_INVALID');
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) fail('CATALOG_PATH_TRAVERSAL');
  if (isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value) || win32.parse(value).root) fail('CATALOG_PATH_ABSOLUTE');
  let destination: string;
  try { destination = resolveOwnedPath(root, normalized); } catch { fail('CATALOG_PATH_ESCAPE'); }
  const rootResolved = resolve(root);
  const relativePath = relative(rootResolved, destination);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) fail('CATALOG_PATH_ESCAPE');
  return destination;
}

function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }

async function assertVaultBound(vaultRoot: string, candidate: string): Promise<void> {
  const rootReal = await realpath(vaultRoot);
  const candidateReal = await realpath(candidate);
  const relativePath = relative(rootReal, candidateReal);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) fail('CATALOG_PATH_SYMLINK');
}

async function assertNewVaultPathBound(vaultRoot: string, candidate: string): Promise<void> {
  const rootResolved = resolve(vaultRoot);
  const candidateResolved = resolve(candidate);
  const relativePath = relative(rootResolved, candidateResolved);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) fail('CATALOG_PATH_ESCAPE');
  // The leaf does not exist yet, so validate the real parent instead. This
  // still rejects a symlinked parent before the recovery entry is created.
  const rootReal = await realpath(vaultRoot);
  const parentReal = await realpath(dirname(candidateResolved));
  const parentRelative = relative(rootReal, parentReal);
  if (parentRelative === '..' || parentRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(parentRelative)) fail('CATALOG_PATH_SYMLINK');
}

interface CatalogTarget { relativePath: string; absolutePath: string; kind: 'directory' | 'file' }

function validatePlan(plan: CatalogPlan): CatalogTarget[] {
  if (!plan || typeof plan.vaultRoot !== 'string' || (!isAbsolute(plan.vaultRoot) && !win32.isAbsolute(plan.vaultRoot)) || !Array.isArray(plan.directories) || !Array.isArray(plan.files)) fail('CATALOG_PLAN_INVALID');
  const targets: CatalogTarget[] = [];
  for (const value of plan.directories) {
    if (typeof value !== 'string') fail('CATALOG_PLAN_INVALID');
    targets.push({ relativePath: value, absolutePath: catalogPath(plan.vaultRoot, value), kind: 'directory' });
  }
  for (const file of plan.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') fail('CATALOG_PLAN_INVALID');
    targets.push({ relativePath: file.path, absolutePath: catalogPath(plan.vaultRoot, file.path), kind: 'file' });
  }
  const seen = new Map<string, CatalogTarget>();
  for (const target of targets) {
    const key = pathKey(target.absolutePath);
    if (seen.has(key)) fail('CATALOG_DUPLICATE_TARGET');
    seen.set(key, target);
  }
  const files = targets.filter(target => target.kind === 'file');
  for (const file of files) {
    for (const other of targets) {
      if (file === other) continue;
      const child = relative(file.absolutePath, other.absolutePath);
      if (child && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child)) fail('CATALOG_TARGET_CONFLICT');
    }
  }
  return targets;
}

async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []; throw error; }
}

async function knowledgeRecords(paths: FlowmatePaths): Promise<KnowledgeRecord[]> {
  const root = join(paths.dataRoot, 'datasets', 'public-invoice-knowledge');
  const sources = await directories(root);
  const records: KnowledgeRecord[] = [];
  for (const source of sources) {
    const files = await readdir(join(root, source, 'records'), { recursive: true }).catch(error => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    for (const name of files.filter(name => name.endsWith('.json')).sort()) records.push(JSON.parse(await readFile(join(root, source, 'records', name), 'utf8')) as KnowledgeRecord);
  }
  return records.sort((left, right) => `${left.source_id}/${left.file_id}/${left.version}`.localeCompare(`${right.source_id}/${right.file_id}/${right.version}`));
}

async function releases(paths: FlowmatePaths): Promise<Array<{ version: string; manifest: string }>> {
  const root = join(paths.dataRoot, 'releases');
  return (await directories(root)).map(version => ({ version, manifest: join(root, version, 'manifest.json') }));
}

function sampleCard(paths: FlowmatePaths, record: SampleRecord, withdrawn: boolean): CatalogFile {
  const datasetId = catalogSegment(record.dataset_id);
  const sampleId = catalogSegment(record.sample_id);
  const mirror = join(paths.originalRoot, 'datasets', datasetId, 'samples', sampleId, 'structured');
  const lines = [frontmatter({ dataset: record.dataset_id, revision: record.dataset_revision, origin: record.origin_kind, document: record.document_kind, language: record.language, label: record.label_kind, parse: sampleParseStatus(record, withdrawn), status: withdrawn ? 'withdrawn' : 'active', license: record.allowed_uses.join(',') }), `# ${record.sample_id}`, '', `- ${link('Original', ref(paths, record.original_ref))}`];
  if (record.annotation_ref) lines.push(`- ${link('Original annotation', ref(paths, record.annotation_ref))}`);
  else lines.push('- Original annotation: unavailable');
  if (record.label_ref) lines.push(`- ${link('Unified label', ref(paths, record.label_ref))}`);
  else lines.push('- Unified label: unavailable');
  lines.push(`- ${link('Structured mirror', mirror)}`);
  if (record.derived_ref) lines.push(`- ${link('Parse result', ref(paths, record.derived_ref))}`);
  else lines.push(`- Parse result: unavailable (${sampleParseStatus(record, withdrawn)})`);
  lines.push(`- Parse error: ${record.processing_status === 'failed' ? 'recorded failure' : 'none recorded'}`, '');
  return { path: `03_InvoiceSamples/${datasetId}/${sampleId}.md`, content: lines.join('\n') };
}

function knowledgeCard(paths: FlowmatePaths, record: KnowledgeRecord): CatalogFile {
  const sourceId = catalogSegment(record.source_id);
  const fileId = catalogSegment(record.file_id);
  const version = catalogSegment(record.version);
  const name = `${fileId}--${version}`;
  const mirror = join(paths.originalRoot, 'knowledge', sourceId, 'structured', version, fileId);
  const lines = [frontmatter({ source: record.source_id, version: record.version, document: record.document_kind, applicable_period: record.applicable_period, parse: record.parse_status }), `# ${record.file_id}`, '', `- ${link('Original', ref(paths, record.original_ref))}`];
  if (record.derived_ref) lines.push(`- ${link('Structured mirror', mirror)}`);
  else lines.push(`- Structured mirror: unavailable (${record.parse_status})`);
  if (record.derived_ref) lines.push(`- ${link('Parse result', ref(paths, record.derived_ref))}`);
  else lines.push(`- Parse result: unavailable (${record.parse_status})`);
  lines.push('- Original annotation: unavailable', '- Unified label: unavailable');
  lines.push(`- [Source](${record.source_url})`, `- [License evidence](${record.license_evidence})`, '');
  return { path: `04_InvoiceKnowledge/${sourceId}/${name}.md`, content: lines.join('\n') };
}

function index(name: string, entries: string[]): CatalogFile {
  return { path: `01_Index/${name}.md`, content: [frontmatter({ type: 'index' }), `# ${name}`, '', ...entries.map(entry => `- ${entry}`), ''].join('\n') };
}

export async function buildCatalog(paths: FlowmatePaths): Promise<CatalogPlan> {
  const datasetIds = (await directories(join(paths.dataRoot, 'datasets'))).filter(id => id !== 'public-invoice-knowledge');
  const samples = (await Promise.all(datasetIds.map(dataset => loadSampleRecords(paths, dataset)))).flat().sort((left, right) => `${left.dataset_id}/${left.sample_id}`.localeCompare(`${right.dataset_id}/${right.sample_id}`));
  const knowledge = await knowledgeRecords(paths);
  const withdrawals = await loadWithdrawalList(withdrawalListPath(paths.dataRoot));
  const releaseRecords = await releases(paths);
  const files: CatalogFile[] = [
    ...samples.map(record => sampleCard(paths, record, withdrawals.entries.some(entry => entry.dataset_id === record.dataset_id && entry.sample_id === record.sample_id
      && (entry.source_record_id === undefined || entry.source_record_id === record.source_record_id)))),
    ...knowledge.map(record => knowledgeCard(paths, record)),
    ...datasetIds.map(dataset => ({ path: `02_Sources/${catalogSegment(dataset)}.md`, content: [frontmatter({ source: dataset, type: 'dataset' }), `# ${dataset}`, '', ...samples.filter(record => record.dataset_id === dataset).map(record => `- ${internal(samplePath(record))}`), ''].join('\n') })),
    ...[...new Set(knowledge.map(record => record.source_id))].sort().map(source => ({ path: `02_Sources/${catalogSegment(source)}.md`, content: [frontmatter({ source, type: 'knowledge' }), `# ${source}`, '', ...knowledge.filter(record => record.source_id === source).map(record => `- ${internal(`04_InvoiceKnowledge/${catalogSegment(source)}/${catalogSegment(record.file_id)}--${catalogSegment(record.version)}.md`)}`), ''].join('\n') })),
    ...releaseRecords.map(release => ({ path: `05_Releases/${catalogSegment(release.version)}.md`, content: [frontmatter({ version: release.version }), `# ${release.version}`, '', `- ${link('Manifest', release.manifest)}`, ''].join('\n') })),
  ];
  files.push(
    index('Sources', [...datasetIds, ...new Set(knowledge.map(record => record.source_id))].sort().map(source => internal(`02_Sources/${source}.md`))),
    index('Samples', samples.map(record => internal(samplePath(record)))),
    index('Knowledge', knowledge.map(record => internal(`04_InvoiceKnowledge/${catalogSegment(record.source_id)}/${catalogSegment(record.file_id)}--${catalogSegment(record.version)}.md`))),
    index('Releases', releaseRecords.map(release => internal(`05_Releases/${catalogSegment(release.version)}.md`))),
  );
  const plan = { vaultRoot: paths.vaultRoot, directories: ['01_Index', '02_Sources', '03_InvoiceSamples', '04_InvoiceKnowledge', '05_Releases'], files: files.sort((left, right) => left.path.localeCompare(right.path)) };
  validatePlan(plan);
  return plan;
}

/** Build and publish the Vault projection while the machine data roots are quiescent. */
export async function rebuildCatalog(paths: FlowmatePaths, options: { lockHeld?: boolean } = {}): Promise<CatalogPlan> {
  const operation = async () => {
    const plan = await buildCatalog(paths);
    await applyCatalog(plan);
    return plan;
  };
  return options.lockHeld
    ? operation()
    : withRunLock(resolveOwnedPath(paths.dataRoot, 'work/run.lock'), operation, { jobId: 'flowmate-catalog' });
}

function isGenerated(content: string): boolean { return content.startsWith(`---\ngenerated_by: ${generatedBy}\n`); }

export async function applyCatalog(plan: CatalogPlan): Promise<void> {
  const targets = validatePlan(plan);
  await mkdir(plan.vaultRoot, { recursive: true });
  await assertDirectory(plan.vaultRoot, true);
  const lock = join(plan.vaultRoot, '.flowmate-catalog.lock');
  try {
    const lockInfo = await optionalLstat(lock);
    if (lockInfo?.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    await mkdir(lock);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('CATALOG_LOCKED');
    throw error;
  }
  const stagingRoot = join(plan.vaultRoot, `.flowmate-catalog-staging-${crypto.randomUUID()}`);
  try {
    await mkdir(stagingRoot);
    await assertDirectory(stagingRoot);
    for (const target of targets.filter(target => target.kind === 'directory')) await ensureDirectory(target.absolutePath, plan.vaultRoot);
    for (const target of targets.filter(target => target.kind === 'file')) await assertFileOwnership(target.absolutePath);
    for (const target of targets.filter(target => target.kind === 'file')) {
      const file = plan.files.find(candidate => catalogPath(plan.vaultRoot, candidate.path) === target.absolutePath);
      if (!file) fail('CATALOG_PLAN_INVALID');
      await atomicWriteOwned(plan.vaultRoot, target.relativePath, file.content, stagingRoot);
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

interface FileState { exists: boolean; generated: boolean }

async function hardLinkNoReplace(source: string, destination: string): Promise<boolean> {
  try { await hardLink(source, destination); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertDirectory(path: string, root = false): Promise<void> {
  const info = await optionalLstat(path);
  if (!info) { if (root) fail('CATALOG_VAULT_MISSING'); fail('CATALOG_PATH_MISSING'); }
  if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
  if (!info.isDirectory()) fail(root ? 'CATALOG_VAULT_CONFLICT' : 'CATALOG_TARGET_CONFLICT');
}

async function ensureDirectory(path: string, vaultRoot: string): Promise<void> {
  const relativePath = relative(vaultRoot, path);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) fail('CATALOG_PATH_ESCAPE');
  let current = vaultRoot;
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    const info = await optionalLstat(current);
    if (!info) {
      try { await mkdir(current); }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    }
    await assertDirectory(current);
  }
}

async function fileState(path: string): Promise<FileState> {
  const info = await optionalLstat(path);
  if (!info) return { exists: false, generated: false };
  if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
  if (!info.isFile()) fail('CATALOG_USER_FILE_CONFLICT');
  return { exists: true, generated: isGenerated(await readFile(path, 'utf8')) };
}

async function assertFileOwnership(path: string): Promise<FileState> {
  const state = await fileState(path);
  if (state.exists && !state.generated) fail('CATALOG_USER_FILE_CONFLICT');
  return state;
}

async function atomicWriteOwned(vaultRoot: string, relativePath: string, content: string, stagingRoot: string): Promise<void> {
  const destination = catalogPath(vaultRoot, relativePath);
  const parent = dirname(destination);
  await ensureDirectory(parent, vaultRoot);
  await assertVaultBound(vaultRoot, parent);
  const before = await assertFileOwnership(destination);
  if (before.exists) {
    await assertVaultBound(vaultRoot, destination);
    const existing = await readFile(destination, 'utf8');
    if (existing === content) return;
  }
  await assertVaultBound(vaultRoot, stagingRoot);
  const temporary = join(stagingRoot, `.${basename(relativePath)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await ensureDirectory(parent, vaultRoot);
    await assertVaultBound(vaultRoot, parent);
    const recovery = join(vaultRoot, `.flowmate-catalog-recovery-${crypto.randomUUID()}`);
    await assertNewVaultPathBound(vaultRoot, recovery);
    let moved = false;
    let publishedValidationFailed = false;
    try {
      const current = await fileState(destination);
      if (current.exists && !current.generated) fail('CATALOG_USER_FILE_CONFLICT');
      if (current.exists) {
        // Move the prior generated entry to a private recovery name first. A
        // no-replace hard link then refuses to overwrite a file created by a
        // user while the destination was being updated.
        await rename(destination, recovery);
        moved = true;
        const movedState = await fileState(recovery);
        if (!movedState.generated) {
          if (await hardLinkNoReplace(recovery, destination)) { await unlink(recovery); moved = false; }
          fail('CATALOG_USER_FILE_CONFLICT');
        }
      }
      if (!await hardLinkNoReplace(temporary, destination)) {
        if (moved) { await unlink(recovery); moved = false; }
        fail('CATALOG_USER_FILE_CONFLICT');
      }
      // Re-check the published path, but never remove it by pathname after a
      // failed boundary check: a concurrent replacement could turn that
      // pathname into a user file. The recovery entry above remains available
      // for the prior generated file, and the caller receives the failure.
      publishedValidationFailed = true;
      await assertVaultBound(vaultRoot, destination);
      const finalState = await fileState(destination);
      if (!finalState.exists || !finalState.generated) fail('CATALOG_PUBLISH_INVALID');
      publishedValidationFailed = false;
      if (moved) { await unlink(recovery); moved = false; }
    } catch (error) {
      if (moved && !publishedValidationFailed) {
        if (await hardLinkNoReplace(recovery, destination)) {
          await unlink(recovery);
          moved = false;
        }
        // If the destination is occupied, retain the recovery file so the
        // replaced generated/user entry is never silently discarded.
      }
      throw error;
    }
  } finally {
    await unlink(temporary).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
}
