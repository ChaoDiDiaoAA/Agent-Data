import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPublication } from '../src/library/selection/metadata-verifier.ts';

test('metadata outages remain unverified instead of blocking', async () => {
  const result = await verifyPublication({}, [{ name: 'offline', lookup: async () => { throw Object.assign(new Error('down'), { code: 'ETIMEDOUT' }); } }]);
  assert.deepEqual(result, { publicationStatus: 'unverified', metadataVerification: 'pending', source: null });
});

test('first verified source wins', async () => {
  const result = await verifyPublication({ baseId: '2601.1' }, [
    { name: 'crossref', lookup: async () => ({ verified: false }) },
    { name: 'openalex', lookup: async () => ({ verified: true, status: 'published' }) },
  ]);
  assert.deepEqual(result, { publicationStatus: 'published', metadataVerification: 'verified', source: 'openalex' });
});

test('malformed advisory verification cannot mark publication verified', async () => {
  for (const value of [{ verified: 'yes' }, { verified: true, status: 42 }, { verified: true, baseId: 'other' }]) {
    const result = await verifyPublication({ baseId: '2601.1' }, [{ lookup: async () => value }]);
    assert.equal(result.metadataVerification, 'pending');
  }
});
