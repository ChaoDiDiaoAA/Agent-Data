import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep, win32 } from 'node:path';
import type { AcquireCounts, DocumentKind, FlowmatePaths, OriginKind, SourceConfig, WorkbenchConfig } from './contracts.ts';

type ConfigObject = Record<string, unknown>;

const pathFields = ['projectRoot', 'paperEngineRoot', 'originalRoot', 'dataRoot', 'vaultRoot', 'backupRoot'] as const;
const sourceFields = [
  'schema_version', 'source_id', 'dataset_id', 'reader', 'homepage', 'record_count', 'annotated_record_count', 'revision', 'record_locator', 'files',
  'allowed_origins', 'redirect_origins', 'declared_license', 'license_evidence', 'retention', 'local_use',
  'redistribution', 'origin_kind', 'language', 'document_kind', 'applicable_period',
] as const;

/**
 * The current workbench has one supported invoice source.  These defaults are
 * kept in code so the local workbench file only contains values that operators
 * actually change between runs (primarily the acquisition split).
 */
export const DEFAULT_WORKBENCH_SOURCE_ID = 'voxel51-invoice-ocr';
export const DEFAULT_WORKBENCH_DATASET_ID = 'voxel51-hq-invoice-ocr';
export const DEFAULT_WORKBENCH_SELECTION_ID = 'current';
export const DEFAULT_WORKBENCH_RELEASE_VERSION = 'public-invoice-p0-v1';

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

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail('INVALID_CONFIG');
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
  const sample = closedObject(config.sample, ['source_id', 'dataset_id', 'selection_id', 'acquire', 'acquire_limit', 'publish_snapshot']);
  const knowledge = config.knowledge === undefined ? {} : closedObject(config.knowledge, ['source_ids', 'parse_source_ids']);
  const release = closedObject(config.release, ['version', 'include_originals']);
  const backup = closedObject(config.backup, ['verify', 'restore_smoke']);
  const sourceIds = knowledge.source_ids === undefined ? [] : stringArray(knowledge.source_ids).map(safeConfigId);
  const parseSourceIds = knowledge.parse_source_ids === undefined ? [] : stringArray(knowledge.parse_source_ids).map(safeConfigId);
  if (parseSourceIds.some(sourceId => !sourceIds.includes(sourceId))) fail('INVALID_CONFIG');
  if (sample.acquire !== undefined && sample.acquire_limit !== undefined) fail('INVALID_CONFIG');
  let acquire: AcquireCounts | undefined;
  if (sample.acquire !== undefined) {
    const configured = closedObject(sample.acquire, ['with_publisher_annotation', 'without_publisher_annotation']);
    acquire = {
      with_publisher_annotation: nonNegativeInteger(configured.with_publisher_annotation),
      without_publisher_annotation: nonNegativeInteger(configured.without_publisher_annotation),
    };
    if (acquire.with_publisher_annotation + acquire.without_publisher_annotation <= 0) fail('INVALID_CONFIG');
  } else if (sample.acquire_limit !== undefined) {
    // Read old local files without silently changing their meaning.  New
    // files should use `sample.acquire` so the two source groups are explicit.
    acquire = undefined;
  } else {
    fail('INVALID_CONFIG');
  }
  return {
    schema_version: config.schema_version === 1 ? 1 : fail('INVALID_CONFIG'),
    sample: {
      // These fields remain accepted for old local files and scripts, but are
      // optional.  New configs use the fixed defaults above instead.
      source_id: sample.source_id === undefined ? DEFAULT_WORKBENCH_SOURCE_ID : safeConfigId(sample.source_id),
      dataset_id: sample.dataset_id === undefined ? DEFAULT_WORKBENCH_DATASET_ID : safeConfigId(sample.dataset_id),
      selection_id: sample.selection_id === undefined ? DEFAULT_WORKBENCH_SELECTION_ID : safeConfigId(sample.selection_id),
      ...(acquire ? { acquire } : { acquire_limit: positiveInteger(sample.acquire_limit) }),
      publish_snapshot: booleanValue(sample.publish_snapshot),
    },
    knowledge: { source_ids: sourceIds, parse_source_ids: parseSourceIds },
    release: { version: release.version === undefined ? DEFAULT_WORKBENCH_RELEASE_VERSION : safeConfigId(release.version), include_originals: booleanValue(release.include_originals) },
    backup: { verify: booleanValue(backup.verify), restore_smoke: booleanValue(backup.restore_smoke) },
  };
}

export function loadWorkbenchConfig(path: string): WorkbenchConfig {
  return validateWorkbenchConfig(readJson(path));
}

/** Return the configured acquisition split, including compatibility for old local files. */
export function sampleAcquireCounts(sample: WorkbenchConfig['sample']): AcquireCounts {
  if (sample.acquire) return { ...sample.acquire };
  if (sample.acquire_limit !== undefined) return { with_publisher_annotation: sample.acquire_limit, without_publisher_annotation: 0 };
  return fail('INVALID_CONFIG');
}

export function sampleAcquireTotal(sample: WorkbenchConfig['sample']): number {
  const counts = sampleAcquireCounts(sample);
  return counts.with_publisher_annotation + counts.without_publisher_annotation;
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
