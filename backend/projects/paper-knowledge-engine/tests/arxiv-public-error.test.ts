import { test, expect } from 'bun:test';
import { publicError } from '../src/library/operations/operation-contracts.ts';
import { formatProgressEvent } from '../src/cli/progress.ts';

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
