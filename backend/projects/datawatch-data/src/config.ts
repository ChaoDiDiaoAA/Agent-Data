import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import type { DataWatchPaths, DatasetId, SourceConfig, WorkbenchConfig } from './contracts.ts';
import { datasetIds } from './contracts.ts';
import { hashCanonical } from './engine-bridge.ts';
import { isAbsolutePath } from './util.ts';

const pathFields = ['projectRoot', 'paperEngineRoot', 'originalRoot', 'dataRoot', 'vaultRoot', 'backupRoot'] as const;
const sourceFields = [
  'schema_version', 'source_id', 'dataset_id', 'repository', 'homepage', 'revision',
  'tree_url_template', 'file_url_template', 'allowed_origins', 'redirect_origins',
  'declared_license', 'license_evidence', 'data_kind', 'origin_kind', 'retention',
  'local_use', 'redistribution', 'language', 'enabled',
] as const;

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_CONFIG');
  return value as Record<string, unknown>;
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).some(key => !fields.includes(key))) fail('UNKNOWN_FIELD');
  return result;
}
function string(value: unknown, code = 'INVALID_CONFIG'): string {
  if (typeof value !== 'string' || !value) return fail(code);
  return value;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) return fail('INVALID_CONFIG');
  return [...value] as string[];
}
function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return fail('INVALID_CONFIG');
  return value;
}
function useValue(value: unknown): 'allowed' | 'unknown' | 'denied' {
  if (value !== 'allowed' && value !== 'unknown' && value !== 'denied') return fail('INVALID_CONFIG');
  return value;
}
function dataset(value: unknown): DatasetId {
  if (typeof value !== 'string' || !datasetIds.includes(value as DatasetId)) return fail('INVALID_CONFIG');
  return value as DatasetId;
}
function absoluteRoots(value: Record<string, unknown>): DataWatchPaths {
  const output = {} as DataWatchPaths;
  for (const field of pathFields) {
    const candidate = string(value[field], 'PATH_NOT_ABSOLUTE');
    if (!isAbsolutePath(candidate)) fail('PATH_NOT_ABSOLUTE');
    output[field] = win32.normalize(candidate);
  }
  const owned = ['originalRoot', 'dataRoot', 'vaultRoot', 'backupRoot'] as const;
  for (let index = 0; index < owned.length; index += 1) {
    for (let next = index + 1; next < owned.length; next += 1) {
      const left = output[owned[index]].toLowerCase();
      const right = output[owned[next]].toLowerCase();
      if (left === right || left.startsWith(right + '\\') || right.startsWith(left + '\\')) fail('PATH_ROOTS_OVERLAP');
    }
  }
  return output;
}

export function validatePaths(value: unknown): DataWatchPaths {
  return absoluteRoots(closed(value, pathFields));
}

export function loadPaths(path: string): DataWatchPaths {
  try { return validatePaths(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (error instanceof SyntaxError) fail('INVALID_JSON'); throw error; }
}

export function validateSourceConfig(value: unknown): SourceConfig {
  const source = closed(value, sourceFields);
  const revision = closed(source.revision, ['kind', 'url']);
  const sourceId = safeId(source.source_id);
  const datasetId = dataset(source.dataset_id);
  if (source.schema_version !== 1 || revision.kind !== 'huggingface-api') fail('INVALID_CONFIG');
  const origins = stringArray(source.allowed_origins);
  const redirects = stringArray(source.redirect_origins);
  for (const origin of [...origins, ...redirects]) {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) fail('INVALID_CONFIG');
  }
  return {
    schema_version: 1,
    source_id: sourceId,
    dataset_id: datasetId,
    repository: string(source.repository),
    homepage: string(source.homepage),
    revision: { kind: 'huggingface-api', url: string(revision.url) },
    tree_url_template: string(source.tree_url_template),
    file_url_template: string(source.file_url_template),
    allowed_origins: origins,
    redirect_origins: redirects,
    declared_license: string(source.declared_license),
    license_evidence: string(source.license_evidence),
    data_kind: string(source.data_kind),
    origin_kind: source.origin_kind === 'public_document' || source.origin_kind === 'public_redacted' || source.origin_kind === 'synthetic' ? source.origin_kind : fail('INVALID_CONFIG'),
    retention: useValue(source.retention),
    local_use: useValue(source.local_use),
    redistribution: useValue(source.redistribution),
    language: string(source.language),
    enabled: source.enabled === undefined ? true : source.enabled === true ? true : source.enabled === false ? false : fail('INVALID_CONFIG'),
  };
}

export function loadSourceConfig(path: string): SourceConfig {
  try { return validateSourceConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (error instanceof SyntaxError) fail('INVALID_JSON'); throw error; }
}

export function loadSources(directory: string): SourceConfig[] {
  const sources = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
    .map(name => loadSourceConfig(join(directory, name)));
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.dataset_id)) fail('DUPLICATE_DATASET');
    seen.add(source.dataset_id);
  }
  return sources;
}

export function validateWorkbenchConfig(value: unknown): WorkbenchConfig {
  const config = closed(value, ['schema_version', 'enabled_dataset_ids', 'publish_snapshot', 'max_response_bytes', 'request_timeout_ms']);
  if (config.schema_version !== 1) fail('INVALID_CONFIG');
  const enabled = config.enabled_dataset_ids;
  if (!Array.isArray(enabled) || enabled.length === 0) fail('INVALID_CONFIG');
  const datasetList = enabled.map(dataset);
  if (new Set(datasetList).size !== datasetList.length) fail('INVALID_CONFIG');
  if (typeof config.publish_snapshot !== 'boolean'
    || !Number.isSafeInteger(config.max_response_bytes) || Number(config.max_response_bytes) <= 0
    || !Number.isSafeInteger(config.request_timeout_ms) || Number(config.request_timeout_ms) <= 0) fail('INVALID_CONFIG');
  return {
    schema_version: 1,
    enabled_dataset_ids: datasetList,
    publish_snapshot: config.publish_snapshot,
    max_response_bytes: Number(config.max_response_bytes),
    request_timeout_ms: Number(config.request_timeout_ms),
  };
}

export function loadWorkbenchConfig(path: string): WorkbenchConfig {
  try { return validateWorkbenchConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (error instanceof SyntaxError) fail('INVALID_JSON'); throw error; }
}

export function configHash(value: unknown): string {
  return hashCanonical(value);
}

export function defaultConfigPaths(projectRoot: string): { paths: string; workbench: string; sources: string } {
  return {
    paths: join(projectRoot, 'config', 'paths.local.json'),
    workbench: join(projectRoot, 'config', 'workbench.json'),
    sources: join(projectRoot, 'config', 'sources'),
  };
}

export function hasLocalConfig(path: string): boolean {
  return existsSync(path);
}
