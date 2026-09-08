import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSampleRecords, saveSampleRecord, summarizeTask, transitionSample } from '../src/task-store.ts';
import type { SampleRecord } from '../src/task-store.ts';
import type { FlowmatePaths } from '../src/contracts.ts';

const temporaryDirectories: string[] = [];

async function paths(): Promise<FlowmatePaths> {
  const root = await mkdtemp(join(tmpdir(), 'flowmate-task-store-'));
  temporaryDirectories.push(root);
  return {
    projectRoot: root, paperEngineRoot: root, originalRoot: join(root, 'original'), dataRoot: join(root, 'data'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup'),
  };
}

function record(sampleId: string, sha256 = 'a'.repeat(64)): SampleRecord {
  return {
    schema_version: 1, sample_id: sampleId, dataset_id: 'invoices', dataset_revision: 'r1', source_record_id: sampleId,
    origin_kind: 'public_redacted', document_kind: 'invoice', language: 'en', layout_group: null,
    original_ref: { root: 'original', path: `datasets/invoices/samples/${sampleId}/original.png` }, original_sha256: sha256,
    source_observations: [], label_kind: 'none', quality_status: 'not_checked', processing_status: 'selected',
    allowed_uses: ['development'], created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z',
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('sample records', () => {
  test('keeps created_at stable and only changes updated_at when record content changes', async () => {
    const configuredPaths = await paths();
    await saveSampleRecord(configuredPaths, record('one'));
    const saved = (await loadSampleRecords(configuredPaths, 'invoices'))[0]!;
    await saveSampleRecord(configuredPaths, { ...record('one'), created_at: '2026-09-09T00:00:00.000Z', updated_at: '2026-09-09T00:00:00.000Z' });
    expect((await loadSampleRecords(configuredPaths, 'invoices'))[0]).toMatchObject({
      created_at: saved.created_at, updated_at: saved.updated_at,
    });

    await saveSampleRecord(configuredPaths, { ...record('one'), quality_status: 'usable', updated_at: '2000-01-01T00:00:00.000Z' });
    expect((await loadSampleRecords(configuredPaths, 'invoices'))[0]).toMatchObject({
      created_at: saved.created_at,
    });
    expect((await loadSampleRecords(configuredPaths, 'invoices'))[0]!.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  test('marks identical originals as duplicates only within their dataset', async () => {
    const configuredPaths = await paths();
    await saveSampleRecord(configuredPaths, record('first'));
    await saveSampleRecord(configuredPaths, record('second'));

    expect((await loadSampleRecords(configuredPaths, 'invoices')).find(item => item.sample_id === 'second')?.duplicate_of).toBe('first');
  });

  test('removes caller-supplied duplicate_of when the original becomes unique', async () => {
    const configuredPaths = await paths();
    await saveSampleRecord(configuredPaths, record('first'));
    await saveSampleRecord(configuredPaths, record('second'));
    await saveSampleRecord(configuredPaths, {
      ...record('second', 'b'.repeat(64)), duplicate_of: 'first', quality_status: 'usable',
    });

    expect((await loadSampleRecords(configuredPaths, 'invoices')).find(item => item.sample_id === 'second')?.duplicate_of).toBeUndefined();
  });
});

test('rejects a state transition that moves backward', () => {
  expect(() => transitionSample({ ...record('one'), processing_status: 'processed' }, 'downloaded')).toThrow('INVALID_SAMPLE_TRANSITION');
});

test('retries a failed sample from its persisted last successful state', () => {
  const failed = transitionSample({ ...record('one'), processing_status: 'downloaded' }, 'failed');
  expect(transitionSample(failed, 'downloaded').processing_status).toBe('downloaded');
});

test('summarizes mixed successful and failed samples as partial', () => {
  expect(summarizeTask([
    { ...record('one'), processing_status: 'completed' },
    { ...record('two'), processing_status: 'failed' },
  ])).toBe('partial');
});
