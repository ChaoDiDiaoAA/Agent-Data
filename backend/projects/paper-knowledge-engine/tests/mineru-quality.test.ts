import test from 'node:test';
import assert from 'node:assert/strict';
import { assessExtraction, createOcrRetryJob } from '../src/mineru/mineru-quality.ts';

test('requests only one OCR retry through the same configured local model', () => {
  const first = assessExtraction([{ text: '' }], { pageCount: 1 }, { isOcrAttempt: false });
  const second = assessExtraction([{ text: '' }], { pageCount: 1 }, { isOcrAttempt: true });
  assert.equal(first.retryWithOcr, true);
  assert.equal(second.retryWithOcr, false);
  assert.equal(second.terminalState, 'parse_failed');
});

test('OCR retry changes only the OCR flag', () => {
  const job = { arxivId: '2601.1', model: 'pipeline', cliBackend: 'pipeline', isOcr: false };
  assert.deepEqual(createOcrRetryJob(job), { ...job, isOcr: true });
  assert.throws(() => createOcrRetryJob({ ...job, isOcr: true }), /already attempted/);
});

test('accepts a textless page when MinerU preserved its visual asset', () => {
  const result = assessExtraction([
    { pageNumber: 1, text: '' },
    { pageNumber: 2, text: 'body' },
  ], { pageCount: 2 }, { visualOnlyPages: [1] });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.visualOnlyPages, [1]);
});

test('accepts an image-only document when every page has a preserved visual asset', () => {
  const result = assessExtraction([
    { pageNumber: 1, text: '' },
    { pageNumber: 2, text: '' },
  ], { pageCount: 2 }, { visualOnlyPages: [1, 2] });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reasons, []);
});

test('requests a table-disabled retry when a visual block has no usable asset', () => {
  const result = assessExtraction([
    { pageNumber: 1, text: 'body' },
    { pageNumber: 2, text: '' },
  ], { pageCount: 2 }, { visualBlockPages: [2] });
  assert.equal(result.accepted, false);
  assert.equal(result.retryWithTableDisabled, true);
  assert.deepEqual(result.reasons, ['empty_page_ratio']);
});
