import { existsSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';

import { loadEngineContext } from './engine-context.ts';
import { configurationFiles } from './config-files.ts';
import { EVIDENCE_POLICY_V3 } from './evidence-policy.ts';
import { LEGACY_EVIDENCE_POLICY } from './historical-compatibility.ts';
import { readLegacyEvidencePolicy, readLegacyPaperPolicy, readLegacyPipeline, readLegacyProjectPaths, readLegacyRuntime } from './legacy-config.ts';
import { isPaperLibrary } from '../types/config.ts';
import type { ArxivConfig, EvidencePolicy, PipelineConfig, ProjectPaths, RuntimePolicy, WeeklySchedule, Weekday, PaperPolicy } from '../types/config.ts';
import type { LibraryPaths } from './paths.ts';

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(field + ' must be a string');
  return value;
}
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) throw new Error(field + ' must be a string array');
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(field + ' must be a boolean');
  return value;
}
function isWeekday(value: unknown): value is Weekday { return typeof value === 'string' && dayNames.has(value); }
const dayNames = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const runtimePolicyKeys = new Set([
  'process_cleanup_timeout_ms',
  'diagnostic_timeout_ms',
  'max_output_bytes',
]);

function hasLayeredConfig(root: string, libraryId = 'fsd'): boolean {
  const paths = configurationFiles(libraryId).map(name => join(root, 'config', name));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length === paths.length) return false;
  if (missing.length > 0) throw new Error(`INCOMPLETE_LAYERED_CONFIG: missing ${missing.join(', ')}`);
  return true;
}

function compatibilityPaths(paths: LibraryPaths): ProjectPaths {
  return {
    pdfRoot: paths.pdfRoot ?? win32.join(paths.workRoot, 'downloads'),
    vaultRoot: paths.vaultRoot,
    stateRoot: paths.dataRoot,
    tempRoot: paths.workRoot,
    backupRoot: paths.backupRoot,
  };
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function loadArxivConfig(raw: unknown): ArxivConfig {
  const value = record(raw ?? {}, 'pipeline').arxiv;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing arxiv config');
  const policy = record(value, 'arxiv');
  const result = {
    pageSize: Number(policy.page_size),
    requestIntervalMs: Number(policy.request_interval_seconds) * 1000,
    maxAttempts: Number(policy.max_attempts),
    maxBackoffMs: Number(policy.max_backoff_seconds) * 1000,
    requestTimeoutMs: Number(policy.request_timeout_seconds) * 1000,
    retryJitterMs: Number(policy.retry_jitter_ms),
    capacityCooldownMs: Number(policy.capacity_cooldown_seconds) * 1000,
    candidatePoolMultiplier: Number(policy.candidate_pool_multiplier),
    maxResultsPerShard: Number(policy.max_results_per_shard),
  };
  if (!Number.isInteger(result.pageSize) || result.pageSize < 1 || result.pageSize > 100) throw new Error('arxiv page size must be 1-100');
  if (!Number.isInteger(result.requestIntervalMs) || result.requestIntervalMs < 3000) throw new Error('arxiv request interval must be at least 3 seconds');
  if (!Number.isInteger(result.maxAttempts) || result.maxAttempts < 1 || result.maxAttempts > 10) throw new Error('arxiv max attempts must be 1-10');
  if (!Number.isInteger(result.maxBackoffMs) || result.maxBackoffMs < result.requestIntervalMs) throw new Error('invalid arxiv max backoff');
  if (!Number.isInteger(result.requestTimeoutMs) || result.requestTimeoutMs < 10000) throw new Error('arxiv timeout must be at least 10 seconds');
  if (!Number.isInteger(result.retryJitterMs) || result.retryJitterMs < 0 || result.retryJitterMs > 5000) throw new Error('arxiv retry jitter must be 0-5000ms');
  if (!Number.isInteger(result.capacityCooldownMs) || result.capacityCooldownMs < 0) throw new Error('arxiv capacity cooldown must be non-negative');
  if (!Number.isInteger(result.candidatePoolMultiplier) || result.candidatePoolMultiplier < 1) throw new Error('candidate pool multiplier must be positive');
  if (!Number.isInteger(result.maxResultsPerShard) || result.maxResultsPerShard < result.pageSize) throw new Error('max results per shard must cover one page');
  return result;
}

function normalizeCurrentTask(input: unknown = {}) {
  const raw = record(input, 'current_task');
  const maxPapers = positiveInteger(raw.max_papers, 'current task max papers');
  const trackLimits = Object.fromEntries(Object.entries(record(raw.track_limits ?? {}, 'current_task.track_limits')).map(([track, value]) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`invalid track limit: ${track}`);
    return [track, value];
  }));
  const total = Object.values(trackLimits).reduce((sum, value) => sum + value, 0);
  if (total !== maxPapers) throw new Error(`track limits must total ${maxPapers}`);
  return { maxPapers, trackLimits };
}

function normalizeWeeklySchedule(input: unknown = {}): WeeklySchedule {
  const raw = record(input, 'weekly_schedule');
  const maxPapers = positiveInteger(raw.max_papers, 'weekly max papers');
  if (typeof raw.task_name !== 'string' || !raw.task_name.trim() || /[\\/:*?"<>|]/.test(raw.task_name)) throw new Error('invalid weekly task name');
  if (!isWeekday(raw.day_of_week)) throw new Error('invalid weekly day of week');
  if (typeof raw.local_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.local_time)) throw new Error('weekly local time must be HH:mm');
  if (!validTimeZone(raw.timezone)) throw new Error('invalid weekly timezone');
  if (typeof raw.interval_weeks !== 'number' || !Number.isInteger(raw.interval_weeks) || raw.interval_weeks < 1 || raw.interval_weeks > 52) {
    throw new Error('weekly interval weeks must be an integer from 1 to 52');
  }
  const startDate = new Date(`${raw.start_date}T00:00:00.000Z`);
  if (typeof raw.start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.start_date)
    || !Number.isFinite(startDate.getTime()) || startDate.getUTCFullYear() < 1
    || startDate.toISOString().slice(0, 10) !== raw.start_date) {
    throw new Error('weekly start date must be a real date in YYYY-MM-DD format');
  }
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][startDate.getUTCDay()];
  if (weekday !== raw.day_of_week) throw new Error('weekly start date must match day of week');
  return {
    enabled: raw.enabled === true,
    taskName: raw.task_name,
    dayOfWeek: raw.day_of_week,
    intervalWeeks: raw.interval_weeks,
    startDate: text(raw.start_date, 'start_date'),
    localTime: raw.local_time,
    timezone: raw.timezone,
    maxPapers,
  };
}

export function loadProjectPaths({ root = process.cwd(), libraryId = 'fsd' }: { root?: string; libraryId?: string } = {}): ProjectPaths {
  if (hasLayeredConfig(root, libraryId)) {
    return compatibilityPaths(loadEngineContext({ root, libraryId }).paths);
  }
  if (libraryId !== 'fsd') throw new Error(`UNKNOWN_LIBRARY: ${libraryId}`);

  // Migration-only fallback for fixtures that still use the legacy configuration files.
  const paths = readLegacyProjectPaths(root);
  for (const key of ['pdf_root', 'vault_root', 'state_root', 'temp_root', 'backup_root']) {
    if (typeof paths[key] !== 'string' || !paths[key].trim()) throw new Error(`missing path: ${key}`);
  }
  return {
    pdfRoot: text(paths.pdf_root, 'pdf_root'),
    vaultRoot: text(paths.vault_root, 'vault_root'),
    stateRoot: resolve(root, text(paths.state_root, 'state_root')),
    tempRoot: resolve(root, text(paths.temp_root, 'temp_root')),
    backupRoot: resolve(root, text(paths.backup_root, 'backup_root')),
  };
}

export function validateRuntimePolicy(value: unknown): RuntimePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime policy must be an object');
  }

  const input = record(value, 'runtime policy');
  for (const key of Object.keys(input)) {
    if (!runtimePolicyKeys.has(key)) throw new Error(`unknown runtime policy field: ${key}`);
  }
  for (const key of runtimePolicyKeys) {
    if (!Object.hasOwn(input, key)) throw new Error(`missing required runtime policy field: ${key}`);
    if (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 1) {
      throw new Error(`runtime policy ${key} must be a positive safe integer`);
    }
  }

  return {
    processCleanupTimeoutMs: positiveInteger(input.process_cleanup_timeout_ms, 'runtime policy process_cleanup_timeout_ms'),
    diagnosticTimeoutMs: positiveInteger(input.diagnostic_timeout_ms, 'runtime policy diagnostic_timeout_ms'),
    maxOutputBytes: positiveInteger(input.max_output_bytes, 'runtime policy max_output_bytes'),
  };
}

export function loadRuntimeConfig(root = process.cwd(), libraryId = 'fsd') {
  if (hasLayeredConfig(root, libraryId)) {
    return loadEngineContext({ root, libraryId }).engine.runtime;
  }
  if (libraryId !== 'fsd') throw new Error(`UNKNOWN_LIBRARY: ${libraryId}`);

  // Migration-only fallback for fixtures that still use the legacy configuration files.
  return validateRuntimePolicy(readLegacyRuntime(root));
}

const evidencePolicyKeys = new Set(['schema_version', 'root', 'paper_root', 'index_roots', 'publisher_version']);

/** Loads the intentionally closed, deterministic Evidence publication layout. */
export function loadEvidencePolicy(root = process.cwd(), libraryId = 'fsd'): EvidencePolicy {
  if (hasLayeredConfig(root, libraryId)) {
    return loadEngineContext({ root, libraryId }).engine.evidence;
  }
  if (libraryId !== 'fsd') throw new Error(`UNKNOWN_LIBRARY: ${libraryId}`);

  // Migration-only fallback for fixtures that still use the legacy configuration files.
  const raw = readLegacyEvidencePolicy(root);
  for (const key of Object.keys(raw)) {
    if (!evidencePolicyKeys.has(key)) throw new Error(`unknown evidence policy field: ${key}`);
  }
  const policy = raw.schema_version === 1 ? LEGACY_EVIDENCE_POLICY : EVIDENCE_POLICY_V3;
  if (raw.schema_version !== policy.schemaVersion) throw new Error('evidence policy schema_version must be 1 or 3');
  if (raw.root !== policy.root) throw new Error(`evidence policy root must be ${policy.root}`);
  if (raw.paper_root !== policy.paperRoot) throw new Error(`evidence policy paper_root must be ${policy.paperRoot}`);
  if (!raw.index_roots || typeof raw.index_roots !== 'object' || Array.isArray(raw.index_roots)) {
    throw new Error('evidence policy index_roots must be an object');
  }
  const indexes = raw.index_roots as Record<string, unknown>;
  if (Object.keys(indexes).length !== Object.keys(policy.indexRoots).length
    || Object.entries(policy.indexRoots).some(([key, path]) => indexes[key] !== path)) {
    throw new Error('evidence policy index_roots must use the controlled Evidence paths');
  }
  if (raw.publisher_version !== policy.publisherVersion) throw new Error(`evidence policy publisher_version must be ${policy.publisherVersion}`);
  return structuredClone(policy);
}

export function loadConfig({ root = process.cwd(), libraryId = 'fsd' }: { root?: string; env?: NodeJS.ProcessEnv; libraryId?: string } = {}): PipelineConfig {
  if (existsSync(join(root, 'config', libraryId, 'library.yaml'))) {
    const context = loadEngineContext({ root, libraryId });
    if (!isPaperLibrary(context.library)) throw new Error(`UNSUPPORTED_LIBRARY_KIND: ${context.library.kind}`);
    return {
      startDate: context.library.startDate,
      overlapHours: context.library.overlapHours,
      arxiv: context.engine.arxiv,
      ...(context.machine.network === undefined ? {} : { network: context.machine.network }),
      downloadAfterHardFilter: context.library.downloadAfterHardFilter,
      currentTask: context.library.currentTask,
      weeklySchedule: context.library.weeklySchedule,
      evidencePolicy: context.engine.evidence,
      ...compatibilityPaths(context.paths),
    };
  }
  if (hasLayeredConfig(root, libraryId)) {
    const context = loadEngineContext({ root, libraryId });
    if (!isPaperLibrary(context.library)) throw new Error(`UNSUPPORTED_LIBRARY_KIND: ${context.library.kind}`);
    return {
      startDate: context.library.startDate,
      overlapHours: context.library.overlapHours,
      arxiv: context.engine.arxiv,
      ...(context.machine.network === undefined ? {} : { network: context.machine.network }),
      downloadAfterHardFilter: context.library.downloadAfterHardFilter,
      currentTask: context.library.currentTask,
      weeklySchedule: context.library.weeklySchedule,
      evidencePolicy: context.engine.evidence,
      ...compatibilityPaths(context.paths),
    };
  }
  if (libraryId !== 'fsd') throw new Error(`UNKNOWN_LIBRARY: ${libraryId}`);

  // Migration-only fallback for fixtures that still use the legacy configuration files.
  const pipeline = readLegacyPipeline(root);
  if (pipeline.download_after_hard_filter !== true) throw new Error('hard-filter passing papers must download automatically');
  const arxiv = loadArxivConfig(pipeline);
  const currentTask = normalizeCurrentTask(pipeline.current_task);
  const weeklySchedule = normalizeWeeklySchedule(pipeline.weekly_schedule);
  return {
    startDate: text(pipeline.start_date, 'pipeline.start_date'),
    overlapHours: finiteNumber(pipeline.overlap_hours, 'pipeline.overlap_hours'),
    arxiv,
    downloadAfterHardFilter: pipeline.download_after_hard_filter,
    currentTask,
    weeklySchedule,
    evidencePolicy: loadEvidencePolicy(root),
    ...loadProjectPaths({ root }),
  };
}

export function loadPaperPolicy(path: string): PaperPolicy {
  const raw = readLegacyPaperPolicy(path);
  const vocabulary = new Set([
    ...(stringArray(raw.ai_technique_terms ?? [], 'ai_technique_terms')), ...(stringArray(raw.program_structure_terms ?? [], 'program_structure_terms')), ...(stringArray(raw.engineering_task_terms ?? [], 'engineering_task_terms')),
  ].map(term => String(term).trim().toLowerCase()));
  const variants = raw.term_variants ?? {};
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) throw new Error('term_variants must be an object');
  const termVariants: Record<string, string[]> = {};
  for (const [term, forms] of Object.entries(variants)) {
    const key = term.trim().toLowerCase();
    if (!vocabulary.has(key) || Object.hasOwn(termVariants, key)) throw new Error(`term_variants key must uniquely name an inclusion term: ${term}`);
    if (!Array.isArray(forms) || forms.length === 0 || forms.some(form => typeof form !== 'string' || !form.trim())) {
      throw new Error(`term_variants.${term} must be a non-empty string array`);
    }
    termVariants[key] = [...new Set(forms.map(form => form.trim().toLowerCase()))];
  }
  return {
    startDate: raw.start_date === undefined ? undefined : text(raw.start_date, 'start_date'),
    excludedDomains: stringArray(raw.excluded_domains ?? [], 'excluded_domains'),
    aiTechniqueTerms: stringArray(raw.ai_technique_terms ?? [], 'ai_technique_terms'),
    programStructureTerms: stringArray(raw.program_structure_terms ?? [], 'program_structure_terms'),
    engineeringTaskTerms: stringArray(raw.engineering_task_terms ?? [], 'engineering_task_terms'),
    termVariants,
    trackPriority: stringArray(raw.track_priority ?? [], 'track_priority'),
  };
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(field + ' must be a finite number');
  return value;
}
