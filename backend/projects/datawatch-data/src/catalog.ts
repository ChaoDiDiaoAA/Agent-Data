import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { DataWatchPaths, DatasetFile, DatasetManifest } from './contracts.ts';
import { canonicalJson, pathExists, resolveOwnedPath, sha256, sha256File, writeAtomic, writeCanonicalJson } from './util.ts';

const generatedBy = 'datawatch-data';

function fail(code: string): never { throw new Error(code); }
function rawRoot(paths: DataWatchPaths, manifest: DatasetManifest): string {
  return join(paths.originalRoot, manifest.dataset_id);
}
function vaultDatasetRoot(paths: DataWatchPaths, manifest: DatasetManifest): string {
  return join(paths.vaultRoot, manifest.dataset_id);
}
function vaultRawPath(paths: DataWatchPaths, manifest: DatasetManifest, file: DatasetFile): string {
  return resolveOwnedPath(vaultDatasetRoot(paths, manifest), 'raw/' + file.path);
}
function generatedFrontmatter(properties: Record<string, string>): string {
  const lines = ['---', 'generated_by: ' + generatedBy, 'schema_version: 1'];
  for (const [key, value] of Object.entries(properties)) lines.push(key + ': ' + value.split(String.fromCharCode(10)).join(' '));
  lines.push('---', '');
  return lines.join('\n');
}
export function cardContent(manifest: DatasetManifest): string {
  const rawLinks = manifest.files.slice(0, 20).map(file => '- [' + file.path + '](raw/' + file.path + ')');
  const more = manifest.files.length > 20 ? '- ...（共 ' + manifest.files.length + ' 个文件）' : undefined;
  return generatedFrontmatter({
    dataset_id: manifest.dataset_id,
    repository: manifest.repository,
    revision: manifest.revision,
    files: String(manifest.files.length),
    data_kind: manifest.data_kind,
    origin_kind: manifest.origin_kind,
    license: manifest.declared_license,
  }) + '# ' + manifest.dataset_id + '\n\n'
    + '来源：[' + manifest.repository + '](' + manifest.homepage + ')\n\n'
    + '固定版本：' + manifest.revision + '\n\n'
    + '文件：\n' + [...rawLinks, ...(more ? [more] : [])].join('\n') + '\n';
}
function overviewContent(manifests: DatasetManifest[]): string {
  const rows = manifests.map(manifest => '- [' + manifest.dataset_id + '](../' + manifest.dataset_id + '/dataset.md) — ' + manifest.files.length + ' 个文件，版本 ' + manifest.revision);
  return generatedFrontmatter({ dataset_count: String(manifests.length) }) + '# DataWatch 数据集\n\n'
    + '本目录由 DataWatch 生成；数据已按固定 Hugging Face commit 归档。\n\n'
    + (rows.length ? rows.join('\n') : '暂无已获取数据集。') + '\n';
}
async function copyImmutable(source: string, destination: string, expectedBytes: number, expectedSha256: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (await pathExists(destination)) {
    const info = await stat(destination);
    if (!info.isFile() || info.size !== expectedBytes || await sha256File(destination) !== expectedSha256) fail('CATALOG_ASSET_CONFLICT');
    return;
  }
  await copyFile(source, destination);
  const info = await stat(destination);
  if (info.size !== expectedBytes || await sha256File(destination) !== expectedSha256) fail('CATALOG_ASSET_VERIFY_FAILED');
}
interface Asset { path: string; bytes?: number; sha256?: string; }
interface AssetRegistry { generated_by?: string; schema_version?: number; files?: Asset[]; integrity_sha256?: string; }
async function loadAssets(paths: DataWatchPaths): Promise<Map<string, Asset>> {
  try {
    const registry = JSON.parse(await readFile(join(paths.vaultRoot, '.datawatch-assets.json'), 'utf8')) as AssetRegistry;
    return registry.generated_by === generatedBy ? new Map((registry.files ?? []).map(file => [file.path, file])) : new Map();
  } catch { return new Map(); }
}
function assetPath(paths: DataWatchPaths, target: string): string { return relative(paths.vaultRoot, target).replaceAll('\\', '/'); }
async function validateGenerated(path: string): Promise<void> {
  if (await pathExists(path) && !(await readFile(path, 'utf8')).startsWith('---\ngenerated_by: ' + generatedBy + '\n')) fail('CATALOG_USER_FILE_CONFLICT');
}
function contentAsset(path: string, content: string): Asset {
  const bytes = new TextEncoder().encode(content);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}
function expectedRawAssets(manifests: DatasetManifest[]): Asset[] {
  return [...manifests].sort((left, right) => left.dataset_id.localeCompare(right.dataset_id) || left.revision.localeCompare(right.revision)).flatMap(manifest => manifest.files.map(file => ({
    dataset_id: manifest.dataset_id,
    revision: manifest.revision,
    path: manifest.dataset_id + '/raw/' + file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  })));
}
async function validateAsset(path: string, asset: Asset | undefined): Promise<boolean> {
  if (!asset || !(await pathExists(path))) return false;
  const info = await stat(path);
  if (!info.isFile() || !asset.sha256 || info.size !== asset.bytes || await sha256File(path) !== asset.sha256) fail('CATALOG_USER_FILE_CONFLICT');
  return true;
}
async function validateManifestTarget(paths: DataWatchPaths, path: string, datasetId: string, owned: Map<string, Asset>, expected?: DatasetManifest): Promise<void> {
  if (!(await pathExists(path))) return;
  if (await validateAsset(path, owned.get(assetPath(paths, path)))) return;
  if (expected) {
    const expectedAsset = contentAsset(assetPath(paths, path), canonicalJson(expected));
    await validateAsset(path, expectedAsset);
    return;
  }
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { schema_version?: unknown; dataset_id?: unknown };
    if (value.schema_version !== 1 || value.dataset_id !== datasetId) fail('CATALOG_USER_FILE_CONFLICT');
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_USER_FILE_CONFLICT') throw error;
    fail('CATALOG_USER_FILE_CONFLICT');
  }
}
async function validateRegistryTarget(paths: DataWatchPaths, owned: Map<string, Asset>, existingManifests: DatasetManifest[]): Promise<void> {
  const path = join(paths.vaultRoot, '.datawatch-assets.json');
  if (!(await pathExists(path))) return;
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as AssetRegistry;
    if (value.generated_by !== generatedBy) fail('CATALOG_USER_FILE_CONFLICT');
    if (value.integrity_sha256) {
      const { integrity_sha256: integrity, ...body } = value;
      if (integrity !== sha256(new TextEncoder().encode(canonicalJson(body)))) fail('CATALOG_USER_FILE_CONFLICT');
    } else {
      // Historical registries predate an integrity marker. For a flat snapshot,
      // require their full canonical content to match the active manifests before
      // sealing them on the next successful catalog publication.
      if (existingManifests.length) {
        const expected = { generated_by: generatedBy, schema_version: 1, files: expectedRawAssets(existingManifests) };
        const actual = { generated_by: value.generated_by, schema_version: value.schema_version, files: value.files ?? [] };
        if (canonicalJson(actual) !== canonicalJson(expected)) fail('CATALOG_USER_FILE_CONFLICT');
      } else if ((value.files ?? []).some(asset => !asset.path.startsWith('Evidence/'))) {
        fail('CATALOG_USER_FILE_CONFLICT');
      }
      for (const asset of owned.values()) if (asset.path.includes('/raw/') && !asset.path.startsWith('Evidence/')) await validateAsset(resolveOwnedPath(paths.vaultRoot, asset.path), asset);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_USER_FILE_CONFLICT') throw error;
    fail('CATALOG_USER_FILE_CONFLICT');
  }
}
export async function validateCatalogTargets(paths: DataWatchPaths, manifests: DatasetManifest[], existingManifests = manifests): Promise<void> {
  const owned = await loadAssets(paths);
  const priorByDataset = new Map(existingManifests.map(manifest => [manifest.dataset_id, manifest]));
  const overview = join(paths.vaultRoot, 'indexes', 'overview.md');
  if (!(await validateAsset(overview, owned.get(assetPath(paths, overview))))) {
    if (await pathExists(overview) && existingManifests.length) await validateAsset(overview, contentAsset(assetPath(paths, overview), overviewContent(existingManifests)));
    else await validateGenerated(overview);
  }
  await validateRegistryTarget(paths, owned, existingManifests);
  for (const manifest of manifests) {
    const card = join(vaultDatasetRoot(paths, manifest), 'dataset.md');
    if (!(await validateAsset(card, owned.get(assetPath(paths, card))))) {
      const prior = priorByDataset.get(manifest.dataset_id);
      if (await pathExists(card) && prior) await validateAsset(card, contentAsset(assetPath(paths, card), cardContent(prior)));
      else await validateGenerated(card);
    }
    await validateManifestTarget(paths, join(vaultDatasetRoot(paths, manifest), 'manifest.json'), manifest.dataset_id, owned, priorByDataset.get(manifest.dataset_id));
    for (const file of manifest.files) {
      const target = vaultRawPath(paths, manifest, file);
      const registered = owned.get(assetPath(paths, target));
      if (await pathExists(target) && registered) {
        const info = await stat(target);
        if (!info.isFile() || !registered.sha256 || info.size !== registered.bytes || await sha256File(target) !== registered.sha256) {
          fail('CATALOG_USER_FILE_CONFLICT');
        }
      } else if (await pathExists(target)) {
        const info = await stat(target);
        if (!info.isFile() || info.size !== file.bytes || await sha256File(target) !== file.sha256) fail('CATALOG_USER_FILE_CONFLICT');
      }
    }
    const wanted = new Set(manifest.files.map(file => manifest.dataset_id + '/raw/' + file.path));
    for (const [path, asset] of owned) {
      if (!path.startsWith(manifest.dataset_id + '/raw/') || wanted.has(path)) continue;
      const target = resolveOwnedPath(paths.vaultRoot, path);
      if (!(await pathExists(target))) continue;
      const info = await stat(target);
      if (!info.isFile() || !asset.sha256 || info.size !== asset.bytes || await sha256File(target) !== asset.sha256) fail('CATALOG_USER_FILE_CONFLICT');
    }
  }
}
async function copyManaged(source: string, destination: string, expectedBytes: number, expectedSha256: string, owned: Map<string, Asset>, paths: DataWatchPaths): Promise<void> {
  if (await pathExists(destination)) {
    const info = await stat(destination);
    if (info.isFile() && info.size === expectedBytes && await sha256File(destination) === expectedSha256) return;
    if (!owned.has(assetPath(paths, destination))) fail('CATALOG_ASSET_CONFLICT');
    await writeAtomic(destination, await readFile(source));
  } else await copyImmutable(source, destination, expectedBytes, expectedSha256);
  const info = await stat(destination);
  if (info.size !== expectedBytes || await sha256File(destination) !== expectedSha256) fail('CATALOG_ASSET_VERIFY_FAILED');
}
async function writeGenerated(path: string, content: string): Promise<void> {
  if (await pathExists(path)) {
    const existing = await readFile(path, 'utf8');
    if (!existing.startsWith('---\ngenerated_by: ' + generatedBy + '\n')) fail('CATALOG_USER_FILE_CONFLICT');
  }
  await writeAtomic(path, content);
}

export async function buildCatalog(paths: DataWatchPaths, manifests: DatasetManifest[], existingManifests = manifests): Promise<{ datasets: number; files: number }> {
  const ordered = [...manifests].sort((left, right) => left.dataset_id.localeCompare(right.dataset_id) || left.revision.localeCompare(right.revision));
  await validateCatalogTargets(paths, ordered, existingManifests);
  const owned = await loadAssets(paths);
  const overview = join(paths.vaultRoot, 'indexes', 'overview.md');
  await mkdir(join(paths.vaultRoot, 'indexes'), { recursive: true });
  let fileCount = 0;
  for (const manifest of ordered) {
    if (!manifest.files.every(file => typeof file.sha256 === 'string')) fail('CATALOG_MANIFEST_INCOMPLETE');
    const datasetRoot = vaultDatasetRoot(paths, manifest);
    const datasetPath = join(datasetRoot, 'dataset.md');
    await mkdir(join(datasetRoot, 'raw'), { recursive: true });
    for (const file of manifest.files) {
      const source = resolveOwnedPath(rawRoot(paths, manifest), file.path);
      await copyManaged(source, vaultRawPath(paths, manifest, file), file.bytes, file.sha256!, owned, paths);
      fileCount += 1;
    }
    await writeGenerated(datasetPath, cardContent(manifest));
    await writeCanonicalJson(join(datasetRoot, 'manifest.json'), manifest);
    const wanted = new Set(manifest.files.map(file => manifest.dataset_id + '/raw/' + file.path));
    for (const [prior, asset] of owned) {
      if (prior.startsWith(manifest.dataset_id + '/raw/') && !wanted.has(prior)) {
        const target = resolveOwnedPath(paths.vaultRoot, prior);
        if (await pathExists(target)) {
          const info = await stat(target);
          if (!info.isFile() || info.size !== asset.bytes || !asset.sha256 || await sha256File(target) !== asset.sha256) fail('CATALOG_USER_FILE_CONFLICT');
          await rm(target, { force: true });
        }
      }
    }
  }
  const overviewValue = overviewContent(ordered);
  await writeGenerated(overview, overviewValue);
  const files = [...[...owned.values()].filter(asset => !ordered.some(manifest => asset.path.startsWith(manifest.dataset_id + '/raw/') || asset.path === manifest.dataset_id + '/manifest.json') && asset.path !== 'indexes/overview.md'), ...ordered.flatMap(manifest => [
    ...expectedRawAssets([manifest]),
    contentAsset(manifest.dataset_id + '/dataset.md', cardContent(manifest)),
    contentAsset(manifest.dataset_id + '/manifest.json', canonicalJson(manifest)),
  ]), contentAsset('indexes/overview.md', overviewValue)];
  const registry = {
    generated_by: generatedBy,
    schema_version: 1,
    files,
  };
  await writeCanonicalJson(join(paths.vaultRoot, '.datawatch-assets.json'), { ...registry, integrity_sha256: sha256(new TextEncoder().encode(canonicalJson(registry))) });
  return { datasets: ordered.length, files: fileCount };
}

export async function verifyCatalog(paths: DataWatchPaths, manifests: DatasetManifest[]): Promise<{ datasets: number; files: number }> {
  let count = 0;
  for (const manifest of manifests) {
    if (!manifest.files.every(file => typeof file.sha256 === 'string')) fail('VERIFY_MANIFEST_INCOMPLETE');
    for (const file of manifest.files) {
      const source = resolveOwnedPath(rawRoot(paths, manifest), file.path);
      const target = vaultRawPath(paths, manifest, file);
      const sourceInfo = await stat(source);
      const targetInfo = await stat(target);
      if (sourceInfo.size !== file.bytes || targetInfo.size !== file.bytes
        || await sha256File(source) !== file.sha256 || await sha256File(target) !== file.sha256) {
        fail('VERIFY_HASH_MISMATCH');
      }
      count += 1;
    }
  }
  return { datasets: manifests.length, files: count };
}

export async function cleanGeneratedCatalog(paths: DataWatchPaths): Promise<void> {
  if (!(await pathExists(paths.vaultRoot))) return;
  const generated = [join(paths.vaultRoot, 'indexes', 'overview.md'), join(paths.vaultRoot, '.datawatch-assets.json')];
  for (const path of generated) {
    if (await pathExists(path) && (await readFile(path, 'utf8')).startsWith('---\ngenerated_by: ' + generatedBy + '\n')) await rm(path);
  }
}

export function catalogRelativePath(paths: DataWatchPaths, path: string): string {
  return relative(paths.vaultRoot, resolveOwnedPath(paths.vaultRoot, path)).replaceAll('\\', '/');
}
