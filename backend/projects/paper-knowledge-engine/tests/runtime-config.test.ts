import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import YAML from 'yaml';
import { makeRuntimeFixture } from './fixtures/runtime-fixtures.ts';
import { loadRuntimeConfig, validateRuntimePolicy } from '../src/shared/config.ts';

test('runtime policy reloads YAML and rejects missing fields', async () => {
  const fixture = await makeRuntimeFixture();
  try {
    await writeFile(
      join(fixture.projectRoot, 'config', 'runtime.yaml'),
      'process_cleanup_timeout_ms: 2300\ndiagnostic_timeout_ms: 4700\nmax_output_bytes: 8192\n',
    );

    assert.deepEqual(loadRuntimeConfig(fixture.projectRoot), {
      processCleanupTimeoutMs: 2300,
      diagnosticTimeoutMs: 4700,
      maxOutputBytes: 8192,
    });
    assert.throws(() => validateRuntimePolicy({}), /required|missing/);
  } finally {
    await fixture.dispose();
  }
});

test('runtime policy rejects unknown, non-integer, and non-positive values', () => {
  const valid = {
    process_cleanup_timeout_ms: 1,
    diagnostic_timeout_ms: 2,
    max_output_bytes: 3,
  };

  assert.throws(() => validateRuntimePolicy({ ...valid, unexpected: true }), /unknown/);
  assert.throws(() => validateRuntimePolicy({ ...valid, max_output_bytes: 1.5 }), /positive safe integer/);
  assert.throws(() => validateRuntimePolicy({ ...valid, max_output_bytes: Number.MAX_SAFE_INTEGER + 1 }), /positive safe integer/);
  assert.throws(() => validateRuntimePolicy({ ...valid, diagnostic_timeout_ms: 0 }), /positive safe integer/);
});

test('runtime policy rejects malformed YAML values and a deleted config file', async () => {
  const fixture = await makeRuntimeFixture();
  const runtimePath = join(fixture.projectRoot, 'config', 'runtime.yaml');
  try {
    for (const [name, yaml, error] of [
      ['unknown field', 'process_cleanup_timeout_ms: 1\ndiagnostic_timeout_ms: 2\nmax_output_bytes: 3\nextra: 4\n', /unknown/],
      ['missing field', 'process_cleanup_timeout_ms: 1\ndiagnostic_timeout_ms: 2\n', /missing required/],
      ['zero value', 'process_cleanup_timeout_ms: 0\ndiagnostic_timeout_ms: 2\nmax_output_bytes: 3\n', /positive safe integer/],
      ['fractional value', 'process_cleanup_timeout_ms: 1\ndiagnostic_timeout_ms: 2.5\nmax_output_bytes: 3\n', /positive safe integer/],
    ] as const) {
      await writeFile(runtimePath, yaml);
      assert.throws(() => loadRuntimeConfig(fixture.projectRoot), error, name);
    }
    await rm(runtimePath);
    assert.throws(() => loadRuntimeConfig(fixture.projectRoot), /ENOENT/);
  } finally {
    await fixture.dispose();
  }
});

test('runtime fixture writes every configured output root inside its own disposable boundary', async () => {
  const fixture = await makeRuntimeFixture();
  const runtimeProbe = join(fixture.paths.stateRoot, 'probe.txt');
  const isInsideFixture = (path: string) => {
    const value = relative(fixture.root, path);
    return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  };

  try {
    const configuredPaths = YAML.parse(await readFile(join(fixture.projectRoot, 'config', 'paths.local.yaml'), 'utf8'));
    const mineru = YAML.parse(await readFile(join(fixture.projectRoot, 'config', 'mineru-local.yaml'), 'utf8'));
    assert.deepEqual(configuredPaths, {
      pdf_root: fixture.paths.pdfRoot,
      vault_root: fixture.paths.vaultRoot,
      state_root: fixture.paths.stateRoot,
      temp_root: fixture.paths.tempRoot,
      backup_root: fixture.paths.backupRoot,
    });
    const mineruOutputRoot = join(fixture.paths.stateRoot, 'extracted');
    assert.equal(mineru.output_root, undefined);
    assert.equal(isInsideFixture(mineruOutputRoot), true);
    for (const outputPath of [...Object.values(fixture.paths), mineruOutputRoot]) {
      assert.equal(isInsideFixture(outputPath), true);
    }
    await writeFile(runtimeProbe, 'fixture-only');
    await access(runtimeProbe);
  } finally {
    await fixture.dispose();
  }

  await assert.rejects(access(fixture.root));
});
