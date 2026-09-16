import { test, expect } from 'bun:test';
import { publicError } from '../src/library/operations/operation-contracts.ts';
import { formatProgressEvent } from '../src/cli/progress.ts';
import { jobView } from '../src/library/operations/operation-store.ts';
import { asLibraryId } from '../src/shared/identity.ts';

for (const retryAfterMs of [0,60_000]) test(`job summary preserves cooldown meaning through serialization (${retryAfterMs}ms)`, () => {
  const safe = publicError({code:'ARXIV_CAPACITY_LIMITED',retryAfterMs,retryNotBefore:'2026-09-15T13:06:43.952Z',diagnostic:'private-secret'});
  const stored = JSON.parse(JSON.stringify(safe));
  const summary = jobView({jobId:'fixture',requestId:'fixture',libraryId:asLibraryId('agent-engineering'),
    status:'failed',stage:'acquire',updatedAt:'2026-09-15T13:06:44.000Z',canResume:true,error:stored});
  expect(summary.error).toEqual(safe);
  expect(summary.error?.message).toContain(retryAfterMs === 0 ? '未设置本地冷却' : '冷却至');
  expect(JSON.stringify(summary)).not.toContain('private-secret');
  expect(publicError(summary.error)).toEqual(safe);
});

test('a 429 without a local or server delay does not tell users to wait for cooldown', () => {
  const result = publicError({code:'ARXIV_CAPACITY_LIMITED',retryAfterMs:0,retryNotBefore:'2026-09-15T10:00:00.000Z'});
  expect(result.message).toContain('未设置本地冷却');
  expect(result.message).not.toContain('冷却至');
  const progress = formatProgressEvent({type:'discovery-deferred',phase:'discovery',waitMs:0,retryNotBefore:'2026-09-15T10:00:00.000Z'});
  expect(progress).toContain('未设置本地冷却');
  expect(progress).not.toContain('冷却至');
});

test('invalid delay metadata is neither exposed nor treated as zero cooldown', () => {
  for (const retryAfterMs of [-1, NaN, Infinity, 'private-secret', {secret:'private-secret'}]) {
    const result = publicError({code:'ARXIV_CAPACITY_LIMITED',retryAfterMs,retryNotBefore:'2026-09-15T13:06:43.952Z'});
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.message).not.toContain('未设置本地冷却');
    expect(JSON.stringify(result)).not.toContain('private-secret');
  }
});

for (const code of ['ARXIV_CAPACITY_LIMITED', 'ARXIV_COOLDOWN_ACTIVE']) {
  test(`${code} survives public output with local recovery time but no raw diagnostics`, () => {
    const result = publicError(Object.assign(new Error('Bearer private-secret'), {
      code, retryNotBefore: '2026-09-05T16:45:03.029Z', diagnostic: 'https://private.invalid/token',
    }));
    expect(result.code).toBe(code);
    expect(result.message).toContain('2026-09-06 00:45:03 北京时间');
    expect(result.message).toContain('跳过已完成分片');
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer|token/);
  });
}
test('transport-unavailable public output preserves only a safe route label', () => {
  const result = publicError(Object.assign(new Error('Bearer private-secret'), {
    code: 'ARXIV_TRANSPORT_UNAVAILABLE', proxyMode: 'direct', apiHost: 'arxiv.org',
    diagnostic: 'https://private.invalid/token',
  }));
  expect(result.code).toBe('ARXIV_TRANSPORT_UNAVAILABLE');
  expect(result.message).toContain('direct');
  expect(result.message).toContain('arxiv.org');
  expect(JSON.stringify(result)).not.toMatch(/private|Bearer|token/);
});
test('Evidence I/O failures expose stable recovery guidance without filesystem diagnostics', () => {
  const result = publicError(Object.assign(new Error('EPERM: rename D:\\private\\publication-journal.json.new'), {
    code: 'EVIDENCE_IO', diagnostic: 'D:\\private\\publication-journal.json',
  }));
  expect(result).toEqual({
    code: 'EVIDENCE_IO',
    message: 'EVIDENCE_IO: Evidence 文件事务写入失败，恢复材料已保留；请稍后重试 Evidence 发布',
  });
  expect(JSON.stringify(result)).not.toContain('publication-journal.json');
});
test('invalid cooldown timestamps never leak arbitrary text or prevent displaying recovery guidance', () => {
  const result = publicError({code:'ARXIV_COOLDOWN_ACTIVE',retryNotBefore:'secret-invalid-time'});
  expect(result.code).toBe('ARXIV_COOLDOWN_ACTIVE');
  expect(result.message).not.toContain('secret-invalid-time');
  expect(formatProgressEvent({type:'discovery-deferred',phase:'discovery',retryNotBefore:'secret-invalid-time'})).not.toContain('secret-invalid-time');
});
