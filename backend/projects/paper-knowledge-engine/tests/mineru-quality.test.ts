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
