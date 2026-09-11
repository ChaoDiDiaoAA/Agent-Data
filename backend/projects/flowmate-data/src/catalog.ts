import { recoverPublications } from './publication.ts';
import {
  datasetAlias,
  sampleDirectory,
  vaultEvidenceRoot,
  vaultIndexPath,
  vaultIndexesRoot,
  vaultInvoicesRoot,
  vaultKnowledgeRoot,
  vaultReleasesRoot,
} from './layout.ts';
import { copyFile, lstat, link as hardLink, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, win32, posix } from 'node:path';
import { resolveOwnedPath } from './config.ts';
import type { FlowmatePaths } from './contracts.ts';
import { loadSampleRecords, type FileRef, type SampleRecord } from './task-store.ts';
import type { KnowledgeRecord } from './sources/public-files.ts';
import { loadWithdrawalList, withdrawalListPath } from './backup.ts';
import { canonicalJson, replaceFileWithRetry, withRunLock } from './engine-bridge.ts';
import { sha256File } from './file-store.ts';

const generatedBy = 'flowmate-data';
const schemaVersion = 1;

export interface CatalogFile { path: string; content: string }
export interface CatalogAsset { path: string; sourcePath: string; sha256: string; bytes: number }
export interface CatalogPlan { vaultRoot: string; directories: string[]; files: CatalogFile[]; assets: CatalogAsset[] }
export interface CatalogProgress {
  phase: 'plan' | 'sample-assets' | 'knowledge-assets' | 'publish';
  status: 'started' | 'progress' | 'completed';
  current: number;
  total: number;
  item?: string;
  detail?: string;
  elapsedMs: number;
}

interface CatalogBuildOptions {
  onProgress?: (progress: CatalogProgress) => void | Promise<void>;
}

interface CatalogPublishOptions {
  onProgress?: (progress: CatalogProgress) => void | Promise<void>;
}

function yaml(value: string): string { return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value); }
function frontmatter(properties: Record<string, string>): string {
  return ['---', `generated_by: ${generatedBy}`, `schema_version: ${schemaVersion}`, ...Object.entries(properties).map(([key, value]) => `${key}: ${yaml(value)}`), '---', ''].join('\n');
}
function vaultLink(label: string, path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const target = normalized.endsWith('.md') ? normalized.slice(0, -3) : normalized;
  return `[[${target}|${label}]]`;
}
function vaultEmbed(path: string): string { return `![[${path.replaceAll('\\', '/')}]]`; }
function ref(paths: FlowmatePaths, value: FileRef): string {
  const root = value.root === 'original' ? paths.originalRoot : paths.dataRoot;
  return resolveOwnedPath(root, value.path);
}
function internal(path: string): string { return `[[${path.replaceAll('\\', '/').replace(/\.md$/, '')}]]`; }
function samplePath(record: SampleRecord): string {
  return `${vaultInvoicesRoot}/${catalogSegment(datasetAlias(record.dataset_id))}/${catalogSegment(record.sample_id)}/invoice.md`;
}
function sampleParseStatus(record: SampleRecord, withdrawn: boolean): string { return withdrawn ? 'withdrawn' : record.derived_ref ? 'parsed' : record.processing_status === 'failed' ? 'failed' : 'not_parsed'; }

function fail(code: string): never { throw new Error(code); }
function failAsset(code: string, path: string): never { throw new Error(`${code}: ${path}`); }

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

interface CatalogTarget { relativePath: string; absolutePath: string; kind: 'directory' | 'file' | 'asset' }

function validatePlan(plan: CatalogPlan): CatalogTarget[] {
  if (!plan || typeof plan.vaultRoot !== 'string' || (!isAbsolute(plan.vaultRoot) && !win32.isAbsolute(plan.vaultRoot)) || !Array.isArray(plan.directories) || !Array.isArray(plan.files) || !Array.isArray(plan.assets)) fail('CATALOG_PLAN_INVALID');
  const targets: CatalogTarget[] = [];
  for (const value of plan.directories) {
    if (typeof value !== 'string') fail('CATALOG_PLAN_INVALID');
    targets.push({ relativePath: value, absolutePath: catalogPath(plan.vaultRoot, value), kind: 'directory' });
  }
  for (const file of plan.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') fail('CATALOG_PLAN_INVALID');
    targets.push({ relativePath: file.path, absolutePath: catalogPath(plan.vaultRoot, file.path), kind: 'file' });
  }
  for (const asset of plan.assets) {
    if (!asset || typeof asset.path !== 'string' || typeof asset.sourcePath !== 'string'
      || (!isAbsolute(asset.sourcePath) && !win32.isAbsolute(asset.sourcePath))
      || !/^[0-9a-f]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) fail('CATALOG_PLAN_INVALID');
    targets.push({ relativePath: asset.path, absolutePath: catalogPath(plan.vaultRoot, asset.path), kind: 'asset' });
  }
  const seen = new Map<string, CatalogTarget>();
  for (const target of targets) {
    const key = pathKey(target.absolutePath);
    if (seen.has(key)) fail('CATALOG_DUPLICATE_TARGET');
    seen.set(key, target);
  }
  const files = targets.filter(target => target.kind !== 'directory');
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

async function releases(paths: FlowmatePaths): Promise<Array<{ version: string; manifest: string; checksums?: string }>> {
  const root = join(paths.dataRoot, 'releases');
  const entries: Array<{ version: string; manifest: string; checksums?: string }> = [];
  for (const version of await directories(root)) {
    const manifest = join(root, version, 'manifest.json');
    const checksums = join(root, version, 'checksums.json');
    if (await optionalLstat(manifest)) entries.push({ version, manifest, ...(await optionalLstat(checksums) ? { checksums } : {}) });
  }
  return entries;
}

function sampleAssetBase(record: SampleRecord): string {
  return `${vaultInvoicesRoot}/${catalogSegment(datasetAlias(record.dataset_id))}/${catalogSegment(record.sample_id)}`;
}

function sampleCard(record: SampleRecord, withdrawn: boolean): CatalogFile {
  const datasetId = catalogSegment(datasetAlias(record.dataset_id));
  const sampleId = catalogSegment(record.sample_id);
  const assetBase = sampleAssetBase(record);
  const publisherAnnotation = record.publisher_annotation_status ?? (record.annotation_ref || record.annotation_sha256 ? 'annotated' : 'unannotated');
  const originalName = basename(record.original_ref.path.replaceAll('\\', '/'));
  const originalPath = `${assetBase}/${catalogSegment(originalName)}`;
  const lines = [frontmatter({ dataset: record.dataset_id, revision: record.dataset_revision, origin: record.origin_kind, document: record.document_kind, language: record.language, label: record.label_kind, publisher_annotation: publisherAnnotation, parse: sampleParseStatus(record, withdrawn), status: withdrawn ? 'withdrawn' : 'active', license: record.allowed_uses.join(',') }), `# ${record.sample_id}`, '', `- ${extname(originalName).toLowerCase() === '.jpg' || extname(originalName).toLowerCase() === '.jpeg' || extname(originalName).toLowerCase() === '.png' ? vaultEmbed(originalPath) : vaultLink('Original', originalPath)}`];
  if (record.annotation_ref) lines.push(`- ${vaultLink('Original annotation', `${assetBase}/annotation.json`)}`);
  else lines.push('- Original annotation: unavailable');
  if (record.label_ref) lines.push(`- ${vaultLink('Unified label', `${assetBase}/fields.json`)}`);
  else lines.push('- Unified label: unavailable');
  if (record.derived_ref) lines.push(`- ${vaultLink('Structured mirror', `${assetBase}/snapshot.json`)}`);
  else lines.push('- Structured mirror: unavailable');
  if (record.derived_ref) lines.push(`- ${vaultLink('Parse result', `${assetBase}/content.md`)}`);
  else lines.push(`- Parse result: unavailable (${sampleParseStatus(record, withdrawn)})`);
  lines.push(`- Parse error: ${record.processing_status === 'failed' ? 'recorded failure' : 'none recorded'}`, '');
  return { path: `${vaultInvoicesRoot}/${datasetId}/${sampleId}/invoice.md`, content: lines.join('\n') };
}

function knowledgeAssetBase(record: KnowledgeRecord): string {
  return `${vaultKnowledgeRoot}/${catalogSegment(record.source_id)}/${catalogSegment(record.file_id)}--${catalogSegment(record.version)}`;
}

function knowledgeCard(record: KnowledgeRecord): CatalogFile {
  const sourceId = catalogSegment(record.source_id);
  const fileId = catalogSegment(record.file_id);
  const version = catalogSegment(record.version);
  const name = `${fileId}--${version}`;
  const assetBase = knowledgeAssetBase(record);
  const originalName = basename(record.original_ref.path.replaceAll('\\', '/'));
  const originalPath = `${assetBase}/${catalogSegment(originalName)}`;
  const lines = [frontmatter({ source: record.source_id, version: record.version, document: record.document_kind, applicable_period: record.applicable_period, parse: record.parse_status }), `# ${record.file_id}`, '', `- ${vaultLink('Original', originalPath)}`];
  if (record.derived_ref) lines.push(`- ${vaultLink('Structured mirror', `${assetBase}/snapshot.json`)}`);
  else lines.push(`- Structured mirror: unavailable (${record.parse_status})`);
  if (record.derived_ref) lines.push(`- ${vaultLink('Parse result', `${assetBase}/content.md`)}`);
  else lines.push(`- Parse result: unavailable (${record.parse_status})`);
  lines.push('- Original annotation: unavailable', '- Unified label: unavailable');
  lines.push(`- [Source](${record.source_url})`, `- [License evidence](${record.license_evidence})`, '');
  return { path: `${vaultKnowledgeRoot}/${sourceId}/${name}/knowledge.md`, content: lines.join('\n') };
}

interface AssetCollectionOptions { skipNames?: Set<string> }

async function addCatalogAsset(assets: Map<string, CatalogAsset>, destination: string, sourcePath: string, required = false): Promise<CatalogAsset | undefined> {
  const info = await optionalLstat(sourcePath);
  if (!info) {
    if (required) fail('CATALOG_ASSET_SOURCE_MISSING');
    return undefined;
  }
  if (info.isSymbolicLink()) fail('CATALOG_ASSET_SOURCE_SYMLINK');
  if (!info.isFile()) fail('CATALOG_ASSET_SOURCE_INVALID');
  const normalized = destination.replaceAll('\\', '/');
  const candidate = { path: normalized, sourcePath, sha256: await sha256File(sourcePath), bytes: Number(info.size) };
  const existing = assets.get(normalized);
  if (existing && (existing.sha256 !== candidate.sha256 || existing.bytes !== candidate.bytes)) failAsset('CATALOG_ASSET_SOURCE_CONFLICT', normalized);
  if (!existing) assets.set(normalized, candidate);
  return existing ?? candidate;
}

async function collectAssetTree(root: string, destinationRoot: string, assets: Map<string, CatalogAsset>, options: AssetCollectionOptions = {}): Promise<void> {
  const rootInfo = await optionalLstat(root);
  if (!rootInfo) return;
  if (rootInfo.isSymbolicLink()) fail('CATALOG_ASSET_SOURCE_SYMLINK');
  if (!rootInfo.isDirectory()) fail('CATALOG_ASSET_SOURCE_INVALID');
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const relativeName = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('CATALOG_ASSET_SOURCE_SYMLINK');
      if (options.skipNames?.has(relativeName) || (!relativeDirectory && options.skipNames?.has(entry.name))) continue;
      if (entry.isDirectory()) { await visit(source, relativeName); continue; }
      if (!entry.isFile()) fail('CATALOG_ASSET_SOURCE_INVALID');
      await addCatalogAsset(assets, `${destinationRoot}/${relativeName}`, source);
    }
  }
  await visit(root, '');
}

async function collectNormalizedTree(root: string, destinationRoot: string, assets: Map<string, CatalogAsset>): Promise<void> {
  const rootInfo = await optionalLstat(root);
  if (!rootInfo) return;
  if (rootInfo.isSymbolicLink()) fail('CATALOG_ASSET_SOURCE_SYMLINK');
  if (!rootInfo.isDirectory()) fail('CATALOG_ASSET_SOURCE_INVALID');
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const relativeName = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail('CATALOG_ASSET_SOURCE_SYMLINK');
      if (entry.isDirectory()) { await visit(source, relativeName); continue; }
      if (!entry.isFile()) fail('CATALOG_ASSET_SOURCE_INVALID');
      const normalizedName = relativeName === 'full.md' ? 'content.md'
        : relativeName === 'content-list.json' ? 'content.json'
          : relativeName === 'page-marked.txt' ? undefined : relativeName;
      if (!normalizedName || (!['content.md', 'content.json', 'pages.json', 'parse.json'].includes(normalizedName) && !normalizedName.startsWith('assets/'))) continue;
      await addCatalogAsset(assets, `${destinationRoot}/${normalizedName}`, source);
    }
  }
  await visit(root, '');
}

async function buildSampleAssets(paths: FlowmatePaths, record: SampleRecord): Promise<CatalogAsset[]> {
  const base = sampleAssetBase(record);
  const datasetBase = sampleDirectory(record.dataset_id, record.sample_id);
  const assets = new Map<string, CatalogAsset>();
  const annotated = (record.publisher_annotation_status ?? (record.annotation_ref || record.annotation_sha256 ? 'annotated' : 'unannotated')) === 'annotated';
  const originalName = catalogSegment(basename(record.original_ref.path.replaceAll('\\', '/')));
  await addCatalogAsset(assets, `${base}/${originalName}`, ref(paths, record.original_ref), true);
  if (annotated && record.annotation_ref) await addCatalogAsset(assets, `${base}/annotation.json`, ref(paths, record.annotation_ref), true);
  if (annotated && record.label_ref) await addCatalogAsset(assets, `${base}/fields.json`, ref(paths, record.label_ref), true);
  await addCatalogAsset(assets, `${base}/record.json`, resolveOwnedPath(paths.dataRoot, `${datasetBase}/record.json`), true);
  await addCatalogAsset(assets, `${base}/receipt.json`, resolveOwnedPath(paths.dataRoot, `${datasetBase}/receipt.json`));
  await addCatalogAsset(assets, `${base}/snapshot.json`, resolveOwnedPath(paths.originalRoot, `${datasetBase}/snapshot.json`));
  const canonicalNames = new Set(['record.json', 'receipt.json', 'snapshot.json', 'content.md', 'content.json', 'pages.json', 'parse.json', 'annotation.json', 'fields.json', originalName]);
  await collectAssetTree(join(paths.originalRoot, datasetBase), base, assets, { skipNames: canonicalNames });
  await collectAssetTree(join(paths.dataRoot, datasetBase), base, assets, { skipNames: canonicalNames });
  if (record.derived_ref) {
    const derived = ref(paths, record.derived_ref);
    await collectNormalizedTree(derived, base, assets);
    const normalized = [...assets.keys()].filter(path => path === `${base}/content.md` || path === `${base}/content.json` || path === `${base}/pages.json` || path === `${base}/parse.json` || path.startsWith(`${base}/assets/`));
    if (normalized.length === 0) await collectNormalizedTree(join(paths.originalRoot, datasetBase), base, assets);
  }
  return [...assets.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function buildKnowledgeAssets(paths: FlowmatePaths, record: KnowledgeRecord): Promise<CatalogAsset[]> {
  const base = knowledgeAssetBase(record);
  const assets = new Map<string, CatalogAsset>();
  await addCatalogAsset(assets, `${base}/${catalogSegment(basename(record.original_ref.path.replaceAll('\\', '/')))}`, ref(paths, record.original_ref));
  const structured = resolveOwnedPath(paths.originalRoot, `knowledge/${record.source_id}/structured/${record.version}/${record.file_id}`);
  await collectAssetTree(structured, base, assets);
  if (record.derived_ref) await collectNormalizedTree(ref(paths, record.derived_ref), base, assets);
  await addCatalogAsset(assets, `${base}/record.json`, resolveOwnedPath(paths.dataRoot, `datasets/public-invoice-knowledge/${record.source_id}/records/${record.file_id}/${record.version}.json`));
  return [...assets.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildCatalog(paths: FlowmatePaths, options: CatalogBuildOptions = {}): Promise<CatalogPlan> {
  const startedAt = Date.now();
  await options.onProgress?.({ phase: 'plan', status: 'started', current: 0, total: 1, detail: '读取发票和知识记录', elapsedMs: 0 });
  const aliases = (await directories(paths.dataRoot)).filter(id => !['datasets', 'tasks', 'work', 'releases'].includes(id));
  const datasetIds = aliases.map(id => id === 'voxel51' ? 'voxel51-hq-invoice-ocr' : id);
  const samples = (await Promise.all(datasetIds.map(dataset => loadSampleRecords(paths, dataset)))).flat().sort((left, right) => `${left.dataset_id}/${left.sample_id}`.localeCompare(`${right.dataset_id}/${right.sample_id}`));
  const knowledge = await knowledgeRecords(paths);
  const withdrawals = await loadWithdrawalList(withdrawalListPath(paths.dataRoot));
  const releaseRecords = await releases(paths);
  const sampleAssets = await Promise.all(samples.map(async (record, index) => {
    const sampleStartedAt = Date.now();
    const assets = await buildSampleAssets(paths, record);
    // `current` is the stable position in the sorted record list. Asset
    // collection remains concurrent, so the output can report a finished
    // record immediately without making catalog generation sequential.
    await options.onProgress?.({ phase: 'sample-assets', status: 'completed', current: index + 1, total: samples.length, item: record.sample_id, detail: `资产 ${assets.length} 个`, elapsedMs: Date.now() - sampleStartedAt });
    return assets;
  }));
  const knowledgeAssets = await Promise.all(knowledge.map(async (record, index) => {
    const knowledgeStartedAt = Date.now();
    const assets = await buildKnowledgeAssets(paths, record);
    await options.onProgress?.({ phase: 'knowledge-assets', status: 'completed', current: index + 1, total: knowledge.length, item: `${record.source_id}/${record.file_id}`, detail: `资产 ${assets.length} 个`, elapsedMs: Date.now() - knowledgeStartedAt });
    return assets;
  }));
  const assets = [...sampleAssets.flat(), ...knowledgeAssets.flat()];
  for (const release of releaseRecords) {
    const manifest = await addCatalogAsset(new Map(), `${vaultReleasesRoot}/${catalogSegment(release.version)}/manifest.json`, release.manifest, true);
    if (manifest) assets.push(manifest);
    if (release.checksums) {
      const checksum = await addCatalogAsset(new Map(), `${vaultReleasesRoot}/${catalogSegment(release.version)}/checksums.json`, release.checksums, true);
      if (checksum) assets.push(checksum);
    }
  }
  const files: CatalogFile[] = [
    ...samples.map(record => sampleCard(record, withdrawals.entries.some(entry => entry.dataset_id === record.dataset_id && entry.sample_id === record.sample_id
      && (entry.source_record_id === undefined || entry.source_record_id === record.source_record_id)))),
    ...knowledge.map(record => knowledgeCard(record)),
    ...datasetIds.map(dataset => ({ path: `${vaultIndexesRoot}/${catalogSegment(datasetAlias(dataset))}.md`, content: [frontmatter({ source: dataset, type: 'dataset' }), `# ${dataset}`, '', ...samples.filter(record => record.dataset_id === dataset).map(record => `- ${internal(samplePath(record))}`), ''].join('\n') })),
    ...[...new Set(knowledge.map(record => record.source_id))].sort().map(source => ({ path: `${vaultKnowledgeRoot}/${catalogSegment(source)}/index.md`, content: [frontmatter({ source, type: 'knowledge' }), `# ${source}`, '', ...knowledge.filter(record => record.source_id === source).map(record => `- ${internal(`${vaultKnowledgeRoot}/${catalogSegment(source)}/${catalogSegment(record.file_id)}--${catalogSegment(record.version)}/knowledge.md`)}`), ''].join('\n') })),
  ];
  files.push({ path: vaultIndexPath, content: [frontmatter({ type: 'index' }), '# Invoice Data Overview', '', ...datasetIds.map(id => `- ${internal(`${vaultIndexesRoot}/${datasetAlias(id)}.md`)}`), ...samples.map(record => `- ${internal(samplePath(record))}`), ...knowledge.map(record => `- ${internal(`${vaultKnowledgeRoot}/${record.source_id}/${record.file_id}--${record.version}/knowledge.md`)}`), ...releaseRecords.map(release => `- ${vaultLink(`Release ${release.version}`, `${vaultReleasesRoot}/${catalogSegment(release.version)}/manifest.json`)}`), ''].join('\n') });
  const releaseDirectories = releaseRecords.map(release => `${vaultReleasesRoot}/${catalogSegment(release.version)}`);
  const knowledgeDirectories = [...new Set(knowledge.flatMap(record => [
    `${vaultKnowledgeRoot}/${catalogSegment(record.source_id)}`,
    `${vaultKnowledgeRoot}/${catalogSegment(record.source_id)}/${catalogSegment(record.file_id)}--${catalogSegment(record.version)}`,
  ]))];
  const plan = {
    vaultRoot: paths.vaultRoot,
    directories: [
      vaultEvidenceRoot,
      vaultIndexesRoot,
      vaultInvoicesRoot,
      ...(knowledge.length ? [vaultKnowledgeRoot, ...knowledgeDirectories] : []),
      ...(releaseRecords.length ? [vaultReleasesRoot, ...releaseDirectories] : []),
    ],
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    assets: assets.sort((left, right) => left.path.localeCompare(right.path)),
  };
  validatePlan(plan);
  await options.onProgress?.({ phase: 'plan', status: 'completed', current: 1, total: 1, detail: `文件 ${plan.files.length} 个，资产 ${plan.assets.length} 个`, elapsedMs: Date.now() - startedAt });
  return plan;
}

/** Build and publish the Vault projection while the machine data roots are quiescent. */
export async function rebuildCatalog(paths: FlowmatePaths, options: { lockHeld?: boolean; onProgress?: (progress: CatalogProgress) => void | Promise<void> } = {}): Promise<CatalogPlan> {
  const operation = async () => {
    await recoverPublications(paths);
    const plan = await buildCatalog(paths, { onProgress: options.onProgress });
    await applyCatalog(plan, { onProgress: options.onProgress });
    return plan;
  };
  return options.lockHeld
    ? operation()
    : withRunLock(resolveOwnedPath(paths.dataRoot, 'work/run.lock'), operation, { jobId: 'flowmate-catalog' });
}

function isGenerated(content: string): boolean { return content.startsWith(`---\ngenerated_by: ${generatedBy}\n`); }

// Evidence is the only current publishing root. The remaining entries are
// read-only migration roots so a rebuild can remove stale generated files
// from earlier layouts without touching handwritten files.
const managedCatalogRoots = ['Evidence', '01_Index', '02_Sources', '03_InvoiceSamples', '04_InvoiceKnowledge', '05_Releases', '01_总览.md', '02_数据集', '03_发票', '05_发布'] as const;

async function collectObsoleteGenerated(path: string, desired: Set<string>, files: string[], directories: string[]): Promise<void> {
  const info = await optionalLstat(path);
  if (!info) return;
  if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
  if (info.isFile()) {
    if (!desired.has(resolve(path).toLowerCase()) && path.toLowerCase().endsWith('.md') && isGenerated(await readFile(path, 'utf8'))) files.push(path);
    return;
  }
  if (!info.isDirectory()) fail('CATALOG_TARGET_CONFLICT');
  directories.push(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.flowmate-')) continue;
    if (entry.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    await collectObsoleteGenerated(join(path, entry.name), desired, files, directories);
  }
}

async function removeObsoleteGenerated(vaultRoot: string, path: string): Promise<void> {
  await assertVaultBound(vaultRoot, path);
  const recovery = join(vaultRoot, `.flowmate-catalog-recovery-${crypto.randomUUID()}`);
  await assertNewVaultPathBound(vaultRoot, recovery);
  try { await rename(path, recovery); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
  let moved = true;
  try {
    await assertVaultBound(vaultRoot, recovery);
    if (!(await fileState(recovery)).generated) fail('CATALOG_USER_FILE_CONFLICT');
    await unlink(recovery);
    moved = false;
  } catch (error) {
    if (moved && await hardLinkNoReplace(recovery, path)) {
      await unlink(recovery);
      moved = false;
    }
    throw error;
  }
}

async function pruneObsoleteGenerated(plan: CatalogPlan): Promise<void> {
  const desired = new Set(plan.files.map(file => resolve(catalogPath(plan.vaultRoot, file.path)).toLowerCase()));
  const files: string[] = [];
  const directories: string[] = [];
  for (const name of managedCatalogRoots) await collectObsoleteGenerated(catalogPath(plan.vaultRoot, name), desired, files, directories);
  for (const path of files) await removeObsoleteGenerated(plan.vaultRoot, path);
  const desiredDirectories = new Set(plan.directories.map(path => resolve(catalogPath(plan.vaultRoot, path)).toLowerCase()));
  for (const path of directories.sort((left, right) => right.length - left.length)) {
    if (desiredDirectories.has(resolve(path).toLowerCase())) continue;
    try { await rmdir(path); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code)))) throw error; }
  }
}

const catalogLockName = '.flowmate-catalog.lock';
const catalogStagingPrefix = '.flowmate-catalog-staging-';

/**
 * The first catalog implementation used an empty directory as its lock.  A
 * terminated process could leave that directory behind forever, so migrate
 * only an empty legacy directory before acquiring the owner-aware file lock.
 * Non-empty or unexpected entries are treated as a real conflict and are
 * never removed automatically.
 */
async function removeLegacyCatalogLock(lock: string): Promise<void> {
  const info = await optionalLstat(lock);
  if (!info) return;
  if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
  if (!info.isDirectory()) return;
  const entries = await readdir(lock, { withFileTypes: true });
  if (entries.length > 0) fail('CATALOG_LOCKED');
  const quarantine = join(dirname(lock), `.flowmate-catalog-legacy-${crypto.randomUUID()}`);
  await assertNewVaultPathBound(dirname(lock), quarantine);
  try {
    await rename(lock, quarantine);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EEXIST', 'EPERM', 'EACCES'].includes(String(error.code))) fail('CATALOG_LOCKED');
    throw error;
  }
  try {
    const moved = await optionalLstat(quarantine);
    if (!moved || moved.isSymbolicLink() || !moved.isDirectory()) fail('CATALOG_LOCKED');
    if ((await readdir(quarantine)).length > 0) fail('CATALOG_LOCKED');
    await rm(quarantine, { recursive: true, force: true });
  } catch (error) {
    // Keep an unexpected legacy entry available for manual inspection rather
    // than silently deleting it.
    if (error instanceof Error && error.message === 'CATALOG_LOCKED') throw error;
    throw error;
  }
}

/** Remove only staging directories owned by this catalog writer. */
async function removeOrphanedCatalogStaging(vaultRoot: string): Promise<void> {
  const entries = await readdir(vaultRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(catalogStagingPrefix)) continue;
    const path = join(vaultRoot, entry.name);
    if (entry.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    if (!entry.isDirectory()) fail('CATALOG_LOCKED');
    await rm(path, { recursive: true, force: true });
  }
}

async function withCatalogLock<T>(vaultRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = join(vaultRoot, catalogLockName);
  await removeLegacyCatalogLock(lock);
  return withRunLock(lock, async () => {
    await removeOrphanedCatalogStaging(vaultRoot);
    return operation();
  }, { jobId: 'flowmate-catalog' });
}

export async function applyCatalog(plan: CatalogPlan, options: CatalogPublishOptions = {}): Promise<void> {
  const targets = validatePlan(plan);
  await mkdir(plan.vaultRoot, { recursive: true });
  await assertDirectory(plan.vaultRoot, true);
  await withCatalogLock(plan.vaultRoot, async () => {
    const publishStartedAt = Date.now();
    const publishTargets = targets.filter(target => target.kind !== 'directory');
    await options.onProgress?.({ phase: 'publish', status: 'started', current: 0, total: publishTargets.length, detail: `目录 ${plan.directories.length} 个，文件 ${plan.files.length} 个，资产 ${plan.assets.length} 个`, elapsedMs: 0 });
    const previousAssets = await loadAssetManifest(plan.vaultRoot) ?? await inferLegacyAssetManifest(plan);
    const previousByPath = new Map(previousAssets?.assets.map(asset => [pathKey(asset.path), asset]) ?? []);
    const stagingRoot = join(plan.vaultRoot, `${catalogStagingPrefix}${crypto.randomUUID()}`);
    let published = 0;
    const reportPublished = async (target: CatalogTarget): Promise<void> => {
      published += 1;
      await options.onProgress?.({ phase: 'publish', status: 'progress', current: published, total: publishTargets.length, item: target.relativePath, detail: '写入', elapsedMs: Date.now() - publishStartedAt });
    };
    try {
      await mkdir(stagingRoot);
      await assertDirectory(stagingRoot);
      for (const target of targets.filter(target => target.kind === 'directory')) await ensureDirectory(target.absolutePath, plan.vaultRoot);
      for (const target of targets.filter(target => target.kind === 'file')) await assertFileOwnership(target.absolutePath);
      for (const asset of plan.assets) await verifyAssetSource(asset);
      for (const target of targets.filter(target => target.kind === 'file')) {
        const file = plan.files.find(candidate => catalogPath(plan.vaultRoot, candidate.path) === target.absolutePath);
        if (!file) fail('CATALOG_PLAN_INVALID');
        await atomicWriteOwned(plan.vaultRoot, target.relativePath, file.content, stagingRoot);
        await reportPublished(target);
      }
      for (const target of targets.filter(target => target.kind === 'asset')) {
        const asset = plan.assets.find(candidate => catalogPath(plan.vaultRoot, candidate.path) === target.absolutePath);
        if (!asset) fail('CATALOG_PLAN_INVALID');
        await atomicCopyAsset(plan.vaultRoot, asset, stagingRoot, previousByPath.get(pathKey(asset.path)));
        await reportPublished(target);
      }
      await pruneObsoleteAssets(plan.vaultRoot, previousAssets, plan.assets);
      await writeAssetManifest(plan.vaultRoot, plan.assets, stagingRoot);
      await pruneObsoleteGenerated(plan);
      await options.onProgress?.({ phase: 'publish', status: 'completed', current: publishTargets.length, total: publishTargets.length, detail: `文件 ${plan.files.length} 个，资产 ${plan.assets.length} 个`, elapsedMs: Date.now() - publishStartedAt });
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
}

interface FileState { exists: boolean; generated: boolean }

interface AssetManifestEntry { path: string; sha256: string; bytes: number }
interface AssetManifest { schema_version: 1; assets: AssetManifestEntry[] }

function assetManifestPath(vaultRoot: string): string { return join(vaultRoot, '.flowmate-assets.json'); }

function legacyAssetCardPath(assetPath: string): string | undefined {
  const normalized = assetPath.replaceAll('\\', '/');
  if (normalized.startsWith(`${vaultInvoicesRoot}/`)) {
    const parts = normalized.slice(`${vaultInvoicesRoot}/`.length).split('/');
    if (parts.length >= 2) return `${vaultInvoicesRoot}/${parts[0]}/${parts[1]}/invoice.md`;
  }
  if (normalized.startsWith(`${vaultKnowledgeRoot}/`)) {
    const parts = normalized.slice(`${vaultKnowledgeRoot}/`.length).split('/');
    if (parts.length >= 2) return `${vaultKnowledgeRoot}/${parts[0]}/${parts[1]}/knowledge.md`;
  }
  return undefined;
}

/**
 * Reconstruct the previous asset manifest for the first rebuild after the
 * manifest was introduced. Only assets beside a Flowmate-generated card are
 * admitted, so an arbitrary file in the Vault is never silently replaced.
 */
async function inferLegacyAssetManifest(plan: CatalogPlan): Promise<AssetManifest | undefined> {
  const assets: AssetManifestEntry[] = [];
  for (const asset of plan.assets) {
    const destination = catalogPath(plan.vaultRoot, asset.path);
    const info = await optionalLstat(destination);
    if (!info) continue;
    if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    if (!info.isFile()) failAsset('CATALOG_ASSET_CONFLICT', asset.path);
    const cardRelativePath = legacyAssetCardPath(asset.path);
    if (!cardRelativePath) continue;
    const cardPath = catalogPath(plan.vaultRoot, cardRelativePath);
    const card = await optionalLstat(cardPath);
    if (!card) continue;
    if (card.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    if (!card.isFile() || !isGenerated(await readFile(cardPath, 'utf8'))) continue;
    assets.push({ path: asset.path, sha256: await sha256File(destination), bytes: Number(info.size) });
  }
  return assets.length > 0 ? { schema_version: 1, assets } : undefined;
}

async function loadAssetManifest(vaultRoot: string): Promise<AssetManifest | undefined> {
  const path = assetManifestPath(vaultRoot);
  const info = await optionalLstat(path);
  if (!info) return undefined;
  if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
  if (!info.isFile()) fail('CATALOG_ASSET_MANIFEST_CONFLICT');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { fail('CATALOG_ASSET_MANIFEST_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { schema_version?: unknown }).schema_version !== 1 || !Array.isArray((value as { assets?: unknown }).assets)) fail('CATALOG_ASSET_MANIFEST_INVALID');
  const entries = (value as { assets: unknown[] }).assets;
  const seen = new Set<string>();
  const assets: AssetManifestEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { path?: unknown }).path !== 'string' || !/^[0-9a-f]{64}$/.test(String((entry as { sha256?: unknown }).sha256)) || !Number.isSafeInteger((entry as { bytes?: unknown }).bytes) || Number((entry as { bytes: number }).bytes) <= 0) fail('CATALOG_ASSET_MANIFEST_INVALID');
    const pathValue = String((entry as { path: string }).path).replaceAll('\\', '/');
    catalogPath(vaultRoot, pathValue);
    const key = pathKey(pathValue);
    if (seen.has(key)) fail('CATALOG_ASSET_MANIFEST_INVALID');
    seen.add(key);
    assets.push({ path: pathValue, sha256: String((entry as { sha256: string }).sha256), bytes: Number((entry as { bytes: number }).bytes) });
  }
  return { schema_version: 1, assets };
}

async function writeAssetManifest(vaultRoot: string, assets: CatalogAsset[], stagingRoot: string): Promise<void> {
  const path = assetManifestPath(vaultRoot);
  const info = await optionalLstat(path);
  if (info?.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
  if (info && !info.isFile()) fail('CATALOG_ASSET_MANIFEST_CONFLICT');
  await assertVaultBound(vaultRoot, stagingRoot);
  const temporary = join(stagingRoot, `.flowmate-assets.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, canonicalJson({ schema_version: 1, assets: assets.map(asset => ({ path: asset.path, sha256: asset.sha256, bytes: asset.bytes })).sort((left, right) => left.path.localeCompare(right.path)) }), { encoding: 'utf8', flag: 'wx' });
  try { await replaceFileWithRetry(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function pruneObsoleteAssets(vaultRoot: string, previous: AssetManifest | undefined, desired: CatalogAsset[]): Promise<void> {
  if (!previous) return;
  const desiredPaths = new Set(desired.map(asset => pathKey(asset.path)));
  for (const entry of previous.assets) {
    if (desiredPaths.has(pathKey(entry.path))) continue;
    const destination = catalogPath(vaultRoot, entry.path);
    const info = await optionalLstat(destination);
    if (!info) continue;
    if (info.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    if (!info.isFile() || Number(info.size) !== entry.bytes || await sha256File(destination) !== entry.sha256) failAsset('CATALOG_ASSET_CONFLICT', entry.path);
    await assertVaultBound(vaultRoot, destination);
    await unlink(destination);
  }
}

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
  if (resolve(parent) !== resolve(vaultRoot)) await ensureDirectory(parent, vaultRoot);
  if (resolve(parent) !== resolve(vaultRoot)) await assertVaultBound(vaultRoot, parent);
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
    if (resolve(parent) !== resolve(vaultRoot)) await ensureDirectory(parent, vaultRoot);
    if (resolve(parent) !== resolve(vaultRoot)) await assertVaultBound(vaultRoot, parent);
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

async function verifyAssetSource(asset: CatalogAsset): Promise<void> {
  const info = await optionalLstat(asset.sourcePath);
  if (!info) fail('CATALOG_ASSET_SOURCE_MISSING');
  if (info.isSymbolicLink()) fail('CATALOG_ASSET_SOURCE_SYMLINK');
  if (!info.isFile()) fail('CATALOG_ASSET_SOURCE_INVALID');
  if (Number(info.size) !== asset.bytes || await sha256File(asset.sourcePath) !== asset.sha256) fail('CATALOG_ASSET_SOURCE_HASH_MISMATCH');
}

/** Publish an immutable physical copy without replacing a destination file. */
async function atomicCopyAsset(vaultRoot: string, asset: CatalogAsset, stagingRoot: string, previous?: AssetManifestEntry): Promise<void> {
  const destination = catalogPath(vaultRoot, asset.path);
  const parent = dirname(destination);
  if (resolve(parent) !== resolve(vaultRoot)) await ensureDirectory(parent, vaultRoot);
  if (resolve(parent) !== resolve(vaultRoot)) await assertVaultBound(vaultRoot, parent);

  const existing = await optionalLstat(destination);
  if (existing) {
    if (existing.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
    if (!existing.isFile()) failAsset('CATALOG_ASSET_CONFLICT', asset.path);
    await assertVaultBound(vaultRoot, destination);
    if (Number(existing.size) === asset.bytes && await sha256File(destination) === asset.sha256) return;
    if (!previous || Number(existing.size) !== previous.bytes || await sha256File(destination) !== previous.sha256) failAsset('CATALOG_ASSET_CONFLICT', asset.path);
  }

  await assertVaultBound(vaultRoot, stagingRoot);
  const temporary = join(stagingRoot, `.${basename(asset.path)}.${crypto.randomUUID()}.tmp`);
  await copyFile(asset.sourcePath, temporary);
  try {
    const staged = await optionalLstat(temporary);
    if (!staged || staged.isSymbolicLink() || !staged.isFile() || Number(staged.size) !== asset.bytes || await sha256File(temporary) !== asset.sha256) {
      fail('CATALOG_ASSET_SOURCE_HASH_MISMATCH');
    }
    await assertNewVaultPathBound(vaultRoot, destination);
    const recovery = join(vaultRoot, `.flowmate-catalog-asset-recovery-${crypto.randomUUID()}`);
    let moved = false;
    try {
      if (existing) {
        await assertVaultBound(vaultRoot, destination);
        await assertNewVaultPathBound(vaultRoot, recovery);
        await rename(destination, recovery);
        moved = true;
      }
      await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (moved) {
        await unlink(destination).catch(unlinkError => {
          if (!(unlinkError && typeof unlinkError === 'object' && 'code' in unlinkError && unlinkError.code === 'ENOENT')) throw unlinkError;
        });
        await rename(recovery, destination).catch(() => undefined);
        moved = false;
      }
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      const raced = await optionalLstat(destination);
      if (raced?.isSymbolicLink()) fail('CATALOG_PATH_SYMLINK');
      if (!raced?.isFile() || Number(raced.size) !== asset.bytes || await sha256File(destination) !== asset.sha256) failAsset('CATALOG_ASSET_CONFLICT', asset.path);
      return;
    }
    if (moved) { await unlink(recovery); moved = false; }
    await assertVaultBound(vaultRoot, destination);
    const published = await optionalLstat(destination);
    if (!published || published.isSymbolicLink() || !published.isFile() || Number(published.size) !== asset.bytes || await sha256File(destination) !== asset.sha256) fail('CATALOG_ASSET_PUBLISH_INVALID');
  } finally {
    await unlink(temporary).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
}
