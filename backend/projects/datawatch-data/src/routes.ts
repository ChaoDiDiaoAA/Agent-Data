import type { DataWatchPaths, DatasetId, SourceConfig, WorkbenchConfig } from './contracts.ts';
import { datasetIds } from './contracts.ts';
import { defaultConfigPaths, loadPaths, loadSources, loadWorkbenchConfig } from './config.ts';
import { createSourceHttp } from './http.ts';
import { fetchRepositoryTree, resolveHuggingFaceRevision } from './huggingface.ts';
import { buildCatalog, verifyCatalog } from './catalog.ts';
import { createBackup, restoreSmoke, verifyBackup } from './backup.ts';
import { latestManifest, listRuns, loadManifests, runDataWatchTask } from './task.ts';
import { loadSharedEngineNetwork, type HttpScope } from './engine-bridge.ts';

export interface DataWatchContext {
  root: string;
  paths: DataWatchPaths;
  sources: SourceConfig[];
  workbench: WorkbenchConfig;
  network?: HttpScope['network'];
  output?: (value: unknown) => void;
  httpFactory?: (source: SourceConfig) => ReturnType<typeof createSourceHttp>;
}

function fail(code: string): never { throw new Error(code); }
function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function has(args: string[], name: string): boolean { return args.includes(name); }
function format(args: string[]): 'json' | 'text' {
  const value = argValue(args, '--format');
  if (value && value !== 'json') fail('FORMAT_JSON_ONLY');
  return value === 'json' ? 'json' : 'text';
}
function dataset(value: string | undefined): DatasetId {
  if (!value || !datasetIds.includes(value as DatasetId)) fail('DATASET_INVALID');
  return value as DatasetId;
}
function sourceFor(context: DataWatchContext, id: DatasetId): SourceConfig {
  return context.sources.find(source => source.dataset_id === id) ?? fail('SOURCE_NOT_CONFIGURED');
}
function summarizeTask(value: Awaited<ReturnType<typeof runDataWatchTask>>): string {
  if (value.status === 'completed') {
    const files = value.datasets.reduce((sum, item) => sum + item.files, 0);
    return '[任务] 成功：已处理 ' + value.datasets.length + ' 个数据集、' + files + ' 个文件';
  }
  return '[任务] 失败：runId=' + value.run_id + '；错误 ' + value.errors.length + ' 个';
}
export function helpText(): string {
  return [
    'DataWatch 数据工作台',
    '命令：',
    '  sources list [--format json]',
    '  source show --dataset DATASET_ID [--format json]',
    '  source probe --dataset DATASET_ID [--format json]',
    '  run-task --dataset DATASET_ID | --all [--format json]',
    '  status [--dataset DATASET_ID] [--format json]',
    '  verify [--dataset DATASET_ID] [--format json]',
    '  config show [--format json]',
    '  catalog build [--format json]',
    '  backup create [--format json]',
    '  backup verify --path ARCHIVE_OR_MANIFEST [--format json]',
    '  menu',
  ].join('\n');
}

export async function routeCommand(args: string[], context: DataWatchContext): Promise<unknown> {
  const command = args[0] ?? 'menu';
  if (command === '--help' || command === 'help') return helpText();
  if (command === 'sources' && args[1] === 'list') {
    format(args);
    return context.sources.map(source => ({
      dataset_id: source.dataset_id,
      source_id: source.source_id,
      repository: source.repository,
      enabled: source.enabled,
      data_kind: source.data_kind,
      declared_license: source.declared_license,
    }));
  }
  if (command === 'source' && args[1] === 'show') {
    format(args);
    return sourceFor(context, dataset(argValue(args, '--dataset')));
  }
  if (command === 'source' && args[1] === 'probe') {
    format(args);
    const source = sourceFor(context, dataset(argValue(args, '--dataset')));
    const http = (context.httpFactory ?? (item => createSourceHttp(item, { network: context.network })))(source);
    const revision = await resolveHuggingFaceRevision(source, http, context.workbench.max_response_bytes, context.workbench.request_timeout_ms);
    const tree = await fetchRepositoryTree(source, revision, http, context.workbench.max_response_bytes, context.workbench.request_timeout_ms);
    return { dataset_id: source.dataset_id, repository: source.repository, revision, files: tree };
  }
  if (command === 'run-task') {
    const ids = has(args, '--all') ? context.workbench.enabled_dataset_ids : [dataset(argValue(args, '--dataset'))];
    const result = await runDataWatchTask({ paths: context.paths, sources: context.sources, datasetIds: ids, workbench: context.workbench, httpFactory: context.httpFactory, network: context.network });
    if (format(args) === 'text') return summarizeTask(result);
    return result;
  }
  if (command === 'status') {
    format(args);
    const selected = argValue(args, '--dataset');
    const runs = await listRuns(context.paths);
    const manifests = selected ? [await latestManifest(context.paths, dataset(selected))].filter((item): item is NonNullable<typeof item> => Boolean(item)) : await loadManifests(context.paths);
    return { runs, manifests };
  }
  if (command === 'verify') {
    format(args);
    const selected = argValue(args, '--dataset');
    const manifests = selected ? [await latestManifest(context.paths, dataset(selected))].filter((item): item is NonNullable<typeof item> => Boolean(item)) : await loadManifests(context.paths);
    return verifyCatalog(context.paths, manifests);
  }
  if (command === 'config' && args[1] === 'show') {
    format(args);
    return context.workbench;
  }
  if (command === 'catalog' && args[1] === 'build') {
    format(args);
    const result = await buildCatalog(context.paths, await loadManifests(context.paths));
    return result;
  }
  if (command === 'backup' && args[1] === 'create') {
    format(args);
    const result = await createBackup(context.paths);
    return { path: result.path, manifestPath: result.manifestPath, files: result.manifest.files.length, bytes: result.manifest.archive.bytes };
  }
  if (command === 'backup' && args[1] === 'verify') {
    format(args);
    const path = argValue(args, '--path') ?? fail('BACKUP_PATH_REQUIRED');
    return verifyBackup(path);
  }
  if (command === 'backup' && args[1] === 'restore-smoke') {
    format(args);
    const path = argValue(args, '--path') ?? fail('BACKUP_PATH_REQUIRED');
    return restoreSmoke(path);
  }
  fail('UNKNOWN_COMMAND');
}

export function loadContext(root: string, options: { paths?: string; workbench?: string; sources?: string } = {}): DataWatchContext {
  const defaults = defaultConfigPaths(root);
  const pathsPath = options.paths ?? defaults.paths;
  const workbenchPath = options.workbench ?? defaults.workbench;
  const sourcesPath = options.sources ?? defaults.sources;
  const paths = loadPaths(pathsPath);
  let network: HttpScope['network'] | undefined;
  try { network = loadSharedEngineNetwork(paths.paperEngineRoot); } catch { network = undefined; }
  return {
    root,
    paths,
    workbench: loadWorkbenchConfig(workbenchPath),
    sources: loadSources(sourcesPath),
    network,
  };
}
