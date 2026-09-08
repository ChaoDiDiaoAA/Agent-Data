import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadProjectPaths } from '../src/shared/config.ts';

test('mineru-config prints normalized layered MinerU values as JSON', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', '--library', 'fsd', 'mineru-config', '--format', 'json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const descriptor = JSON.parse(result.stdout);
  assert.match(descriptor.configFile, /config[\\/]engine\.yaml$/);
  assert.equal(descriptor.model, 'pipeline');
  assert.equal(descriptor.cliBackend, 'pipeline');
  assert.equal(descriptor.expectedVersion, '3.4.5');
  assert.equal(descriptor.expectedCommit, '4fe4bde114a23ee5dd637eae99b767f4669bf58c');
  assert.equal(descriptor.modelSourceRuntime, 'local');
  assert.equal(descriptor.maxConcurrency, 1);
  assert.equal(descriptor.pipelineBatchRatio, 1);
  assert.equal(descriptor.taskTimeoutSeconds, 3600);
  assert.equal(descriptor.resultDownloadTimeoutSeconds, 600);
  assert.equal(descriptor.apiHost, '127.0.0.1');
  assert.equal(descriptor.apiPort, 17860);
  assert.equal(descriptor.apiUrl, 'http://127.0.0.1:17860');
  assert.equal(descriptor.apiStartupTimeoutSeconds, 120);
  assert.equal(descriptor.outputRoot, join(loadProjectPaths({ root: process.cwd() }).stateRoot, 'archive'));
  assert.equal(descriptor.modelLockPath, join(loadProjectPaths({ root: process.cwd() }).stateRoot, 'runs', 'mineru-model-lock.json'));
});
