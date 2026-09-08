import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenCliEnvironment,
  defaultArxivApiBase,
  resolveArxivApiBase,
} from '../src/discovery/arxiv-transport.ts';

const inherited = {
  PATH: 'C:\\bin',
  HTTP_PROXY: 'http://old-proxy:1',
  HTTPS_PROXY: 'http://old-proxy:1',
  http_proxy: 'http://old-proxy:1',
  https_proxy: 'http://old-proxy:1',
  ALL_PROXY: 'socks5://old-proxy:1',
  all_proxy: 'socks5://old-proxy:1',
  NO_PROXY: 'internal.example',
  no_proxy: 'internal.example',
};

test('arXiv API base defaults to export host and accepts only the two known endpoints', () => {
  assert.equal(resolveArxivApiBase(), defaultArxivApiBase);
  assert.equal(resolveArxivApiBase('https://arxiv.org/api/query'), 'https://arxiv.org/api/query');
  assert.equal(resolveArxivApiBase('https://export.arxiv.org/api/query'), defaultArxivApiBase);
  for (const value of [
    'http://arxiv.org/api/query', 'https://example.invalid/api/query',
    'https://user:secret@arxiv.org/api/query', 'https://arxiv.org/api/query?x=1',
    'https://arxiv.org/api/query/', 'https://arxiv.org/other',
  ]) assert.throws(() => resolveArxivApiBase(value), /known arXiv API base/);
});

test('direct OpenCLI route removes all proxy aliases on Windows and sets NO_PROXY wildcard', () => {
  const env = buildOpenCliEnvironment(inherited, { mode: 'direct', platform: 'win32' });
  assert.equal(env.PATH, 'C:\\bin');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    assert.equal(env[key], key === 'NO_PROXY' ? '*' : undefined, key);
  }
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) assert.equal(env[key], undefined, key);
});

test('direct OpenCLI route removes all proxy aliases on POSIX and sets both NO_PROXY aliases', () => {
  const env = buildOpenCliEnvironment(inherited, { mode: 'direct', platform: 'linux' });
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.NO_PROXY, '*');
  assert.equal(env.no_proxy, '*');
});

test('configured route replaces inherited proxy aliases without changing the parent map', () => {
  const before = structuredClone(inherited);
  const env = buildOpenCliEnvironment(inherited, {
    mode: 'configured', httpProxy: 'http://127.0.0.1:7897', platform: 'win32',
  });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.deepEqual(inherited, before);
});

test('inherit route preserves inherited proxy environment', () => {
  assert.deepEqual(buildOpenCliEnvironment(inherited, { mode: 'inherit', platform: 'linux' }), inherited);
});
