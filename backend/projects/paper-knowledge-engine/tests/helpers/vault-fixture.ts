import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { canonicalJson } from '../../src/shared/manifest.ts';
import { ARCHIVE_ARTIFACTS, realTree, verifyArchiveV2 } from '../../src/shared/archive-v2.ts';
import { asLibraryId } from '../../src/shared/identity.ts';

export const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function snapshot(root: string) {
  return Promise.all((await realTree(root)).map(async path => [path, path.endsWith('/') ? null : hash(await readFile(join(root, path)))]));
}
export async function vaultFixture(count = 1, documentMarkdown = '# Parsed text\n![figure](assets/figure.png)\n[PDF](source.pdf)') {
  const root = await mkdtemp(join(tmpdir(), 'vault-rebuild-'));
  const input = { legacyVaultRoot: join(root, 'old'), archiveRoot: join(root, 'archive'),
    vaultRoot: join(root, 'vaults', 'fsd'), libraryId: asLibraryId('fsd'),
    runtimeRoots: { dataRoot: join(root, 'runtime'), workRoot: join(root, 'runtime/work'),
      runsRoot: join(root, 'runtime/runs'), operationsRoot: join(root, 'runtime/operations'), backupRoot: join(root, 'backups') } };
  await mkdir(join(input.legacyVaultRoot, '.obsidian', 'plugins'), { recursive: true });
  await writeFile(join(input.legacyVaultRoot, '.obsidian', 'app.json'), '{"userSetting":true}');
  for (const name of ['欢迎.md', 'index.md', 'log.md', 'README.md', 'my-notes.md']) await writeFile(join(input.legacyVaultRoot, name), '# Keep in old vault\n');
  await mkdir(join(input.archiveRoot), { recursive: true });
  const sources = [];
  for (let n = 1; n <= count; n++) {
    const baseId = `2601.0000${n}`, packageRoot = join(input.archiveRoot, `${baseId}-v1`);
    const pdf = await PDFDocument.create(); pdf.addPage();
    const source = { title: `Paper ${n}`, authors: ['Ada Author'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'],
      arxivId: `${baseId}v1`, published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z', parseAttemptId: `parse-${n}`, pageCount: 1 };
    const payloads = new Map<string, Uint8Array>([
      ['source.pdf', await pdf.save()], ['source.json', Buffer.from(canonicalJson(source))],
      ['document.md', Buffer.from(documentMarkdown)],
      ['pages.json', Buffer.from(canonicalJson([{ page: 1, text: 'Page text' }]))],
      ['content-list.json', Buffer.from(canonicalJson([{ type: 'image', img_path: 'assets/figure.png' }]))],
      ['assets/figure.png', Buffer.from([137, 80, 78, 71, n])],
    ]);
    for (const [path, bytes] of payloads) { await mkdir(dirname(join(packageRoot, path)), { recursive: true }); await writeFile(join(packageRoot, path), bytes); }
    await writeFile(join(packageRoot, 'manifest.json'), canonicalJson({ schemaVersion: 2, libraryId: 'fsd', sourceKind: 'arxiv', baseId, version: 1,
      pdfSha256: hash(payloads.get('source.pdf')!), parser: { name: 'MinerU', version: '3.4.5', model: 'pipeline', method: 'auto' },
      artifacts: ARCHIVE_ARTIFACTS, files: [...payloads].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) }));
    sources.push(await verifyArchiveV2(packageRoot));
  }
  return { root, input, sources, planFile: join(root, 'plan.json'), close: () => rm(root, { recursive: true, force: true }) };
}
