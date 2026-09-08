import { readFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import { resolveOwnedPath } from './config.ts';
import type { FlowmatePaths } from './contracts.ts';
import { createFlowmateMinerURuntime, parseInvoice, type ParseDependencies, type ParseReceipt, withRunLock } from './engine-bridge.ts';
import { sha256File } from './file-store.ts';
import { committedSelection } from './labels/voxel51.ts';
import { publishStructuredSnapshot } from './structured-snapshot.ts';
import { loadSampleRecords, saveSampleRecord, transitionSample, type SampleRecord } from './task-store.ts';

/** Also usable by public-file/knowledge acquisition once its record is committed. */
export async function processSample(input: { paths: FlowmatePaths; record: SampleRecord }, dependencies: ParseDependencies = {}): Promise<ParseReceipt> {
  const { paths, record } = input;
  if (record.original_ref.root !== 'original') throw new Error('PARSE_SOURCE_INVALID');
  const sourcePath = resolveOwnedPath(paths.originalRoot, record.original_ref.path);
  if (await sha256File(sourcePath) !== record.original_sha256) throw new Error('PARSE_SOURCE_HASH_MISMATCH');
  const runtime = createFlowmateMinerURuntime(paths);
  const outputDir = resolveOwnedPath(paths.dataRoot, `datasets/${record.dataset_id}/samples/${record.sample_id}/parsed`);
  return parseInvoice({ ...runtime, sampleId: record.sample_id, sourcePath, outputDir }, {
    ...dependencies,
    async onParsed(receipt) {
      if (receipt.originalSha256 !== record.original_sha256) throw new Error('PARSE_SOURCE_HASH_MISMATCH');
      // Read again under the parser's lock so metadata edits made before this
      // attempt do not get replaced by the selection's earlier view.
      const current = (await loadSampleRecords(paths, record.dataset_id)).find(value => value.sample_id === record.sample_id);
      if (!current || current.original_sha256 !== receipt.originalSha256) throw new Error('PARSE_SOURCE_HASH_MISMATCH');
      const status = current.processing_status === 'downloaded' || current.processing_status === 'failed' ? transitionSample(current, 'processed') : current;
      await saveSampleRecord(paths, { ...status, parser_key: receipt.parserKey, parse_attempt_id: receipt.attemptId, content_sha256: receipt.contentHash,
        derived_ref: { root: 'data', path: relative(paths.dataRoot, receipt.normalizedDir).replaceAll('\\', '/') } });
      await publishStructuredSnapshot({ paths, datasetId: record.dataset_id, sampleId: record.sample_id, parsed: receipt, lockHeld: true });
      await dependencies.onParsed?.(receipt);
    },
  });
}

export async function parseSelection(input: { paths: FlowmatePaths; selectionId: string; limit: number }, dependencies: ParseDependencies = {}) {
  return withRunLock(resolveOwnedPath(input.paths.dataRoot, 'work/run.lock'), () => parseSelectionUnlocked(input, { ...dependencies, lockHeld: true }), { jobId: `flowmate-parse-selection-${input.selectionId}` });
}

async function parseSelectionUnlocked(input: { paths: FlowmatePaths; selectionId: string; limit: number }, dependencies: ParseDependencies = {}) {
  const { paths, selectionId, limit } = input;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selectionId) || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('PARSE_SELECTION_INVALID');
  const datasetId = 'voxel51-hq-invoice-ocr';
  const records = await loadSampleRecords(paths, datasetId);
  const selected = committedSelection(await readFile(resolveOwnedPath(paths.dataRoot, `datasets/${datasetId}/selections/${selectionId}.json`)), datasetId, selectionId, records);
  const images = selected.filter(record => ['.jpg', '.jpeg', '.png'].includes(extname(record.original_ref.path).toLowerCase())).slice(0, limit);
  if (images.length === 0) throw new Error('PARSE_SELECTION_NO_IMAGE');
  const receipts: ParseReceipt[] = [];
  for (const record of images) receipts.push(await processSample({ paths, record }, dependencies));
  return { parsed: receipts.length, sample_ids: receipts.map(receipt => receipt.sampleId), attempts: receipts.map(receipt => receipt.attemptId) };
}
