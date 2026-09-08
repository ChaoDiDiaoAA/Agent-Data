import { test, expect } from 'bun:test';
import { sourceIdentity } from '../src/research/source-identity.ts';

test('rejects unsafe URLs, unknown and benchmark kinds, unsafe versions and malformed hashes', () => {
  const base = { kind: 'official-doc' as const, canonicalUrl: 'https://openai.com/docs', contentSha256: 'a'.repeat(64) };
  for (const canonicalUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@openai.com/x', 'https://localhost/x', 'http://127.1/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://openai.com/a/../b', 'https://openai.com/%2e%2e/b', 'https://openai.com/a\\b']) expect(() => sourceIdentity({ ...base, canonicalUrl })).toThrow();
  for (const kind of ['benchmark', 'dataset', 'leaderboard', 'unknown']) expect(() => sourceIdentity({ ...base, kind: kind as never })).toThrow();
  for (const revision of ['../v1', 'a/b', 'CON', 'v1.', '', 'a:b']) expect(() => sourceIdentity({ ...base, revision })).toThrow();
  for (const contentSha256 of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) expect(() => sourceIdentity({ ...base, contentSha256 })).toThrow();
  expect(() => sourceIdentity({ ...base, kind: 'repository', commit: 'a'.repeat(39) })).toThrow();
  expect(() => sourceIdentity({ ...base, kind: 'release', commit: 'a'.repeat(40) })).toThrow();
  expect(() => sourceIdentity({ ...base, kind: 'paper', canonicalUrl: 'https://arxiv.org/abs/2601.12345' })).toThrow();
});

test('repository commits, normalized tags, releases and local hashes have distinct identities', () => {
  const base = { canonicalUrl: 'http://GitHub.COM/OpenAI/SDK.git/', contentSha256: 'a'.repeat(64) };
  const repo = sourceIdentity({ ...base, kind: 'repository', commit: 'B'.repeat(40) });
  expect(repo.identityKey).toBe('repo:https://github.com/openai/sdk');
  expect(repo.versionId).toBe('b'.repeat(40));
  expect(sourceIdentity({ ...base, kind: 'repository', tag: 'refs/tags/v1.0' }).versionId).toBe('v1.0');
  expect(sourceIdentity({ ...base, kind: 'release', tag: 'refs/tags/v1.0' }).identityKey).toBe('release:https://github.com/openai/sdk:v1.0');
  expect(sourceIdentity({ kind: 'local-artifact', canonicalUrl: '', contentSha256: 'a'.repeat(64) })).toMatchObject({ identityKey: `local:${'a'.repeat(64)}`, canonicalUrl: '', versionId: `content-${'a'.repeat(16)}` });
});

test('arXiv URL forms and explicit versions share one normalized identity', () => {
  const first = sourceIdentity({ kind: 'paper', canonicalUrl: 'http://export.arxiv.org/pdf/2601.12345v1.pdf', contentSha256: 'a'.repeat(64) });
  const second = sourceIdentity({ kind: 'technical-report', canonicalUrl: 'https://arxiv.org/abs/2601.12345v2', contentSha256: 'b'.repeat(64) });
  expect(first.identityKey).toBe('arxiv:2601.12345');
  expect(first.canonicalUrl).toBe('https://arxiv.org/abs/2601.12345');
  expect(first.versionId).toBe('v1');
  expect(second.versionId).toBe('v2');
  expect(second.sourceId).toBe(first.sourceId);
  expect(sourceIdentity({ kind: 'paper', canonicalUrl: 'https://arxiv.org/abs/hep-th/9901001v3', contentSha256: 'a'.repeat(64) }).identityKey).toBe('arxiv:hep-th/9901001');
});

test('normalizes document URLs and derives independent content versions', () => {
  const result = sourceIdentity({ kind: 'official-doc', canonicalUrl: 'HTTPS://OpenAI.COM:443/docs/?b=2&a=1#intro', contentSha256: 'a'.repeat(64) });
  expect(result.canonicalUrl).toBe('https://openai.com/docs?a=1&b=2');
  expect(result.identityKey).toBe('doc:https://openai.com/docs?a=1&b=2');
  expect(result.sourceId).toMatch(/^[a-f0-9]{32}$/);
  expect(result.versionId).toBe('content-aaaaaaaaaaaaaaaa');
  expect(sourceIdentity({ kind: 'official-doc', canonicalUrl: result.canonicalUrl, contentSha256: 'b'.repeat(64) }).sourceId).toBe(result.sourceId);
});
