import { readFile } from 'node:fs/promises';
import type { RunIdentity, TaskMode, TaskSelection } from '../../types/jobs.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function readTaskArtifact(artifactPath: string): Promise<Record<string, unknown> | null> {
  try {
    const artifact: unknown = JSON.parse(await readFile(artifactPath, 'utf8'));
    if (!isRecord(artifact)) throw new Error('invalid task artifact');
    return artifact;
  }
  catch (error) { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; }
}

export function validateTaskArtifact(artifact: unknown, run: RunIdentity): asserts artifact is Record<string, unknown> & { runId: string } {
  if (!isRecord(artifact) || artifact.runId !== run.id || (artifact.window
    && (!isRecord(artifact.window) || artifact.window.from !== run.from || artifact.window.to !== run.to))) {
    throw new Error('task artifact does not match the run and window');
  }
}

export function validateTaskSelection(selection: unknown, run: RunIdentity, mode: TaskMode, limit?: number | null): asserts selection is TaskSelection {
  const validItem = (item: unknown) => !isRecord(item) || item.accepted !== true
    || typeof item.primaryTrack !== 'string' || !item.primaryTrack
    || !isRecord(item.paper) || typeof item.paper.baseId !== 'string' || !item.paper.baseId
    || (item.paper.version !== undefined && (typeof item.paper.version !== 'number' || !Number.isSafeInteger(item.paper.version)));
  const fallbacks = isRecord(selection) && selection.fallbacks === undefined ? [] : isRecord(selection) ? selection.fallbacks : undefined;
  validateTaskArtifact(selection, run);
  if (selection.schemaVersion !== 1 || selection.mode !== mode || !selection.window
    || typeof selection.requestedLimit !== 'number' || !Number.isInteger(selection.requestedLimit) || selection.requestedLimit < 1
    || !Array.isArray(selection.selected) || selection.selected.length > selection.requestedLimit
    || selection.selected.some(validItem)
    || !Array.isArray(fallbacks) || fallbacks.some(validItem)
    || new Set([...selection.selected, ...fallbacks].map(item => item.paper.baseId)).size !== selection.selected.length + fallbacks.length) {
    throw new Error('invalid task selection checkpoint');
  }
  if (limit != null && limit !== selection.requestedLimit) {
    throw new Error('resumed task has a fixed selection; omit --limit or use its original limit');
  }
}
