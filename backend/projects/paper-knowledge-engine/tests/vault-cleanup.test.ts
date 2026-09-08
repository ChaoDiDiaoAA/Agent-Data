import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyVaultCleanup, createVaultCleanupReview, publicVaultCleanupPlan } from '../src/maintenance/vault-cleanup.ts';
import { routeVaultCleanup } from '../src/cli/routes.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vault-cleanup-'));
  const vaultRoot = join(root, 'vault');
  const backupRoot = join(root, 'backups');
  await mkdir(join(vaultRoot, '.obsidian'), { recursive: true });
  await mkdir(join(vaultRoot, 'Evidence'), { recursive: true });
  await mkdir(join(vaultRoot, '01-Evidence'), { recursive: true });
  await writeFile(join(vaultRoot, 'Evidence', 'index.md'), '# Active Evidence\n');
  await writeFile(join(vaultRoot, '.obsidian', 'app.json'), '{"unchanged":true}');
  await writeFile(join(vaultRoot, '01-Evidence', 'index.md'), '# Evidence\n');
  await writeFile(join(vaultRoot, 'index.md'), '# Root\n');
  await writeFile(join(vaultRoot, 'README.md'), '# Read me\n');
  return { root, vaultRoot, backupRoot };
}
const discard = async (root: string) => rm(root, { recursive: true, force: true });
const knownHomePlaceholderContents: Readonly<Record<string, string>> = {
  'Knowledge-Base-Overview.md': '# Knowledge Base Overview\n',
  'Modernization-Roadmap.md': '# Modernization Roadmap\n',
  'Reading-Queue.md': '# Reading Queue\n',
  'Research-Scope.md': '# Research Scope\n',
  'Weekly-Updates.md': '# Weekly Updates\n',
};
async function writeKnownHomePlaceholder(vaultRoot: string): Promise<void> {
  const home = join(vaultRoot, '00-Home');
  await mkdir(home, { recursive: true });
  await Promise.all(Object.entries(knownHomePlaceholderContents).map(([name, content]) => writeFile(join(home, name), content)));
}

test('dry-run is read-only, hashes every exact allowlist candidate, and hides local paths from public output', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, '00-Inbox'));
    const review = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    assert.equal(review.candidates.length, 13);
    assert.ok(review.candidates.every(item => /^[0-9a-f]{64}$/.test(item.sha256)));
    assert.equal(review.candidates.find(item => item.path === '00-Inbox')?.classification, 'empty');
    assert.equal(review.candidates.find(item => item.path === '00-Inbox')?.exists, true);
    assert.ok(review.resolvedCandidates.every(item => item.resolvedTarget.startsWith(f.vaultRoot)));
    const publicPlan = publicVaultCleanupPlan(review);
    assert.equal(JSON.stringify(publicPlan).includes(f.vaultRoot), false);
    await assert.rejects(readFile(f.backupRoot), { code: 'ENOENT' });
  } finally { await discard(f.root); }
});

test('classifies known placeholders, normal manual content, and unexpected hidden content without treating them as cleanup targets', async () => {
  const f = await fixture();
  try {
    await writeKnownHomePlaceholder(f.vaultRoot);
    await mkdir(join(f.vaultRoot, '02-AI-Techniques'), { recursive: true });
    await writeFile(join(f.vaultRoot, '02-AI-Techniques', 'my-note.md'), '# Keep manually\n');
    await mkdir(join(f.vaultRoot, '03-Modernization-Lifecycle'), { recursive: true });
    await writeFile(join(f.vaultRoot, '03-Modernization-Lifecycle', '.unexpected'), 'not safe');
    const review = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    assert.equal(review.candidates.find(item => item.path === '00-Home')?.classification, 'known_placeholder');
    assert.equal(review.candidates.find(item => item.path === '02-AI-Techniques')?.classification, 'manual_content');
    assert.equal(review.candidates.find(item => item.path === '03-Modernization-Lifecycle')?.classification, 'unsafe');
  } finally { await discard(f.root); }
});

test('refuses links/reparse points and never accepts protected paths as candidates', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, '04-Engineering-Methods'), { recursive: true });
    await writeFile(join(f.root, 'outside.md'), 'outside');
    try {
      await symlink(join(f.root, 'outside.md'), join(f.vaultRoot, '04-Engineering-Methods', 'escape.md'));
    } catch (error) {
      // Windows installations without Developer Mode may prohibit test links.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const review = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    const candidate = review.candidates.find(item => item.path === '04-Engineering-Methods');
    assert.equal(candidate?.classification, 'unsafe');
    assert.match(candidate?.reason ?? '', /link or reparse/i);
    assert.equal(review.candidates.some(item => item.path === '.obsidian' as never), false);
    assert.equal(review.candidates.some(item => item.path === '01-Evidence' as never), false);
    assert.equal(review.candidates.some(item => item.path === 'Evidence' as never), false);
  } finally { await discard(f.root); }
});

test('apply requires explicit confirmation and the reviewed plan hash before it creates a recovery snapshot', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, '00-Inbox'));
    const review = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    await assert.rejects(applyVaultCleanup({ vaultRoot: f.vaultRoot, backupRoot: f.backupRoot, planSha256: review.planSha256, confirmed: false }), /CONFIRMATION_REQUIRED/);
    await assert.rejects(applyVaultCleanup({ vaultRoot: f.vaultRoot, backupRoot: f.backupRoot, planSha256: '0'.repeat(64), confirmed: true }), /reviewed plan SHA-256/);
    await assert.rejects(readFile(f.backupRoot), { code: 'ENOENT' });
  } finally { await discard(f.root); }
});

test('apply re-hashes targets, moves only safe legacy content into a verified recovery snapshot, and leaves .obsidian unchanged', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, '00-Inbox'));
    await writeKnownHomePlaceholder(f.vaultRoot);
    await mkdir(join(f.vaultRoot, '02-AI-Techniques'), { recursive: true });
    await writeFile(join(f.vaultRoot, '02-AI-Techniques', 'manual.md'), '# Manual\n');
    const before = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    const result = await applyVaultCleanup({ vaultRoot: f.vaultRoot, backupRoot: f.backupRoot, planSha256: before.planSha256, confirmed: true, operationId: 'test-operation' });
    assert.deepEqual(result.moved.map(item => item.path), ['00-Home', '00-Inbox']);
    assert.ok(result.skipped.some(item => item.path === '02-AI-Techniques' && item.classification === 'manual_content'));
    assert.equal((await readFile(join(f.vaultRoot, '.obsidian', 'app.json'), 'utf8')).includes('unchanged'), true);
    assert.equal(await readFile(join(f.vaultRoot, 'Evidence', 'index.md'), 'utf8'), '# Active Evidence\n');
    assert.equal(await readFile(join(f.vaultRoot, '01-Evidence', 'index.md'), 'utf8'), '# Evidence\n');
    assert.equal((await readFile(join(result.backupRoot, 'recovery-snapshot.json'), 'utf8')).includes(before.planSha256), true);
    assert.equal((await readFile(join(result.backupRoot, 'targets', '00-Home', 'Knowledge-Base-Overview.md'), 'utf8')).startsWith('#'), true);
    assert.equal((await readFile(join(f.vaultRoot, '02-AI-Techniques', 'manual.md'), 'utf8')).includes('Manual'), true);
  } finally { await discard(f.root); }
});

test('an edited known placeholder filename is manual content and is never moved', async () => {
  const f = await fixture();
  try {
    await writeKnownHomePlaceholder(f.vaultRoot);
    const edited = join(f.vaultRoot, '00-Home', 'Reading-Queue.md');
    await writeFile(edited, '# My reading queue\n\nKeep this note.\n');
    const before = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    assert.equal(before.candidates.find(item => item.path === '00-Home')?.classification, 'manual_content');
    const result = await applyVaultCleanup({ vaultRoot: f.vaultRoot, backupRoot: f.backupRoot, planSha256: before.planSha256, confirmed: true, operationId: 'manual-placeholder' });
    assert.equal(result.moved.some(item => item.path === '00-Home'), false);
    assert.equal(await readFile(edited, 'utf8'), '# My reading queue\n\nKeep this note.\n');
  } finally { await discard(f.root); }
});

test('refuses a link or junction in a backup operation ancestor before it can write a recovery snapshot', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, '00-Inbox'));
    await mkdir(f.backupRoot, { recursive: true });
    const outside = join(f.root, 'outside-backup');
    await mkdir(outside);
    try {
      await symlink(outside, join(f.backupRoot, 'vault-cleanup'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const before = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    await assert.rejects(
      applyVaultCleanup({ vaultRoot: f.vaultRoot, backupRoot: f.backupRoot, planSha256: before.planSha256, confirmed: true, operationId: 'linked-operation' }),
      /link or reparse point|resolves through a link or reparse point/i,
    );
    await assert.rejects(readFile(join(outside, 'linked-operation', 'recovery-snapshot.json')), { code: 'ENOENT' });
    assert.equal((await readdir(outside)).length, 0);
  } finally { await discard(f.root); }
});

test('a target changed after dry-run is rejected before a recovery move', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.vaultRoot, '00-Inbox'));
    const before = await createVaultCleanupReview({ vaultRoot: f.vaultRoot });
    await writeFile(join(f.vaultRoot, '00-Inbox', 'added-after-review.md'), 'changed');
    await assert.rejects(applyVaultCleanup({ vaultRoot: f.vaultRoot, backupRoot: f.backupRoot, planSha256: before.planSha256, confirmed: true }), /reviewed plan SHA-256/);
    await assert.rejects(readFile(f.backupRoot), { code: 'ENOENT' });
  } finally { await discard(f.root); }
});

test('CLI route permits only JSON dry-run and requires an explicit --confirm apply gate', async () => {
  const f = await fixture();
  try {
    const config = { vaultRoot: f.vaultRoot, backupRoot: f.backupRoot };
    const dryRun = await routeVaultCleanup(['--dry-run', '--format', 'json'], { config });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(JSON.stringify(dryRun).includes(f.vaultRoot), false);
    await assert.rejects(routeVaultCleanup(['--apply', '--plan-sha256', dryRun.plan.planSha256], { config }), /CONFIRMATION_REQUIRED/);
    await assert.rejects(routeVaultCleanup(['--dry-run'], { config }), /requires --format json/);
  } finally { await discard(f.root); }
});
