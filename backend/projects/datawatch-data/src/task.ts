import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataWatchPaths, DatasetFile, DatasetId, DatasetManifest, DatasetResult, SourceConfig, TaskResult, TaskRun, TaskStage, TaskStageStatus, WorkbenchConfig } from './contracts.ts';
import { createSourceHttp } from './http.ts';
import { fetchRepositoryTree, resolveHuggingFaceRevision, toDatasetFiles } from './huggingface.ts';
import { createDownloader, type Downloader } from './downloader.ts';
import { buildCatalog, validateCatalogTargets, verifyCatalog } from './catalog.ts';
import { errorRecord, pathExists, readJson, resolveOwnedPath, sha256File, writeCanonicalJson } from './util.ts';
import { createBackupUnlocked } from './backup.ts';
import { configHash } from './config.ts';
import { withRunLock, type HttpScope } from './engine-bridge.ts';

export interface TaskOptions {
  paths: DataWatchPaths;
  sources: SourceConfig[];
  datasetIds: DatasetId[];
  workbench: WorkbenchConfig;
  network?: HttpScope['network'];
  httpFactory?: (source: SourceConfig) => ReturnType<typeof createSourceHttp>;
  downloaderFactory?: (source: SourceConfig, http: ReturnType<typeof createSourceHttp>) => Downloader;
  now?: () => Date;
  signal?: AbortSignal;
  runId?: string;
}

const stages: TaskStage[] = ['probe', 'acquire', 'catalog', 'verify'];

function fail(code: string): never { throw new Error(code); }
function runRoot(paths: DataWatchPaths): string { return join(paths.dataRoot, 'runs'); }
function runPath(paths: DataWatchPaths, runId: string): string { return resolveOwnedPath(runRoot(paths), runId + '.json'); }
function datasetRoot(paths: DataWatchPaths, datasetId: DatasetId): string {
  return join(paths.dataRoot, datasetId);
}
function originalRoot(paths: DataWatchPaths, datasetId: DatasetId): string {
  return join(paths.originalRoot, datasetId);
}
function stageRoot(paths: DataWatchPaths, datasetId: DatasetId, revision: string): string { return join(paths.dataRoot, 'work', 'snapshots', datasetId, revision); }
function stageRawRoot(paths: DataWatchPaths, manifest: DatasetManifest): string { return join(stageRoot(paths, manifest.dataset_id, manifest.revision), 'raw'); }
function stageManifestPath(paths: DataWatchPaths, datasetId: DatasetId, revision: string): string { return join(stageRoot(paths, datasetId, revision), 'manifest.json'); }
function initialStages(): Record<TaskStage, TaskStageStatus> {
  return { probe: 'pending', acquire: 'pending', catalog: 'pending', verify: 'pending' };
}
function timestampId(now: Date): string {
  return 'run-' + now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
}
function identitiesEqual(left: DatasetId[], right: DatasetId[]): boolean {
  return [...left].sort().join(',') === [...right].sort().join(',');
}
async function saveRun(paths: DataWatchPaths, run: TaskRun): Promise<void> {
  run.updated_at = new Date().toISOString();
  await writeCanonicalJson(runPath(paths, run.run_id), run);
}
async function latestIncomplete(paths: DataWatchPaths, datasetIds: DatasetId[], hash: string): Promise<TaskRun | undefined> {
  let entries: string[] = [];
  try { entries = await readdir(runRoot(paths)); } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const candidates: TaskRun[] = [];
  for (const name of entries.filter(item => item.endsWith('.json'))) {
    try {
      const run = await readJson<TaskRun>(join(runRoot(paths), name));
      if (run.schema_version === 1 && run.status !== 'completed' && run.config_sha256 === hash
        && identitiesEqual(run.dataset_ids, datasetIds)) candidates.push(run);
    } catch {
      // A malformed old run cannot block a new run; status reports it separately.
    }
  }
  return candidates.sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
}
function addError(run: TaskRun, datasetId: DatasetId | undefined, path: string | undefined, error: unknown): void {
  const record = errorRecord(error);
  run.errors ??= [];
  const item = { ...(datasetId ? { dataset_id: datasetId } : {}), ...(path ? { path } : {}), ...record };
  if (!run.errors.some(existing => existing.dataset_id === item.dataset_id && existing.path === item.path && existing.code === item.code && existing.message === item.message)) {
    run.errors.push(item);
  }
}
async function loadManifest(paths: DataWatchPaths, datasetId: DatasetId, revision?: string): Promise<DatasetManifest> {
  const manifest = await readJson<DatasetManifest>(join(datasetRoot(paths, datasetId), 'manifest.json'));
  if (revision && manifest.revision !== revision) throw new Error('MANIFEST_REVISION_MISMATCH');
  return manifest;
}
async function saveManifest(paths: DataWatchPaths, manifest: DatasetManifest): Promise<void> {
  const directory = datasetRoot(paths, manifest.dataset_id);
  await mkdir(directory, { recursive: true });
  await writeCanonicalJson(join(directory, 'manifest.json'), manifest);
  const indexPath = join(paths.dataRoot, 'versions.json');
  let index: { schema_version: 1; datasets: Record<string, Array<{ revision: string; retrieved_at: string; files: number; bytes: number }>> } = { schema_version: 1, datasets: {} };
  try { index = await readJson<typeof index>(indexPath); } catch { /* first version */ }
  const versions = index.datasets[manifest.dataset_id] ?? [];
  const record = { revision: manifest.revision, retrieved_at: manifest.retrieved_at, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
  const position = versions.findIndex(item => item.revision === record.revision);
  if (position >= 0) versions[position] = record; else versions.push(record);
  index.datasets[manifest.dataset_id] = versions.sort((left, right) => right.retrieved_at.localeCompare(left.retrieved_at));
  await writeCanonicalJson(indexPath, index);
}
function fileDestination(paths: DataWatchPaths, manifest: DatasetManifest, file: DatasetFile): string {
  return resolveOwnedPath(stageRawRoot(paths, manifest), file.path);
}
function fileTemporaryPath(paths: DataWatchPaths, manifest: DatasetManifest, file: DatasetFile): string {
  const root = join(paths.dataRoot, 'work', 'downloads', manifest.dataset_id, manifest.revision);
  return resolveOwnedPath(root, file.path) + '.part';
}
async function probeDataset(options: TaskOptions, source: SourceConfig, revision: string): Promise<DatasetManifest> {
  const http = (options.httpFactory ?? (item => createSourceHttp(item, { network: options.network })))(source);
  const entries = await fetchRepositoryTree(source, revision, http, options.workbench.max_response_bytes, options.workbench.request_timeout_ms);
  const retrievedAt = (options.now ?? (() => new Date()))().toISOString();
  let previous: DatasetManifest | undefined;
  try { previous = await readJson<DatasetManifest>(stageManifestPath(options.paths, source.dataset_id, revision)); }
  catch { try { previous = await loadManifest(options.paths, source.dataset_id, revision); } catch { previous = undefined; } }
  const previousFiles = new Map(previous?.files.map(file => [file.path, file]));
  const files = toDatasetFiles(source, revision, entries).map(file => {
    const prior = previousFiles.get(file.path);
    if (!prior || prior.bytes !== file.bytes) return file;
    const reused: DatasetFile = { ...file };
    if (prior.sha256) reused.sha256 = prior.sha256;
    if (prior.retrieved_at) reused.retrieved_at = prior.retrieved_at;
    return reused;
  });
  const manifest: DatasetManifest = {
    schema_version: 1,
    dataset_id: source.dataset_id,
    source_id: source.source_id,
    repository: source.repository,
    revision,
    homepage: source.homepage,
    declared_license: source.declared_license,
    license_evidence: source.license_evidence,
    data_kind: source.data_kind,
    origin_kind: source.origin_kind,
    retrieved_at: retrievedAt,
    files,
  };
  await writeCanonicalJson(stageManifestPath(options.paths, source.dataset_id, revision), manifest);
  return manifest;
}
async function acquireDataset(options: TaskOptions & { run: TaskRun }, source: SourceConfig, manifest: DatasetManifest): Promise<{ files: number; bytes: number; skipped: number }> {
  const http = (options.httpFactory ?? (item => createSourceHttp(item, { network: options.network })))(source);
  const downloader = (options.downloaderFactory ?? ((item, transport) => createDownloader({
    get: (url, request) => transport.get(url, request),
  })))(source, http);
  let skipped = 0;
  let bytes = 0;
  for (const file of manifest.files) {
    if (options.signal?.aborted) throw new Error('TASK_ABORTED');
    try {
      const destination = fileDestination(options.paths, manifest, file);
      if (file.sha256 && !(await pathExists(destination))) {
        const current = resolveOwnedPath(originalRoot(options.paths, manifest.dataset_id), file.path);
        if (await pathExists(current) && await sha256File(current) === file.sha256) {
          await mkdir(join(destination, '..'), { recursive: true });
          await copyFile(current, destination);
        }
      }
      const receipt = await downloader.download({
        url: file.url,
        destination,
        temporaryPath: fileTemporaryPath(options.paths, manifest, file),
        expectedBytes: file.bytes,
        ...(file.sha256 ? { expectedSha256: file.sha256 } : {}),
        maxBytes: options.workbench.max_response_bytes,
        timeoutMs: options.workbench.request_timeout_ms,
        allowedOrigins: source.allowed_origins,
        redirectOrigins: source.redirect_origins,
      });
      file.sha256 = receipt.sha256;
      if (!receipt.skipped || !file.retrieved_at || file.retrieved_at === new Date(0).toISOString()) {
        file.retrieved_at = receipt.skipped
          ? (options.now ?? (() => new Date()))().toISOString()
          : receipt.retrieved_at;
      }
      bytes += receipt.bytes;
      if (receipt.skipped) skipped += 1;
      await writeCanonicalJson(stageManifestPath(options.paths, manifest.dataset_id, manifest.revision), manifest);
    } catch (error) {
      addError(options.run, manifest.dataset_id, file.path, error);
      await saveRun(options.paths, options.run);
      throw error;
    }
  }
  return { files: manifest.files.length, bytes, skipped };
}

async function activateDataset(paths: DataWatchPaths, manifest: DatasetManifest): Promise<void> {
  const staged = stageRawRoot(paths, manifest);
  if (!(await pathExists(staged))) throw new Error('STAGING_SNAPSHOT_MISSING');
  const current = originalRoot(paths, manifest.dataset_id);
  const previous = join(stageRoot(paths, manifest.dataset_id, manifest.revision), 'previous-original');
  await rm(previous, { recursive: true, force: true });
  await mkdir(join(current, '..'), { recursive: true });
  if (await pathExists(current)) await rename(current, previous);
  await rename(staged, current);
}

function lockPath(paths: DataWatchPaths): string {
  return resolveOwnedPath(paths.dataRoot, 'work/run.lock');
}

async function verifyLegacyManifest(paths: DataWatchPaths, manifest: DatasetManifest): Promise<void> {
  for (const file of manifest.files) {
    if (!file.sha256) throw new Error('MIGRATION_MANIFEST_INCOMPLETE');
    const source = resolveOwnedPath(join(paths.originalRoot, manifest.dataset_id, manifest.revision), file.path);
    if (!(await pathExists(source)) || await sha256File(source) !== file.sha256) throw new Error('MIGRATION_HASH_MISMATCH');
  }
}
async function cleanLegacyGeneratedSnapshot(paths: DataWatchPaths, datasetId: DatasetId, revision: string): Promise<void> {
  const root = join(paths.vaultRoot, 'Evidence', 'datasets', datasetId, revision);
  let assets: Array<{ path?: string }> = [];
  try {
    const registry = JSON.parse(await readFile(join(paths.vaultRoot, '.datawatch-assets.json'), 'utf8')) as { generated_by?: string; files?: Array<{ path?: string }> };
    if (registry.generated_by === 'datawatch-data') assets = registry.files ?? [];
  } catch { /* no generated registry means no raw files are safe to remove */ }
  const prefix = 'Evidence/datasets/' + datasetId + '/' + revision + '/raw/';
  for (const asset of assets) if (asset.path?.startsWith(prefix)) await rm(resolveOwnedPath(paths.vaultRoot, asset.path), { force: true });
  const card = join(root, 'dataset.md');
  let generatedCard = false;
  try { generatedCard = (await readFile(card, 'utf8')).startsWith('---\ngenerated_by: datawatch-data\n'); } catch { /* absent */ }
  if (generatedCard) {
    await rm(card, { force: true });
    await rm(join(root, 'manifest.json'), { force: true });
  }
  for (const directory of [join(root, 'raw'), root]) {
    await rmdir(directory).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY'))) throw error;
    });
  }
}

/** Migrates one verified legacy snapshot to the current flat layout. */
export async function migrateLegacyStorage(paths: DataWatchPaths, wanted?: DatasetId[]): Promise<{ datasets: number; files: number }> {
  const ids = wanted ?? [];
  const sourceIds = ids.length ? ids : await readdir(join(paths.dataRoot, 'datasets')).catch(() => [] as string[]) as DatasetId[];
  let datasets = 0;
  let files = 0;
  let legacyBackedUp = false;
  for (const datasetId of sourceIds) {
    const legacyRoot = join(paths.dataRoot, 'datasets', datasetId);
    const revisions = await readdir(legacyRoot).catch(() => [] as string[]);
    const manifests: DatasetManifest[] = [];
    for (const revision of revisions) {
      try { manifests.push(await readJson<DatasetManifest>(join(legacyRoot, revision, 'manifest.json'))); } catch { /* ignored legacy debris */ }
    }
    const manifest = manifests.sort((left, right) => right.retrieved_at.localeCompare(left.retrieved_at))[0];
    if (!manifest) continue;
    await verifyLegacyManifest(paths, manifest);
    if (!legacyBackedUp) {
      await createBackupUnlocked(paths, 'backup-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8));
      legacyBackedUp = true;
    }
    for (const file of manifest.files) {
      const source = resolveOwnedPath(join(paths.originalRoot, datasetId, manifest.revision), file.path);
      const destination = resolveOwnedPath(originalRoot(paths, datasetId), file.path);
      await mkdir(join(destination, '..'), { recursive: true });
      if (!(await pathExists(destination))) await copyFile(source, destination);
      files += 1;
    }
    await saveManifest(paths, manifest);
    await buildCatalog(paths, [manifest]);
    await rm(join(paths.dataRoot, 'datasets', datasetId), { recursive: true, force: true });
    for (const revision of revisions) {
      await rm(join(paths.originalRoot, datasetId, revision), { recursive: true, force: true });
      await cleanLegacyGeneratedSnapshot(paths, datasetId, revision);
    }
    datasets += 1;
  }
  const legacyOverview = join(paths.vaultRoot, 'Evidence', 'indexes', 'overview.md');
  try {
    if ((await readFile(legacyOverview, 'utf8')).startsWith('---\ngenerated_by: datawatch-data\n')) {
      await rm(legacyOverview);
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const legacyDatasetRoot = join(paths.vaultRoot, 'Evidence', 'datasets');
  for (const datasetId of await readdir(legacyDatasetRoot).catch(() => [] as string[])) {
    await rmdir(join(legacyDatasetRoot, datasetId)).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY'))) throw error;
    });
  }
  for (const directory of [join(paths.vaultRoot, 'Evidence', 'indexes'), legacyDatasetRoot, join(paths.vaultRoot, 'Evidence')]) {
    await rmdir(directory).catch(error => {
      if (!(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY'))) throw error;
    });
  }
  return { datasets, files };
}

export async function runDataWatchTask(options: TaskOptions): Promise<TaskResult> {
  const datasetIds = [...new Set(options.datasetIds)] as DatasetId[];
  if (!datasetIds.length) fail('DATASET_REQUIRED');
  const sourceMap = new Map(options.sources.map(source => [source.dataset_id, source]));
  if (datasetIds.some(id => !sourceMap.has(id))) fail('SOURCE_NOT_CONFIGURED');
  const hash = configHash({
    workbench: options.workbench,
    datasets: datasetIds,
    sources: datasetIds.map(id => sourceMap.get(id)),
  });
  return withRunLock(lockPath(options.paths), async () => {
    await migrateLegacyStorage(options.paths, datasetIds);
    await mkdir(runRoot(options.paths), { recursive: true });
    const results: DatasetResult[] = [];
    let run = options.runId ? await readJson<TaskRun>(runPath(options.paths, options.runId)) : await latestIncomplete(options.paths, datasetIds, hash);
    if (!run) {
      const created = (options.now ?? (() => new Date()))().toISOString();
      run = {
        schema_version: 1,
        run_id: options.runId ?? timestampId(new Date(created)),
        dataset_ids: datasetIds,
        config_sha256: hash,
        status: 'running',
        stages: initialStages(),
        revisions: {},
        created_at: created,
        updated_at: created,
      };
      await saveRun(options.paths, run);
    } else {
      run.status = 'running';
      delete run.failed_stage;
      run.errors = [];
      await saveRun(options.paths, run);
    }
    const manifests = new Map<DatasetId, DatasetManifest>();
    run.stages.probe = 'running';
    await saveRun(options.paths, run);
    for (const datasetId of datasetIds) {
      const source = sourceMap.get(datasetId)!;
      try {
        const revision = run.revisions[datasetId] ?? await resolveHuggingFaceRevision(
          source,
          (options.httpFactory ?? (item => createSourceHttp(item, { network: options.network })))(source),
          options.workbench.max_response_bytes,
          options.workbench.request_timeout_ms,
        );
        let current: DatasetManifest | undefined;
        try { current = await loadManifest(options.paths, datasetId); } catch { current = undefined; }
        if (current && current.revision !== revision) {
          await createBackupUnlocked(options.paths, 'backup-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8));
        }
        run.revisions[datasetId] = revision;
        const manifest = await probeDataset(options, source, revision);
        manifests.set(datasetId, manifest);
        await saveRun(options.paths, run);
      } catch (error) {
        addError(run, datasetId, undefined, error);
        await saveRun(options.paths, run);
      }
    }
    run.stages.probe = run.errors?.length ? 'failed' : 'completed';
    await saveRun(options.paths, run);
    run.stages.acquire = 'running';
    await saveRun(options.paths, run);
    for (const datasetId of datasetIds) {
      const revision = run.revisions[datasetId];
      if (!revision) continue;
      const source = sourceMap.get(datasetId)!;
      try {
        const manifest = manifests.get(datasetId) ?? await readJson<DatasetManifest>(stageManifestPath(options.paths, datasetId, revision));
        manifests.set(datasetId, manifest);
        const result = await acquireDataset({ ...options, run }, source, manifest);
        results.push({ dataset_id: datasetId, revision, ...result });
      } catch (error) {
        addError(run, datasetId, undefined, error);
        await saveRun(options.paths, run);
      }
    }
    run.stages.acquire = run.errors?.length ? 'failed' : 'completed';
    await saveRun(options.paths, run);
    const complete = [...manifests.values()].filter(manifest => manifest.files.every(file => file.sha256));
    if (!run.errors?.length && complete.length === datasetIds.length) {
      try {
        if (options.workbench.publish_snapshot) await validateCatalogTargets(options.paths, complete);
        for (const manifest of complete) await activateDataset(options.paths, manifest);
      } catch (error) {
        addError(run, undefined, undefined, error);
      }
    }
    run.stages.catalog = 'running';
    await saveRun(options.paths, run);
    if (options.workbench.publish_snapshot && !run.errors?.length) {
      try {
        await buildCatalog(options.paths, complete);
        for (const manifest of complete) {
          await saveManifest(options.paths, manifest);
          await rm(stageRoot(options.paths, manifest.dataset_id, manifest.revision), { recursive: true, force: true });
        }
        run.stages.catalog = 'completed';
      } catch (error) {
        addError(run, undefined, undefined, error);
        run.stages.catalog = 'failed';
      }
    } else if (!run.errors?.length) {
      for (const manifest of complete) {
        await saveManifest(options.paths, manifest);
        await rm(stageRoot(options.paths, manifest.dataset_id, manifest.revision), { recursive: true, force: true });
      }
      run.stages.catalog = 'completed';
    } else {
      run.stages.catalog = 'failed';
    }
    await saveRun(options.paths, run);
    run.stages.verify = 'running';
    await saveRun(options.paths, run);
    if (!options.workbench.publish_snapshot) {
      run.stages.verify = 'completed';
    } else {
      try {
        await verifyCatalog(options.paths, [...manifests.values()].filter(manifest => manifest.files.every(file => file.sha256)));
        run.stages.verify = 'completed';
      } catch (error) {
        addError(run, undefined, undefined, error);
        run.stages.verify = 'failed';
      }
    }
    run.status = run.errors?.length ? 'failed' : 'completed';
    if (run.status === 'failed') run.failed_stage = stages.find(stage => run!.stages[stage] === 'failed') ?? 'verify';
    await saveRun(options.paths, run);
    return { status: run.status, run_id: run.run_id, datasets: results, errors: run.errors ?? [] };
  });
}

export async function listRuns(paths: DataWatchPaths): Promise<TaskRun[]> {
  const entries = await readdir(runRoot(paths)).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const runs: TaskRun[] = [];
  for (const name of entries.filter(item => item.endsWith('.json')).sort()) {
    try { runs.push(await readJson<TaskRun>(join(runRoot(paths), name))); } catch { /* status ignores malformed entries */ }
  }
  return runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export async function loadManifests(paths: DataWatchPaths, datasetIds?: DatasetId[]): Promise<DatasetManifest[]> {
  const wanted = datasetIds ? new Set(datasetIds) : undefined;
  const root = paths.dataRoot;
  const found: DatasetManifest[] = [];
  for (const datasetId of await readdir(root).catch(error => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [] as string[];
    throw error;
  })) {
    if (!datasetIds?.includes(datasetId as DatasetId)) {
      if (!(['regulatory-affairs', 'fda-recalls', 'procurement-pricing', 'hospital-resources'] as string[]).includes(datasetId)) continue;
    }
    const path = join(root, datasetId, 'manifest.json');
    if (await pathExists(path)) found.push(await readJson<DatasetManifest>(path));
  }
  return found.sort((left, right) => left.dataset_id.localeCompare(right.dataset_id));
}

export async function latestManifest(paths: DataWatchPaths, datasetId: DatasetId): Promise<DatasetManifest | undefined> {
  const manifests = await loadManifests(paths, [datasetId]);
  return manifests.sort((left, right) => right.retrieved_at.localeCompare(left.retrieved_at))[0];
}
