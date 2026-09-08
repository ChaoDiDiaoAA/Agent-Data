import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../src/library/operations/operation-contracts.ts';

test('accepts libraryId and rejects the retired projectId field', () => {
  const request = validateRequest({ libraryId: 'fsd', requestId: 'req-1', operation: { kind: 'current' } });
  assert.equal(request.libraryId, 'fsd');
  assert.throws(
    () => validateRequest({ projectId: 'fsd-code2doc', requestId: 'req-1', operation: { kind: 'current' } }),
    { code: 'INVALID_REQUEST' },
  );
});

test('rejects unknown top-level request fields', () => {
  assert.throws(
    () => validateRequest({ libraryId: 'fsd', requestId: 'req-1', operation: { kind: 'current' }, cwd: 'D:/secret' }),
    { code: 'INVALID_REQUEST' },
  );
});

test('enforces the exact lowercase-hyphen library identity contract', () => {
  for (const libraryId of ['fsd', 'ai-tdd', 'a1', 'a-b-c']) {
    assert.equal(validateRequest({ libraryId, requestId: `req-${libraryId}`, operation: { kind: 'current' } }).libraryId, libraryId);
  }
  for (const libraryId of ['', 'f', 'FSD', '1fsd', 'fsd_wiki', 'fsd wiki', 'a'.repeat(33)]) {
    assert.throws(
      () => validateRequest({ libraryId, requestId: 'req-invalid', operation: { kind: 'current' } }),
      { code: 'INVALID_REQUEST' },
    );
  }
});

test('rejects unknown top-level request fields instead of accepting aliases', () => {
  assert.throws(
    () => validateRequest({ libraryId: 'fsd', requestId: 'req-extra', operation: { kind: 'current' }, projectId: 'fsd-code2doc' }),
    { code: 'INVALID_REQUEST' },
  );
  assert.throws(
    () => validateRequest({ libraryId: 'fsd', requestId: 'req-extra', operation: { kind: 'current' }, extra: true }),
    { code: 'INVALID_REQUEST' },
  );
});
