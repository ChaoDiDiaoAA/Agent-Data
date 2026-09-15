import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalJson, withRunLock } from './engine-bridge.ts';
import { resolveOwnedPath } from './config.ts';
import { datasetTasks } from './layout.ts';
import { writeCanonicalJson } from './file-store.ts';

export const taskStageKeys = [
  'probe', 'acquire', 'labels', 'parse', 'catalog', 'release', 'release_verify', 'verify',
] as const;
const legacyTaskStageKeys = [...taskStageKeys, 'backup'] as const;
export type TaskStage = typeof taskStageKeys[number];
export type TaskStageStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskRunIdentity {
  source_id: string;
  dataset_id: string;
  selection_id: string;
  config_sha256: string;
  counts: { with_publisher_annotation: number; without_publisher_annotation: number };
}

export interface TaskRun {
  schema_version: 1;
  run_id: string;
  identity: TaskRunIdentity;
  status: 'running' | 'failed' | 'completed';
  stages: Record<TaskStage, TaskStageStatus>;
  created_at: string;
  updated_at: string;
  failed_stage?: TaskStage;
  /** Runtime-only path; it is intentionally omitted from the persisted manifest. */
  manifest_path: string;
  /** Runtime-only lock path; it is intentionally omitted from the persisted manifest. */
  state_lock_path: string;
}

function runRoot(dataRoot: string): string {
  return resolveOwnedPath(dataRoot, `${datasetTasks('voxel51-hq-invoice-ocr')}/runs`);
}

function manifestValue(run: TaskRun): Omit<TaskRun, 'manifest_path' | 'state_lock_path'> {
  const { manifest_path: _manifestPath, state_lock_path: _stateLockPath, ...value } = run;
  return value;
}

function initialStages(): Record<TaskStage, TaskStageStatus> {
  return Object.fromEntries(taskStageKeys.map(stage => [stage, 'pending'])) as Record<TaskStage, TaskStageStatus>;
}

function sameIdentity(left: TaskRunIdentity, right: TaskRunIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function validIdentity(value: unknown): value is TaskRunIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'config_sha256,counts,dataset_id,selection_id,source_id') return false;
  if (![candidate.source_id, candidate.dataset_id, candidate.selection_id].every(item => typeof item === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item))) return false;
  if (typeof candidate.config_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.config_sha256)) return false;
  const counts = candidate.counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return false;
  const countObject = counts as Record<string, unknown>;
  if (Object.keys(countObject).sort().join(',') !== 'with_publisher_annotation,without_publisher_annotation') return false;
  const values = [countObject.with_publisher_annotation, countObject.without_publisher_annotation];
  return values.every(item => Number.isSafeInteger(item) && Number(item) >= 0)
    && Number(countObject.with_publisher_annotation) + Number(countObject.without_publisher_annotation) > 0;
}

function validStage(value: unknown): value is TaskStage {
  return typeof value === 'string' && (taskStageKeys as readonly string[]).includes(value);
}

function invalidTaskRun(): never {
  throw new Error('TASK_RUN_MANIFEST_INVALID');
}

function parseRun(value: unknown, manifestPath: string): TaskRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidTaskRun();
  const candidate = value as Partial<TaskRun>;
  const allowedFields = ['schema_version', 'run_id', 'identity', 'status', 'stages', 'created_at', 'updated_at', 'failed_stage'];
  if (Object.keys(value).some(field => !allowedFields.includes(field))
    || candidate.schema_version !== 1 || typeof candidate.run_id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.run_id)
    || basename(dirname(manifestPath)) !== candidate.run_id || !validIdentity(candidate.identity)
    || !candidate.stages || typeof candidate.stages !== 'object' || Array.isArray(candidate.stages)
    || !['running', 'failed', 'completed'].includes(candidate.status ?? '') || !validIso(candidate.created_at) || !validIso(candidate.updated_at)
    || Date.parse(candidate.updated_at) < Date.parse(candidate.created_at)) return invalidTaskRun();
  const stages = {} as Record<TaskStage, TaskStageStatus>;
  const stageObject = candidate.stages as Record<string, unknown>;
  const stageNames = Object.keys(stageObject).sort().join(',');
  const currentStageNames = [...taskStageKeys].sort().join(',');
  const legacyStageNames = [...legacyTaskStageKeys].sort().join(',');
  const legacyBackupManifest = stageNames === legacyStageNames;
  if (stageNames !== currentStageNames && !legacyBackupManifest) return invalidTaskRun();
  for (const stage of taskStageKeys) {
    const status = stageObject[stage];
    if (!['pending', 'running', 'completed', 'failed'].includes(status as string)) return invalidTaskRun();
    stages[stage] = status as TaskStageStatus;
  }
  const allCurrentStagesCompleted = taskStageKeys.every(stage => stages[stage] === 'completed');
  const legacyBackupIncomplete = legacyBackupManifest && stageObject.backup !== 'completed';
  const legacyBackupFailure = legacyBackupIncomplete && (candidate as Record<string, unknown>).failed_stage === 'backup';
  let status = candidate.status as TaskRun['status'];
  let failedStage = candidate.failed_stage;
  if (legacyBackupFailure) {
    // Backup is no longer part of the workflow. Ignore a legacy backup
    // failure and let createOrResumeTaskRun finalize the eight-stage run.
    status = 'running';
    failedStage = undefined;
  } else if (legacyBackupIncomplete && status === 'completed' && allCurrentStagesCompleted) {
    // Reopen once so the normalized eight-stage manifest is persisted.
    status = 'running';
  }
  if (status === 'completed' && !allCurrentStagesCompleted) return invalidTaskRun();
  if (status !== 'completed' && allCurrentStagesCompleted && !legacyBackupIncomplete) return invalidTaskRun();
  if (status === 'failed'
    && (failedStage === undefined || !validStage(failedStage) || stages[failedStage] !== 'failed')) return invalidTaskRun();
  if (status !== 'failed' && failedStage !== undefined) return invalidTaskRun();
  return {
    schema_version: 1,
    run_id: candidate.run_id,
    identity: candidate.identity as TaskRunIdentity,
    status,
    stages,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    ...(failedStage ? { failed_stage: failedStage } : {}),
    manifest_path: manifestPath,
    state_lock_path: join(dirname(dirname(manifestPath)), '.state.lock'),
  };
}

async function saveRun(run: TaskRun): Promise<TaskRun> {
  run.updated_at = new Date().toISOString();
  await writeCanonicalJson(run.manifest_path, manifestValue(run));
  return run;
}

async function loadRun(path: string): Promise<TaskRun | undefined> {
  try {
    return parseRun(JSON.parse(await readFile(path, 'utf8')), path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return invalidTaskRun();
    throw error;
  }
}

function stateLockPath(root: string): string {
  return resolveOwnedPath(root, '.state.lock');
}

/**
 * PKE keeps its workflow lock for the whole operation.  Flowmate commands
 * still use `work/run.lock` for each atomic stage, so the menu needs a
 * separate task lock that spans all stages and prevents two menus from
 * resuming the same run concurrently.
 */
export function taskRunLockPath(paths: { dataRoot: string }): string {
  return resolveOwnedPath(runRoot(paths.dataRoot), 'task.lock');
}

export function withTaskRunLock<T>(paths: { dataRoot: string }, operation: () => T | Promise<T>): Promise<T> {
  return withRunLock(taskRunLockPath(paths), operation, { jobId: 'flowmate-task' });
}

async function createOrResumeTaskRunUnlocked(paths: { dataRoot: string }, identity: TaskRunIdentity): Promise<{ run: TaskRun; resumed: boolean }> {
  if (!validIdentity(identity)) throw new Error('TASK_RUN_IDENTITY_INVALID');
  const root = runRoot(paths.dataRoot);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const candidates: TaskRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = resolveOwnedPath(root, `${entry.name}/run.json`);
    const run = await loadRun(path);
    if (run && run.status !== 'completed' && sameIdentity(run.identity, identity)) candidates.push(run);
  }
  candidates.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const existing = candidates[0];
  if (existing) {
    existing.status = taskStageKeys.every(stage => existing.stages[stage] === 'completed') ? 'completed' : 'running';
    delete existing.failed_stage;
    await saveRun(existing);
    return { run: existing, resumed: true };
  }
  const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const manifestPath = resolveOwnedPath(root, `${runId}/run.json`);
  const now = new Date().toISOString();
  const run: TaskRun = {
    schema_version: 1,
    run_id: runId,
    identity: structuredClone(identity),
    status: 'running',
    stages: initialStages(),
    created_at: now,
    updated_at: now,
    manifest_path: manifestPath,
    state_lock_path: stateLockPath(root),
  };
  await saveRun(run);
  return { run, resumed: false };
}

/** Create a run or reopen the newest incomplete run with the exact same input identity. */
export async function createOrResumeTaskRun(paths: { dataRoot: string }, identity: TaskRunIdentity): Promise<{ run: TaskRun; resumed: boolean }> {
  const root = runRoot(paths.dataRoot);
  return withRunLock(stateLockPath(root), () => createOrResumeTaskRunUnlocked(paths, identity), { jobId: 'flowmate-task-state' });
}

async function updateTaskRun(run: TaskRun, update: (latest: TaskRun) => void): Promise<TaskRun> {
  return withRunLock(run.state_lock_path, async () => {
    const latest = await loadRun(run.manifest_path);
    if (!latest) throw new Error('TASK_RUN_MANIFEST_MISSING');
    update(latest);
    await saveRun(latest);
    Object.assign(run, latest);
    return run;
  }, { jobId: `flowmate-task-state-${run.run_id}` });
}

export async function markTaskStageRunning(run: TaskRun, stage: TaskStage): Promise<TaskRun> {
  return updateTaskRun(run, latest => {
    latest.stages[stage] = 'running';
    latest.status = 'running';
    delete latest.failed_stage;
  });
}

export async function markTaskStageCompleted(run: TaskRun, stage: TaskStage): Promise<TaskRun> {
  return updateTaskRun(run, latest => {
    latest.stages[stage] = 'completed';
    latest.status = taskStageKeys.every(key => latest.stages[key] === 'completed') ? 'completed' : 'running';
    delete latest.failed_stage;
  });
}

export async function markTaskStageFailed(run: TaskRun, stage: TaskStage): Promise<TaskRun> {
  return updateTaskRun(run, latest => {
    latest.stages[stage] = 'failed';
    latest.status = 'failed';
    latest.failed_stage = stage;
  });
}
