import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { loadPaperPolicy } from '../src/shared/config.ts';

const rules = loadPaperPolicy('config/fsd/paper-policy.yaml');
const candidate = (extra = {}) => ({
  baseId: '2608.12345', arxivId: '2608.12345v1', version: 1,
  title: 'LLM for test generation', summary: 'Tests are generated for a repository.',
  published: '2026-08-01', updated: '2026-08-01',
  categories: ['cs.SE'], matchedTracks: ['AI-TDD'], ...extra,
});

test('automatically accepts matching sources without a review receipt', () => {
  const result = evaluateCandidate(candidate(), rules);
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'accepted');
  assert.equal(result.lane, 'ai');
  assert.deepEqual(result.paper.eligibleTracks, ['AI-TDD']);
  assert.equal(result.reasons.technologyAccepted, true);
  assert.equal(result.reasons.taskAccepted, true);
});

test('sources missing technology or task evidence are rejected without waiting', () => {
  for (const title of ['Manual test generation', 'LLM image synthesis', 'General software discussion']) {
    const result = evaluateCandidate(candidate({ title, summary: '' }), rules);
    assert.equal(result.accepted, false, title);
    assert.equal(result.status, 'rejected', title);
  }
});

test('derived labels and normalized text cannot manufacture inclusion evidence', () => {
  const result = evaluateCandidate(candidate({
    title: 'Unrelated material', summary: '', normalizedText: 'LLM test generation',
    aiTechniques: ['llm'], programStructures: ['ast'], engineeringTasks: ['test generation'],
    eligibleTracks: ['AI-TDD'], review: { verdict: 'accept' },
  }), rules);
  assert.equal(result.accepted, false);
  assert.equal(result.signals.technologyMatched, false);
  assert.equal(result.signals.taskMatched, false);
});

test('derived fields cannot hide real inclusion evidence', () => {
  const result = evaluateCandidate(candidate({ normalizedText: 'unrelated', aiTechniques: ['invented'] }), rules);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.paper.aiTechniques, ['llm']);
});

test('source identity, version, date and exclusions remain mandatory', () => {
  for (const extra of [
    { arxivId: 'https://example.com/paper' }, { arxivId: '2608.12345v2' },
    { baseId: '2608.99999' }, { published: 'not-a-date', updated: 'not-a-date' },
    { published: '2026-02-30', updated: '2026-03-01' },
    { published: '2025-01-01', updated: '2025-12-31', submittedAt: '2026-08-01', hasImportant2026Version: true },
    { title: 'LLM for test generation in autonomous-driving systems', normalizedText: 'safe software topic' },
  ]) {
    const result = evaluateCandidate(candidate(extra), rules);
    assert.equal(result.accepted, false, JSON.stringify(extra));
    assert.equal(result.status, 'rejected');
  }
});

test('old papers updated within the configured date boundary remain eligible', () => {
  assert.equal(evaluateCandidate(candidate({ published: '2025-10-28', updated: '2026-04-04' }), rules).accepted, true);
});

test('program-analysis eligibility does not need an AI term', () => {
  const result = evaluateCandidate(candidate({ title: 'Control flow graph for test generation', matchedTracks: ['AI-Program-Analysis-AST'] }), rules);
  assert.equal(result.accepted, true);
  assert.equal(result.lane, 'program-analysis');
  assert.deepEqual(result.paper.aiTechniques, []);
});

test('automatic eligibility keeps enabled retrieval labels and cannot inject another track', () => {
  const result = evaluateCandidate(candidate({
    matchedTracks: ['AI-TDD', 'AI-Program-Analysis-AST', 'AI-TDD', 'Unknown'],
    eligibleTracks: ['LLM-Wiki'],
  }), rules);
  assert.deepEqual(result.paper.eligibleTracks, ['AI-TDD', 'AI-Program-Analysis-AST']);
  assert.equal(evaluateCandidate(candidate({ matchedTracks: ['Unknown'] }), rules).accepted, false);
});
