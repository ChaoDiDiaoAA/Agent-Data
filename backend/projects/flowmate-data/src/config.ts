import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep, win32 } from 'node:path';
import type { DocumentKind, FlowmatePaths, OriginKind, SourceConfig, WorkbenchConfig } from './contracts.ts';

type ConfigObject = Record<string, unknown>;

const pathFields = ['projectRoot', 'paperEngineRoot', 'originalRoot', 'dataRoot', 'vaultRoot', 'backupRoot'] as const;
const sourceFields = [
  'schema_version', 'source_id', 'dataset_id', 'reader', 'homepage', 'record_count', 'annotated_record_count', 'revision', 'record_locator', 'files',
  'allowed_origins', 'redirect_origins', 'declared_license', 'license_evidence', 'retention', 'local_use',
  'redistribution', 'origin_kind', 'language', 'document_kind', 'applicable_period',
] as const;

function fail(code: string): never {
  throw new Error(code);
}

function object(value: unknown): ConfigObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_CONFIG');
  return value as ConfigObject;
}

function closedObject(value: unknown, allowedFields: readonly string[]): ConfigObject {
  const result = object(value);
  for (const field of Object.keys(result)) {
    if (!allowedFields.includes(field)) fail('UNKNOWN_FIELD');
  }
  return result;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return fail('INVALID_CONFIG');
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return fail('INVALID_CONFIG');
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return fail('INVALID_CONFIG');
  return value as T;
}

function safeConfigId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return fail('INVALID_CONFIG');
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return fail('INVALID_CONFIG');
  return Number(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail('INVALID_CONFIG');
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fail('INVALID_JSON');
  }
}

export function validatePaths(value: unknown): FlowmatePaths {
  const paths = closedObject(value, pathFields);
  const normalized = {} as FlowmatePaths;
  for (const field of pathFields) {
    const candidate = requiredString(paths[field]);
    if (!win32.isAbsolute(candidate)) fail('PATH_NOT_ABSOLUTE');
    normalized[field] = win32.normalize(candidate);
  }

  const ownedRoots = ['originalRoot', 'dataRoot', 'vaultRoot', 'backupRoot'] as const;
  for (let index = 0; index < ownedRoots.length; index += 1) {
    for (let next = index + 1; next < ownedRoots.length; next += 1) {
      const left = normalized[ownedRoots[index]].toLowerCase();
      const right = normalized[ownedRoots[next]].toLowerCase();
      if (left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`)) fail('PATH_ROOTS_OVERLAP');
    }
  }
  return normalized;
}

export function loadPaths(path: string): FlowmatePaths {
  return validatePaths(readJson(path));
}

function validateSource(value: unknown): SourceConfig {
  const source = closedObject(value, sourceFields);
  const revision = closedObject(source.revision, ['kind', 'url']);
  const recordCount = optionalPositiveInteger(source.record_count);
  const annotatedRecordCount = optionalPositiveInteger(source.annotated_record_count);
  if (annotatedRecordCount !== undefined && recordCount !== undefined && annotatedRecordCount > recordCount) fail('INVALID_CONFIG');
  if (source.reader === 'dataset-records' && (recordCount === undefined || annotatedRecordCount === undefined)) fail('INVALID_CONFIG');
  const recordLocator = source.record_locator === undefined ? undefined : closedObject(source.record_locator, ['index_path', 'file_url_template']);
  if (source.files !== undefined && !Array.isArray(source.files)) fail('INVALID_CONFIG');
  const files = source.files === undefined ? undefined : source.files.map(file => {
    const item = closedObject(file, ['id', 'url', 'document_kind', 'parse']);
    if (typeof item.parse !== 'boolean') fail('INVALID_CONFIG');
    return {
      id: requiredString(item.id),
      url: requiredString(item.url),
      document_kind: oneOf<DocumentKind>(item.document_kind, ['invoice', 'receipt', 'invoice_template', 'knowledge']),
      parse: item.parse,
    };
  });

  return {
    schema_version: source.schema_version === 1 ? 1 : fail('INVALID_CONFIG'),
    source_id: requiredString(source.source_id),
    ...(source.dataset_id === undefined ? {} : { dataset_id: requiredString(source.dataset_id) }),
    reader: oneOf(source.reader, ['dataset-records', 'public-files']),
    homepage: requiredString(source.homepage),
    ...(recordCount === undefined ? {} : { record_count: recordCount }),
    ...(annotatedRecordCount === undefined ? {} : { annotated_record_count: annotatedRecordCount }),
    revision: { kind: oneOf(revision.kind, ['huggingface-api', 'content-hash']), url: requiredString(revision.url) },
    ...(recordLocator === undefined ? {} : {
      record_locator: { index_path: requiredString(recordLocator.index_path), file_url_template: requiredString(recordLocator.file_url_template) },
    }),
    ...(files === undefined ? {} : { files }),
    allowed_origins: stringArray(source.allowed_origins),
    redirect_origins: stringArray(source.redirect_origins),
    declared_license: requiredString(source.declared_license),
    license_evidence: requiredString(source.license_evidence),
    ...(source.applicable_period === undefined ? {} : { applicable_period: requiredString(source.applicable_period) }),
    retention: oneOf(source.retention, ['allowed', 'unknown', 'denied']),
    local_use: oneOf(source.local_use, ['allowed', 'unknown', 'denied']),
    redistribution: oneOf(source.redistribution, ['allowed', 'unknown', 'denied']),
    origin_kind: oneOf<OriginKind>(source.origin_kind, ['synthetic', 'official_example', 'public_redacted', 'public_document', 'unknown']),
    language: requiredString(source.language),
    document_kind: oneOf<DocumentKind>(source.document_kind, ['invoice', 'receipt', 'invoice_template', 'knowledge']),
  };
}

export function loadSourceConfig(path: string): SourceConfig {
  return validateSource(readJson(path));
}

export function validateWorkbenchConfig(value: unknown): WorkbenchConfig {
  const config = closedObject(value, ['schema_version', 'sample', 'knowledge', 'release', 'backup']);
  const sample = closedObject(config.sample, ['source_id', 'dataset_id', 'selection_id', 'acquire_limit', 'parse_limit', 'publish_snapshot']);
  const knowledge = closedObject(config.knowledge, ['source_ids', 'parse_source_ids']);
  const release = closedObject(config.release, ['version', 'include_originals']);
  const backup = closedObject(config.backup, ['verify', 'restore_smoke']);
  const sourceIds = stringArray(knowledge.source_ids).map(safeConfigId);
  const parseSourceIds = stringArray(knowledge.parse_source_ids).map(safeConfigId);
  if (parseSourceIds.some(sourceId => !sourceIds.includes(sourceId))) fail('INVALID_CONFIG');
  return {
    schema_version: config.schema_version === 1 ? 1 : fail('INVALID_CONFIG'),
    sample: {
      source_id: safeConfigId(sample.source_id),
      dataset_id: safeConfigId(sample.dataset_id),
      selection_id: safeConfigId(sample.selection_id),
      acquire_limit: positiveInteger(sample.acquire_limit),
      parse_limit: positiveInteger(sample.parse_limit),
      publish_snapshot: booleanValue(sample.publish_snapshot),
    },
    knowledge: { source_ids: sourceIds, parse_source_ids: parseSourceIds },
    release: { version: safeConfigId(release.version), include_originals: booleanValue(release.include_originals) },
    backup: { verify: booleanValue(backup.verify), restore_smoke: booleanValue(backup.restore_smoke) },
  };
}

export function loadWorkbenchConfig(path: string): WorkbenchConfig {
  return validateWorkbenchConfig(readJson(path));
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

export function resolveOwnedPath(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string') fail('PATH_INVALID');
  if (/\p{Cc}/u.test(relativePath)) fail('PATH_CONTROL_CHARACTER');
  if (win32.isAbsolute(relativePath) || resolve(relativePath) === relativePath) fail('PATH_ABSOLUTE');
  if (relativePath.split(/[\\/]/).includes('..')) fail('PATH_TRAVERSAL');

  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  if (!isWithin(resolvedRoot, candidate)) fail('PATH_TRAVERSAL');

  const realRoot = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
  let current = resolvedRoot;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink() && !isWithin(realRoot, realpathSync(current))) fail('PATH_SYMLINK_ESCAPE');
  }
  return candidate;
}
