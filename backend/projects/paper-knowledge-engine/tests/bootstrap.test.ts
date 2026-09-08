import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapStageOne } from '../src/library/bootstrap.ts';

test('creates managed trees without modifying existing Obsidian files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsd-bootstrap-'));
  const config = { root: process.cwd(), pdfRoot: join(root, 'paper'), vaultRoot: join(root, 'vault') };
  const categories = {
    tracks: {
      A: { pdf: '01-A' },
      B: { pdf: '02-B' },
    },
    fallback_pdf: '99-Unclassified',
  };
  await mkdir(join(config.vaultRoot, '.obsidian'), { recursive: true });
  await writeFile(join(config.vaultRoot, '.obsidian', 'app.json'), '{"keep":true}');
  await writeFile(join(config.vaultRoot, '欢迎.md'), '保留');
  const before = await Promise.all([
    readFile(join(config.vaultRoot, '.obsidian', 'app.json'), 'utf8'),
    readFile(join(config.vaultRoot, '欢迎.md'), 'utf8'),
  ]);
  try {
    await bootstrapStageOne(config, categories);
    const pdfDirectories = (await readdir(config.pdfRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(pdfDirectories, ['01-A', '02-B', '99-Unclassified']);
    await bootstrapStageOne(config, categories);
    assert.deepEqual(await Promise.all([
      readFile(join(config.vaultRoot, '.obsidian', 'app.json'), 'utf8'),
      readFile(join(config.vaultRoot, '欢迎.md'), 'utf8'),
    ]), before);
    assert.deepEqual((await readdir(config.vaultRoot)).sort(), ['.obsidian', 'Evidence', '欢迎.md']);
    assert.deepEqual((await readdir(join(config.vaultRoot, 'Evidence'))).sort(), ['indexes', 'papers']);
    for (const path of ['papers', 'indexes']) {
      assert.deepEqual(await readdir(join(config.vaultRoot, 'Evidence', path)), []);
    }
    await assert.rejects(readFile(join(config.pdfRoot, 'README.md')), /ENOENT/);
    await assert.rejects(readFile(join(config.vaultRoot, 'log.md'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(join(config.vaultRoot, '08-Templates', 'knowledge-feedback.md'), 'utf8'), /ENOENT/);
  } finally { await removeOwnedTestDirectory(root); }
});

test('bootstrap does not require templates or read manual Vault files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsd-bootstrap-no-templates-'));
  try {
    const vaultRoot = join(root, 'vault');
    await mkdir(join(vaultRoot, 'README.md'), { recursive: true });
    await mkdir(join(vaultRoot, 'index.md'));
    await bootstrapStageOne({ root, vaultRoot, pdfRoot: join(root, 'pdf') });
    assert.deepEqual((await readdir(vaultRoot)).sort(), ['Evidence', 'README.md', 'index.md']);
  } finally { await removeOwnedTestDirectory(root); }
});

test('bootstrap rejects a Vault junction before creating managed files outside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsd-bootstrap-link-'));
  try {
    const outside = join(root, 'outside'), vaultRoot = join(root, 'vault');
    await mkdir(outside);
    await symlink(outside, vaultRoot, 'junction');
    await assert.rejects(bootstrapStageOne({ root, vaultRoot, pdfRoot: join(root, 'pdf') }), /link|reparse|EVIDENCE_PATH/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(join(root, 'vault'), { recursive: true, force: true });
    await removeOwnedTestDirectory(root);
  }
});

test('bootstrap rejects a differently cased Evidence root without creating another layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fsd-bootstrap-case-'));
  try {
    const vaultRoot = join(root, 'vault');
    await mkdir(join(vaultRoot, 'evidence'), { recursive: true });
    await assert.rejects(bootstrapStageOne({ root, vaultRoot, pdfRoot: join(root, 'pdf') }), /EVIDENCE_PATH/);
    assert.deepEqual(await readdir(join(vaultRoot, 'evidence')), []);
  } finally { await removeOwnedTestDirectory(root); }
});
