import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProcessEnv } from '../src/shared/process-env.ts';

test('Windows child overrides replace every inherited case alias without mutating the parent', () => {
  const inherited = { Path: 'bin', HTTP_PROXY: 'old', Http_Proxy: 'other', no_proxy: 'old-bypass' };
  const before = { ...inherited };
  const env = mergeProcessEnv(inherited, { HTTP_PROXY: 'new', http_proxy: 'new', NO_PROXY: 'localhost', no_proxy: 'localhost' }, 'win32');
  assert.deepEqual(env, { PATH: 'bin', HTTP_PROXY: 'new', NO_PROXY: 'localhost' });
  assert.deepEqual(inherited, before);
});

test('Windows inherited environment alone has no case-insensitive duplicate keys', () => {
  assert.deepEqual(mergeProcessEnv({ Path: 'first', PATH: 'last', unused: undefined }, {}, 'win32'), { PATH: 'last' });
});

test('non-Windows child environment retains case-sensitive compatibility', () => {
  assert.deepEqual(mergeProcessEnv({ Path: 'bin', http_proxy: 'old' }, { HTTP_PROXY: 'new' }, 'linux'),
    { Path: 'bin', http_proxy: 'old', HTTP_PROXY: 'new' });
});
