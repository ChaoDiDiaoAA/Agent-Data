import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEngineContext } from '../src/shared/engine-context.ts';

test('production paper discovery keeps an adaptive arXiv capacity cooldown enabled', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId: 'skill-prompt-engineering' });
  assert.equal(context.engine.arxiv.capacityCooldownMs, 900_000);
});
