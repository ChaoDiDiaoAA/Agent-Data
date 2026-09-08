import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rename, symlink, writeFile } from 'node:fs/promises';
import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import type { BufferedEvidenceSource as VerifiedArchiveSource } from '../src/evidence/layout-paths.ts';
import { canonicalJson } from '../src/evidence/contracts.ts';
import * as evidencePublisher from '../src/evidence/publisher.ts';
import { publishEvidence } from '../src/evidence/publisher.ts';
import { readPublicationReceipt } from '../src/evidence/receipt-store.ts';
import { renderPaperEvidenceV3 } from '../src/evidence/render-paper.ts';
import { bootstrapStageOne } from '../src/library/bootstrap.ts';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fixtureRoot = process.env.FSD_TEST_ROOT ?? 'D:/tmp/fsd-evidence-publisher-tests';
const legacyVaultReadme = `# AI 与程序分析辅助遗留软件现代化知识库

本知识库采用自动更新的研究型 LLM Wiki，将 AI、LLM、Agent、RAG、AST 与程序分析论文转化为可追溯的 FSD、TDD、DDD、代码翻写、技术栈迁移和验证方法。所有生成内容保留论文、版本和页码来源。

原始 PDF 位于 \`D:\\paper\\fsd-code2doc\`，机器状态位于 Builder 的 \`state/papers.sqlite\`。
`;
const legacyWikiIndex = `# LLM Wiki 内容索引

本索引由 Builder 根据 Vault 页面生成。每行记录页面链接、类型、状态、一句话简介和来源数量。
`;
const legacyEvidenceIndex = '# FSD Evidence Vault\n\n- [[01-Evidence/index]]\n';

async function workspace(): Promise<{ stateRoot: string; tempRoot: string; vaultRoot: string }> {
  const root = await mkdtemp(join(fixtureRoot, 'evidence-publisher-'));
  const stateRoot = join(root, 'state');
  const tempRoot = join(root, 'temp');
  const vaultRoot = join(root, 'vault');
  await Promise.all([mkdir(stateRoot), mkdir(tempRoot), mkdir(vaultRoot)]);
  return { stateRoot, tempRoot, vaultRoot };
}

function source(input: {
  archiveRoot?: string;
  archiveManifestLabel?: string;
  authors?: string[];
  baseId?: string;
  categories?: string[];
  fullMarkdown?: string;
  matchedTracks?: string[];
  title?: string;
  version?: number;
} = {}): VerifiedArchiveSource {
  const baseId = input.baseId ?? '2601.00001';
  const version = input.version ?? 1;
  const pdfSha256 = sha256('frozen PDF');
  return {
    pdfContents: new TextEncoder().encode('frozen PDF'),
    source: {
      schemaVersion: 1,
      baseId,
      arxivId: `${baseId}v${version}`,
      version,
      title: input.title ?? 'Frozen evidence',
      authors: input.authors ?? ['Ada Archive'],
      categories: input.categories ?? ['cs.SE'],
      matchedTracks: input.matchedTracks ?? ['AI-FSD'],
      published: '2026-01-01T00:00:00Z',
      updated: '2026-01-02T00:00:00Z',
      pdfPath: `pdf/${pdfSha256}.pdf`,
      pdfSha256,
      parseAttemptId: 'attempt-1',
      model: 'pipeline',
      cliBackend: 'pipeline',
      method: 'auto',
      pageCount: 1,
      normalized: {
        fullMarkdown: 'normalized/full.md',
        pageMarkedText: 'normalized/page-marked.txt',
        pages: 'normalized/pages.json',
        contentList: 'normalized/content-list.json',
      },
      files: [],
    },
    archiveRoot: input.archiveRoot ?? 'D:/fixture/archive',
    archiveManifestSha256: sha256(input.archiveManifestLabel ?? 'archive manifest'),
    fullMarkdown: input.fullMarkdown ?? '# Frozen evidence\n',
    pages: [{ page: 1, text: 'First page' }],
    contentList: [],
    assets: [],
  };
}

type EvidencePublicationPlanContract = {
  contentSha256: string;
  publicationId: string;
  publisherVersion: 3;
  runId: string;
};

type EvidencePublisherV3Contract = {
  planEvidencePublication(input: {
    predecessor?: EvidencePublicationPlanContract;
    runId: string;
    sources: readonly VerifiedArchiveSource[];
  }): EvidencePublicationPlanContract | Promise<EvidencePublicationPlanContract>;
  applyEvidencePublication(input: {
    plan: EvidencePublicationPlanContract;
    stateRoot: string;
    tempRoot: string;
    vaultRoot: string;
  }): Promise<{
    receipt: EvidencePublicationPlanContract & {
      publishedAt: string;
      schemaVersion: 1;
      sources: { baseId: string }[];
    };
    status: 'published' | 'replayed';
  }>;
  verifyEvidencePublication(input: {
    plan: EvidencePublicationPlanContract;
    vaultRoot: string;
  }): Promise<void>;
};

const evidencePublisherV3 = evidencePublisher as typeof evidencePublisher & EvidencePublisherV3Contract;

test('active publisher only owns Evidence and leaves every outside path out of conflict detection', async () => {
  const paths = await workspace();
  for (const path of ['README.md', 'index.md', '01-Evidence', 'Evidence-other']) {
    await mkdir(join(paths.vaultRoot, path));
    await writeFile(join(paths.vaultRoot, path, 'manual.md'), 'human content');
  }
  const before = await treeSnapshot(join(paths.vaultRoot, 'README.md'));
  const first = await publishEvidence(input(paths));
  expect(first.receipt.publisherVersion).toBe(3);
  expect(await readdir(join(paths.vaultRoot, 'Evidence', 'indexes'))).toEqual(['authors.md', 'categories.md', 'tracks.md', 'years.md']);
  expect((await publishEvidence(input(paths))).status).toBe('replayed');
  expect(await treeSnapshot(join(paths.vaultRoot, 'README.md'))).toEqual(before);
});

test('v3 stores its manifest in runtime state and detects changed manifest bytes on replay', async () => {
  const paths = await workspace();
  await publishEvidence(input(paths));
  const manifestPath = join(paths.stateRoot, 'runs', 'run-1', 'evidence', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.files.every((file: { path: string }) => file.path.startsWith('Evidence/') && !file.path.endsWith('.json'))).toBe(true);
  expect(manifest.files).toHaveLength(7);
  const before = await treeSnapshot(paths.vaultRoot);
  await writeFile(manifestPath, '{}');
  await expect(publishEvidence(input(paths))).rejects.toThrow('publication manifest differs');
  expect(await treeSnapshot(paths.vaultRoot)).toEqual(before);
  expect(await readFile(manifestPath, 'utf8')).toBe('{}');
});

test('publisher rejects an Evidence case alias before writing publication state', async () => {
  const paths = await workspace();
  await mkdir(join(paths.vaultRoot, 'evidence'));
  const before = await treeSnapshot(paths.vaultRoot);
  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
  expect(await readdir(paths.stateRoot)).toEqual([]);
  expect(await treeSnapshot(paths.vaultRoot)).toEqual(before);
});

test('publisher rejects runtime roots inside the Vault before touching manual state', async () => {
  for (const field of ['stateRoot', 'tempRoot'] as const) {
    const paths = await workspace();
    const manualRoot = join(paths.vaultRoot, 'manual-state');
    await mkdir(manualRoot);
    const before = await treeSnapshot(paths.vaultRoot);
    await expect(publishEvidence({ ...input(paths), [field]: manualRoot })).rejects.toThrow('EVIDENCE_PATH');
    expect(await treeSnapshot(paths.vaultRoot)).toEqual(before);
  }
});

async function versionedPaperBytes(vaultRoot: string, baseId: string, version: number): Promise<Map<string, Uint8Array>> {
  const root = join(vaultRoot, 'Evidence', 'papers', `${baseId}-v${version}`);
  const files = new Map<string, Uint8Array>();
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relativePath);
      else if (entry.isFile()) files.set(relativePath, await readFile(path));
    }
  }
  await visit(root);
  return files;
}

async function treeSnapshot(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const metadata = (kind: string, info: Awaited<ReturnType<typeof lstat>>, detail = '') => [
    kind,
    info.mode,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
    info.birthtimeMs,
    detail,
  ].join(':');
  const rootInfo = await lstat(root);
  const rootKind = rootInfo.isSymbolicLink() ? 'symlink-or-junction'
    : rootInfo.isDirectory() ? 'directory'
      : rootInfo.isFile() ? 'file'
        : 'other';
  const rootDetail = rootInfo.isSymbolicLink() ? await readlink(root)
    : rootInfo.isFile() ? sha256(await readFile(root))
      : '';
  snapshot.set('.', metadata(rootKind, rootInfo, rootDetail));
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return snapshot;

  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        snapshot.set(relativePath, metadata('symlink-or-junction', info, await readlink(path)));
      } else if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, metadata('directory', info));
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        snapshot.set(relativePath, metadata('file', info, sha256(await readFile(path))));
      } else {
        const kind = entry.isBlockDevice() ? 'block-device'
          : entry.isCharacterDevice() ? 'character-device'
            : entry.isFIFO() ? 'fifo'
              : entry.isSocket() ? 'socket'
                : 'other';
        snapshot.set(relativePath, metadata(kind, info));
      }
    }
  }
  await visit(root);
  return snapshot;
}

function publicationTargetPath(vaultRoot: string, relativePath: string): string {
  return join(vaultRoot, ...relativePath.split('/'));
}
function paperText(): string {
  return new TextDecoder().decode(renderPaperEvidenceV3(source()).find(file => file.path.endsWith('/paper.md'))!.bytes);
}
function journalBinding() {
  const { publisherVersion, runId, publicationId, contentSha256 } = evidencePublisher.planEvidencePublication({ runId: 'run-1', sources: [source()] });
  return { publisherVersion, runId, publicationId, contentSha256 };
}

function input(paths: Awaited<ReturnType<typeof workspace>>, runId = 'run-1', sources: readonly VerifiedArchiveSource[] = [source()]) {
  return { ...paths, runId, sources };
}

function cumulativeSources(paths: Awaited<ReturnType<typeof workspace>>): {
  sourceA: VerifiedArchiveSource;
  sourceB: VerifiedArchiveSource;
} {
  return {
    sourceA: source({ archiveRoot: join(paths.tempRoot, 'archive-a'), title: 'Cumulative source A' }),
    sourceB: source({
      archiveRoot: join(paths.tempRoot, 'archive-b'),
      archiveManifestLabel: 'archive manifest B',
      authors: ['Bea Builder'],
      baseId: '2601.00002',
      fullMarkdown: '# Cumulative source B\n',
      title: 'Cumulative source B',
    }),
  };
}

async function interruptApply(
  paths: Awaited<ReturnType<typeof workspace>>,
  plan: EvidencePublicationPlanContract,
): Promise<void> {
  process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL = '1';
  try {
    await expect(evidencePublisherV3.applyEvidencePublication({ ...paths, plan })).rejects.toThrow('EVIDENCE_INTERRUPTED');
  } finally {
    delete process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
  }
}

test('publishes compact papers, aggregate indexes, and a verified receipt', async () => {
  const paths = await workspace();
  const result = await publishEvidence(input(paths));

  expect(result.status).toBe('published');
  expect(result.receipt.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await readFile(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), 'utf8')).toContain('# Frozen evidence\n');
  expect(await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8')).toContain('Frozen evidence');
  await expect(readFile(join(paths.vaultRoot, 'index.md'))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(paths.stateRoot, 'runs', 'run-1', 'evidence', 'publication.json'), 'utf8'))).toEqual(result.receipt);
});

test('replays byte-identical installed content without rewriting it', async () => {
  const paths = await workspace();
  const first = await publishEvidence(input(paths));
  const document = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  const before = await readFile(document);
  const second = await publishEvidence(input(paths));

  expect(second.status).toBe('replayed');
  expect(second.receipt).toEqual(first.receipt);
  expect(await readFile(document)).toEqual(before);
});

test('rejects a changed managed target instead of overwriting it', async () => {
  const paths = await workspace();
  await publishEvidence(input(paths));
  await writeFile(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), 'human edit\n');

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_CONFLICT');
});

test('preserves legacy bootstrap documents outside Evidence', async () => {
  const paths = await workspace();
  await mkdir(join(paths.vaultRoot, '01-Evidence'));
  await writeFile(join(paths.vaultRoot, 'README.md'), legacyVaultReadme);
  await writeFile(join(paths.vaultRoot, 'index.md'), legacyWikiIndex);
  await writeFile(join(paths.vaultRoot, '01-Evidence', 'index.md'), legacyEvidenceIndex);
  expect((await publishEvidence(input(paths))).status).toBe('published');
  expect(await readFile(join(paths.vaultRoot, 'README.md'), 'utf8')).toBe(legacyVaultReadme);
  expect(await readFile(join(paths.vaultRoot, 'index.md'), 'utf8')).toBe(legacyWikiIndex);
  expect(await readFile(join(paths.vaultRoot, '01-Evidence', 'index.md'), 'utf8')).toBe(legacyEvidenceIndex);
});

test('publishes into a freshly bootstrapped Vault without treating the empty indexes as edits', async () => {
  const paths = await workspace();
  await bootstrapStageOne({ root: process.cwd(), pdfRoot: join(paths.tempRoot, 'pdf'), vaultRoot: paths.vaultRoot });

  const result = await publishEvidence(input(paths));

  expect(result.status).toBe('published');
  expect(await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8')).toContain('Ada Archive');
});

test('manual changes outside Evidence do not conflict with publication', async () => {
  const paths = await workspace();
  await writeFile(join(paths.vaultRoot, 'README.md'), '人工备注');
  expect((await publishEvidence(input(paths))).status).toBe('published');
  expect(await readFile(join(paths.vaultRoot, 'README.md'), 'utf8')).toBe('人工备注');
});

test('rejects an unknown manual file under a managed target', async () => {
  const paths = await workspace();
  await publishEvidence(input(paths));
  await writeFile(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'manual.md'), 'do not overwrite\n');

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_CONFLICT');
});

test('applies cumulative A+B over predecessor A without changing A bytes and rebuilds cumulative indexes', async () => {
  const paths = await workspace();
  const { sourceA, sourceB } = cumulativeSources(paths);
  const planA = await evidencePublisherV3.planEvidencePublication({ runId: 'run-a', sources: [sourceA] });
  await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: planA });
  const sourceABefore = await versionedPaperBytes(paths.vaultRoot, '2601.00001', 1);
  const sourceATreeBefore = await treeSnapshot(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1'));

  const planAB = await evidencePublisherV3.planEvidencePublication({
    runId: 'run-b',
    sources: [sourceA, sourceB],
    predecessor: planA,
  });
  const result = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: planAB });

  expect(result.receipt.sources.map(item => item.baseId)).toEqual(['2601.00001', '2601.00002']);
  expect(await versionedPaperBytes(paths.vaultRoot, '2601.00001', 1)).toEqual(sourceABefore);
  expect(await treeSnapshot(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1'))).toEqual(sourceATreeBefore);
  const rootIndex = await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8');
  expect(rootIndex).toContain('Ada Archive');
  expect(rootIndex).toContain('Bea Builder');
  const authorA = await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8');
  const authorB = await readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'), 'utf8');
  expect(authorA).toContain('Cumulative source A');
  expect(authorB).toContain('Cumulative source B');
  for (const indexPath of [
    join(paths.vaultRoot, 'Evidence', 'indexes', 'categories.md'),
    join(paths.vaultRoot, 'Evidence', 'indexes', 'tracks.md'),
  ]) {
    const cumulativeIndex = await readFile(indexPath, 'utf8');
    expect(cumulativeIndex).toContain('Cumulative source A');
    expect(cumulativeIndex).toContain('Cumulative source B');
  }
});

test('cumulative apply rejects and preserves an unknown manual file under managed Evidence', async () => {
  const paths = await workspace();
  const { sourceA, sourceB } = cumulativeSources(paths);
  const planA = await evidencePublisherV3.planEvidencePublication({ runId: 'run-a', sources: [sourceA] });
  await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: planA });
  const manualPath = join(paths.vaultRoot, 'Evidence', 'manual.md');
  await writeFile(manualPath, 'human-owned evidence note\n');
  const planAB = await evidencePublisherV3.planEvidencePublication({
    runId: 'run-b',
    sources: [sourceA, sourceB],
    predecessor: planA,
  });
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  let conflict: unknown;
  try {
    await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: planAB });
  } catch (error) {
    conflict = error;
  }
  expect(conflict).toBeInstanceOf(Error);
  if (!(conflict instanceof Error)) throw new TypeError('cumulative apply must reject with an Error');
  expect(conflict.message).toBe('EVIDENCE_CONFLICT: unknown manual file manual.md');
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
});

test('cumulative apply rejects one partially installed current target without additional writes', async () => {
  const paths = await workspace();
  const { sourceA, sourceB } = cumulativeSources(paths);
  const predecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-a', sources: [sourceA] });
  await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: predecessor });
  const current = evidencePublisherV3.planEvidencePublication({
    runId: 'run-b',
    sources: [sourceA, sourceB],
    predecessor,
  });
  const partiallyInstalled = join(
    paths.vaultRoot,
    'Evidence',
    'papers',
    `${sourceB.source.baseId}-v${sourceB.source.version}`,
    'paper.md',
  );
  await mkdir(dirname(partiallyInstalled), { recursive: true });
  await writeFile(partiallyInstalled, sourceB.fullMarkdown);
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  await expect(evidencePublisherV3.applyEvidencePublication({ ...paths, plan: current })).rejects.toThrow(
    'EVIDENCE_CONFLICT: current publication is partially installed',
  );
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
});

test('publisher v3 gives identical cumulative content different publication IDs for different run IDs', async () => {
  const paths = await workspace();
  const sources = [source({ archiveRoot: join(paths.tempRoot, 'archive'), title: 'Stable cumulative content' })];
  const runOne = await evidencePublisherV3.planEvidencePublication({ runId: 'run-one', sources });
  const runOneReplay = await evidencePublisherV3.planEvidencePublication({ runId: 'run-one', sources });
  const runTwo = await evidencePublisherV3.planEvidencePublication({ runId: 'run-two', sources });
  const expectedId = (runId: string, contentSha256: string) => `evidence-${sha256(
    `{"contentSha256":${JSON.stringify(contentSha256)},"publisherVersion":3,"runId":${JSON.stringify(runId)}}\n`,
  ).slice(0, 32)}`;

  expect(runOne.publisherVersion).toBe(3);
  expect(runTwo.publisherVersion).toBe(3);
  expect(runOneReplay.contentSha256).toBe(runOne.contentSha256);
  expect(runOneReplay.publicationId).toBe(runOne.publicationId);
  expect(runOne.contentSha256).toBe(runTwo.contentSha256);
  expect(runOne.publicationId).toBe(expectedId('run-one', runOne.contentSha256));
  expect(runTwo.publicationId).toBe(expectedId('run-two', runTwo.contentSha256));
  expect(runOne.publicationId).not.toBe(runTwo.publicationId);
});

test('publisher v3 rejects an unsafe run ID synchronously', () => {
  expect(() => evidencePublisherV3.planEvidencePublication({ runId: '../unsafe', sources: [source()] })).toThrow(
    'EVIDENCE_PATH: runId is unsafe',
  );
});

test('publisher v3 rejects removing a predecessor source', () => {
  const predecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-a', sources: [source()] });

  expect(() => evidencePublisherV3.planEvidencePublication({ runId: 'run-b', sources: [], predecessor })).toThrow(
    'EVIDENCE_CONFLICT',
  );
});

test('publisher v3 rejects changing a predecessor source Archive identity', () => {
  const predecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-a', sources: [source()] });
  const changed = source({ archiveManifestLabel: 'changed archive manifest' });

  expect(() => evidencePublisherV3.planEvidencePublication({ runId: 'run-b', sources: [changed], predecessor })).toThrow(
    'EVIDENCE_CONFLICT',
  );
});

test('publisher v3 replays the same plan with its immutable receipt', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-replay', sources: [source()] });
  const first = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan });
  const second = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan });

  expect(first.status).toBe('published');
  expect(second.status).toBe('replayed');
  expect(second.receipt).toEqual(first.receipt);
});

test('publisher v3 read-only verifier rejects changed and unknown managed files without writes', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-verify-current', sources: [source()] });
  await evidencePublisherV3.applyEvidencePublication({ ...paths, plan });
  const documentPath = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  const expectedDocument = await readFile(documentPath);

  await writeFile(documentPath, '# stale evidence\n');
  const changedBefore = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);
  await expect(evidencePublisherV3.verifyEvidencePublication({ plan, vaultRoot: paths.vaultRoot })).rejects.toThrow(
    'EVIDENCE_CONFLICT',
  );
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(changedBefore);

  await writeFile(documentPath, expectedDocument);
  await writeFile(join(paths.vaultRoot, 'Evidence', 'manual.md'), 'unknown manual file\n');
  const unknownBefore = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);
  await expect(evidencePublisherV3.verifyEvidencePublication({ plan, vaultRoot: paths.vaultRoot })).rejects.toThrow(
    'EVIDENCE_CONFLICT: unknown manual file manual.md',
  );
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(unknownBefore);
});

test('publisher v3 recovers an interrupted journal before retrying', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-interrupted', sources: [source()] });
  await interruptApply(paths, plan);

  const retry = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan });

  expect(retry.status).toBe('published');
  expect(await readFile(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), 'utf8')).toContain(
    '# Frozen evidence\n',
  );
});

test('publisher v3 accepts a temporary journal that is a strict action-prefix extension', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-dual-journal-extension', sources: [source()] });
  await interruptApply(paths, plan);
  const journalPath = join(paths.stateRoot, 'runs', plan.runId, 'evidence', 'publication-journal.json');
  const temporaryPath = `${journalPath}.new`;
  const durable = JSON.parse(await readFile(journalPath, 'utf8')) as {
    actions: Array<Record<string, unknown>>;
  };
  const rendered = renderPaperEvidenceV3(source());
  const existingTargets = new Set(durable.actions.map(action => action.target));
  const extension = rendered.find(file => !existingTargets.has(file.path));
  if (!extension) throw new Error('fixture needs an unjournaled rendered target');
  durable.actions.push({
    target: extension.path,
    expectedSha256: extension.sha256,
    backup: null,
    backupSha256: null,
    replacementStarted: false,
    installed: false,
  });
  await writeFile(temporaryPath, canonicalJson(durable));

  const result = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan });

  expect(result.status).toBe('published');
  await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), 'utf8')).toContain(
    '# Frozen evidence\n',
  );
});

test('publisher v3 rejects divergent durable and temporary journal snapshots without mutation', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-dual-journal-divergence', sources: [source()] });
  await interruptApply(paths, plan);
  const journalPath = join(paths.stateRoot, 'runs', plan.runId, 'evidence', 'publication-journal.json');
  const temporaryPath = `${journalPath}.new`;
  const durable = JSON.parse(await readFile(journalPath, 'utf8')) as {
    actions: Array<Record<string, unknown>>;
  };
  if (!durable.actions.length) throw new Error('fixture needs an installed action');
  const divergent = structuredClone(durable);
  divergent.actions[0]!.installed = !Boolean(divergent.actions[0]!.installed);
  await writeFile(temporaryPath, canonicalJson(divergent));
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  await expect(evidencePublisherV3.applyEvidencePublication({ ...paths, plan })).rejects.toThrow('EVIDENCE_CONFLICT');
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toEqual(durable);
  expect(JSON.parse(await readFile(temporaryPath, 'utf8'))).toEqual(divergent);
});

test('publisher v3 serializes concurrent direct callers into one publish and one replay', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-concurrent', sources: [source()] });
  const results = await Promise.all([
    evidencePublisherV3.applyEvidencePublication({ ...paths, plan }),
    evidencePublisherV3.applyEvidencePublication({ ...paths, plan }),
  ]);

  expect(results.map(result => result.status).sort()).toEqual(['published', 'replayed']);
  expect(results[0]!.receipt).toEqual(results[1]!.receipt);
});

test('publisher v3 checks unknown managed paths before recovering a pending journal', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-unknown-before-recovery', sources: [source()] });
  await interruptApply(paths, plan);
  await writeFile(join(paths.vaultRoot, 'Evidence', 'manual.md'), 'human-owned evidence note\n');
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  let conflict: unknown;
  try {
    await evidencePublisherV3.applyEvidencePublication({ ...paths, plan });
  } catch (error) {
    conflict = error;
  }
  expect(conflict).toBeInstanceOf(Error);
  if (!(conflict instanceof Error)) throw new TypeError('pending-journal apply must reject with an Error');
  expect(conflict.message).toBe('EVIDENCE_CONFLICT: unknown manual file manual.md');
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
});

test('publisher v3 rejects a linked journal temporary even when the main journal exists', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-linked-journal-temporary', sources: [source()] });
  await interruptApply(paths, plan);
  const journalPath = join(paths.stateRoot, 'runs', plan.runId, 'evidence', 'publication-journal.json');
  const outside = join(paths.tempRoot, 'outside-linked-journal-temporary');
  await mkdir(outside);
  await symlink(outside, `${journalPath}.new`, 'junction');
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  await expect(evidencePublisherV3.applyEvidencePublication({ ...paths, plan })).rejects.toThrow('EVIDENCE_PATH');
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
});

test('publisher v3 rejects a legacy v1 journal before mutation', async () => {
  const paths = await workspace();
  const plan = evidencePublisherV3.planEvidencePublication({ runId: 'run-v2-reject-v1-journal', sources: [source()] });
  const evidenceState = join(paths.stateRoot, 'runs', plan.runId, 'evidence');
  await mkdir(evidenceState, { recursive: true });
  await writeFile(join(evidenceState, 'publication-journal.json'), canonicalJson({ schemaVersion: 1, actions: [] }));
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  await expect(evidencePublisherV3.applyEvidencePublication({ ...paths, plan })).rejects.toThrow('EVIDENCE_CONFLICT');
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
});

test('publisher v3 rejects every mismatched journal binding before mutation', async () => {
  const cases = [
    ['runId', 'other-run'],
    ['publicationId', 'evidence-00000000000000000000000000000000'],
    ['contentSha256', '0'.repeat(64)],
    ['publisherVersion', 4],
  ] as const;
  for (const [field, value] of cases) {
    const paths = await workspace();
    const plan = evidencePublisherV3.planEvidencePublication({ runId: `run-v2-binding-${field}`, sources: [source()] });
    const evidenceState = join(paths.stateRoot, 'runs', plan.runId, 'evidence');
    await mkdir(evidenceState, { recursive: true });
    await writeFile(join(evidenceState, 'publication-journal.json'), canonicalJson({
      schemaVersion: 1,
      publisherVersion: 3,
      runId: plan.runId,
      publicationId: plan.publicationId,
      contentSha256: plan.contentSha256,
      actions: [],
      [field]: value,
    }));
    const before = await Promise.all([
      treeSnapshot(paths.vaultRoot),
      treeSnapshot(paths.stateRoot),
      treeSnapshot(paths.tempRoot),
    ]);

    await expect(evidencePublisherV3.applyEvidencePublication({ ...paths, plan })).rejects.toThrow('EVIDENCE_CONFLICT');
    expect(await Promise.all([
      treeSnapshot(paths.vaultRoot),
      treeSnapshot(paths.stateRoot),
      treeSnapshot(paths.tempRoot),
    ])).toEqual(before);
  }
});

test('publisher v3 deterministically replans and recovers an interrupted cumulative publication', async () => {
  const paths = await workspace();
  const { sourceA, sourceB } = cumulativeSources(paths);
  {
    const predecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-replan-a', sources: [sourceA] });
    await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: predecessor });
    const current = evidencePublisherV3.planEvidencePublication({
      runId: 'run-replan-ab',
      sources: [sourceA, sourceB],
      predecessor,
    });
    await interruptApply(paths, current);
    const journal = JSON.parse(await readFile(
      join(paths.stateRoot, 'runs', current.runId, 'evidence', 'publication-journal.json'),
      'utf8',
    ));
    expect(journal).toMatchObject({
      schemaVersion: 1,
      publisherVersion: 3,
      runId: current.runId,
      publicationId: current.publicationId,
      contentSha256: current.contentSha256,
    });
  }

  const freshPredecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-replan-a', sources: [sourceA] });
  const freshCurrent = evidencePublisherV3.planEvidencePublication({
    runId: 'run-replan-ab',
    sources: [sourceA, sourceB],
    predecessor: freshPredecessor,
  });
  const recovered = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: freshCurrent });
  const replayed = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: freshCurrent });

  expect(recovered.status).toBe('published');
  expect(replayed.status).toBe('replayed');
  expect(replayed.receipt).toEqual(recovered.receipt);
});

test('publisher v3 fresh replan recovers a validated action target temporary', async () => {
  const paths = await workspace();
  const stableSource = source();
  let temporaryPath = '';
  {
    const interrupted = evidencePublisherV3.planEvidencePublication({
      runId: 'run-replan-target-temporary',
      sources: [stableSource],
    });
    await interruptApply(paths, interrupted);
    const journal = JSON.parse(await readFile(
      join(paths.stateRoot, 'runs', interrupted.runId, 'evidence', 'publication-journal.json'),
      'utf8',
    ));
    const target = publicationTargetPath(paths.vaultRoot, journal.actions[0].target);
    temporaryPath = `${target}.new`;
    await writeFile(temporaryPath, await readFile(target));
  }

  const fresh = evidencePublisherV3.planEvidencePublication({
    runId: 'run-replan-target-temporary',
    sources: [stableSource],
  });
  const recovered = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: fresh });

  expect(recovered.status).toBe('published');
  await expect(readFile(temporaryPath)).rejects.toThrow();
});

test('publisher v3 fresh replan recovers a validated action recovery temporary', async () => {
  const paths = await workspace();
  const { sourceA, sourceB } = cumulativeSources(paths);
  let recoveryPath = '';
  {
    const predecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-replan-recovery-a', sources: [sourceA] });
    await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: predecessor });
    const interrupted = evidencePublisherV3.planEvidencePublication({
      runId: 'run-replan-recovery-ab',
      sources: [sourceA, sourceB],
      predecessor,
    });
    await interruptApply(paths, interrupted);
    const evidenceState = join(paths.stateRoot, 'runs', interrupted.runId, 'evidence');
    const journal = JSON.parse(await readFile(join(evidenceState, 'publication-journal.json'), 'utf8'));
    const action = journal.actions[0];
    const target = publicationTargetPath(paths.vaultRoot, action.target);
    const backup = join(evidenceState, 'backups', ...action.backup.split('/'));
    recoveryPath = `${target}.recovery`;
    await writeFile(recoveryPath, await readFile(backup));
  }

  const freshPredecessor = evidencePublisherV3.planEvidencePublication({ runId: 'run-replan-recovery-a', sources: [sourceA] });
  const freshCurrent = evidencePublisherV3.planEvidencePublication({
    runId: 'run-replan-recovery-ab',
    sources: [sourceA, sourceB],
    predecessor: freshPredecessor,
  });
  const recovered = await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: freshCurrent });

  expect(recovered.status).toBe('published');
  await expect(readFile(recoveryPath)).rejects.toThrow();
});

test('publisher v3 keeps an unbound manual suffix lookalike unknown with zero writes', async () => {
  const paths = await workspace();
  const stableSource = source();
  {
    const interrupted = evidencePublisherV3.planEvidencePublication({
      runId: 'run-v2-manual-suffix-lookalike',
      sources: [stableSource],
    });
    await interruptApply(paths, interrupted);
  }
  await writeFile(join(paths.vaultRoot, 'Evidence', 'manual.new'), 'human-owned lookalike\n');
  const fresh = evidencePublisherV3.planEvidencePublication({
    runId: 'run-v2-manual-suffix-lookalike',
    sources: [stableSource],
  });
  const before = await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ]);

  let conflict: unknown;
  try {
    await evidencePublisherV3.applyEvidencePublication({ ...paths, plan: fresh });
  } catch (error) {
    conflict = error;
  }
  expect(conflict).toBeInstanceOf(Error);
  if (!(conflict instanceof Error)) throw new TypeError('manual suffix lookalike must reject with an Error');
  expect(conflict.message).toBe('EVIDENCE_CONFLICT: unknown manual file manual.new');
  expect(await Promise.all([
    treeSnapshot(paths.vaultRoot),
    treeSnapshot(paths.stateRoot),
    treeSnapshot(paths.tempRoot),
  ])).toEqual(before);
});

test('reads an existing publisherVersion 1 receipt with a v3 active publisher', async () => {
  const paths = await workspace();
  const receiptPath = join(paths.stateRoot, 'publisher-v1-publication.json');
  const receipt = {
    schemaVersion: 1 as const,
    publicationId: 'evidence-11111111111111111111111111111111',
    runId: 'legacy-run',
    publishedAt: '2026-09-01T00:00:00.000Z',
    publisherVersion: 1 as const,
    contentSha256: '2'.repeat(64),
    sources: [{
      baseId: '2601.00001',
      version: 1,
      archiveManifestSha256: '3'.repeat(64),
      evidenceManifestSha256: '4'.repeat(64),
    }],
  };
  await writeFile(receiptPath, JSON.stringify(receipt));

  expect(await readPublicationReceipt(receiptPath)).toEqual(receipt);
});

test('rejects a receipt with an unknown publisher version', async () => {
  const paths = await workspace();
  const receiptPath = join(paths.stateRoot, 'unknown-publication.json');
  await writeFile(receiptPath, JSON.stringify({
    schemaVersion: 1,
    publicationId: 'evidence-11111111111111111111111111111111',
    runId: 'unknown-run',
    publishedAt: '2026-09-01T00:00:00.000Z',
    publisherVersion: 99,
    contentSha256: '2'.repeat(64),
    sources: [],
  }));

  await expect(readPublicationReceipt(receiptPath)).rejects.toThrow('EVIDENCE_RECEIPT_CONFLICT');
});

test('does not read or modify .obsidian content', async () => {
  const paths = await workspace();
  const obsidian = join(paths.vaultRoot, '.obsidian');
  await mkdir(obsidian);
  await writeFile(join(obsidian, 'workspace.json'), '{"manual":true}\n');
  const before = await readFile(join(obsidian, 'workspace.json'));

  await publishEvidence(input(paths));

  expect(await readFile(join(obsidian, 'workspace.json'))).toEqual(before);
  await expect(publishEvidence({ ...input(paths), vaultRoot: obsidian, runId: 'obsidian-root' })).rejects.toThrow('EVIDENCE_PATH');
});

test('rejects a symlink or junction in a publication path', async () => {
  const paths = await workspace();
  const outside = join(paths.vaultRoot, 'outside');
  await mkdir(outside);
  await symlink(outside, join(paths.vaultRoot, 'Evidence'), 'junction');

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
});

test('leaves the vault untouched when staging cannot be created', async () => {
  const paths = await workspace();
  const blockedTempRoot = join(paths.tempRoot, 'not-a-directory');
  await writeFile(blockedTempRoot, 'file');

  await expect(publishEvidence({ ...input(paths), tempRoot: blockedTempRoot })).rejects.toThrow();
  await expect(readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'))).rejects.toThrow();
});

test('recovers an interrupted install before retrying without duplicate files', async () => {
  const paths = await workspace();
  process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL = '1';
  try {
    await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_INTERRUPTED');
  } finally {
    delete process.env.FSD_EVIDENCE_TEST_INTERRUPT_AFTER_INSTALL;
  }

  const replay = await publishEvidence(input(paths));
  expect(replay.status).toBe('published');
  expect(await readFile(join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), 'utf8')).toContain('# Frozen evidence\n');
});

test('rejects a different receipt even when installed bytes still match', async () => {
  const paths = await workspace();
  await publishEvidence(input(paths));
  const receiptPath = join(paths.stateRoot, 'runs', 'run-1', 'evidence', 'publication.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  receipt.publicationId = 'tampered';
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_RECEIPT_CONFLICT');
});

test('requires an existing matching receipt to validate installed files before replaying', async () => {
  const paths = await workspace();
  await publishEvidence(input(paths));
  const replacementVault = join(dirname(paths.vaultRoot), 'replacement-vault');
  await mkdir(replacementVault);

  await expect(publishEvidence({ ...input(paths), vaultRoot: replacementVault })).rejects.toThrow('EVIDENCE_RECEIPT_CONFLICT');
});

test('rejects a journal backup path that escapes the run evidence directory', async () => {
  const paths = await workspace();
  const evidenceState = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  await mkdir(evidenceState, { recursive: true });
  await writeFile(join(evidenceState, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: '../../outside', backupSha256: sha256('unused'),
      expectedSha256: sha256(paperText()), replacementStarted: true, installed: true,
    }],
  }));

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
});

test('rejects a linked evidence-publications ancestor before staging creates outside files', async () => {
  const paths = await workspace();
  const outside = join(paths.tempRoot, 'outside');
  await mkdir(outside);
  await symlink(outside, join(paths.tempRoot, 'evidence-publications'), 'junction');

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
  expect(await readdir(outside)).toEqual([]);
});

test('rejects linked state runs, evidence, and backups ancestors before publishing', async () => {
  for (const segment of ['runs', 'evidence', 'backups'] as const) {
    const paths = await workspace();
    const outside = join(paths.tempRoot, `outside-${segment}`);
    await mkdir(outside);
    if (segment === 'runs') {
      await symlink(outside, join(paths.stateRoot, 'runs'), 'junction');
    } else if (segment === 'evidence') {
      await mkdir(join(paths.stateRoot, 'runs', 'run-1'), { recursive: true });
      await symlink(outside, join(paths.stateRoot, 'runs', 'run-1', 'evidence'), 'junction');
    } else {
      await mkdir(join(paths.stateRoot, 'runs', 'run-1', 'evidence'), { recursive: true });
      await symlink(outside, join(paths.stateRoot, 'runs', 'run-1', 'evidence', 'backups'), 'junction');
    }

    await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
    expect(await readdir(outside)).toEqual([]);
  }
});

test('rejects a linked receipt before it can redirect a publication write', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const outside = join(paths.tempRoot, 'outside-receipt');
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'publication.json'), 'outside receipt\n');
  await symlink(outside, join(evidence, 'publication.json'), 'junction');

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
  expect(await readFile(join(outside, 'publication.json'), 'utf8')).toBe('outside receipt\n');
  await expect(readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'))).rejects.toThrow();
});

test('rejects a linked journal temporary before a durable journal write', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const outside = join(paths.tempRoot, 'outside-journal');
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(evidence, 'publication-journal.json.new'), 'junction');

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
  expect(await readdir(outside)).toEqual([]);
  await expect(readFile(join(paths.vaultRoot, 'Evidence', 'indexes', 'authors.md'))).rejects.toThrow();
});

test('recovers a replacement-started journal action even when installed is still false', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, paperText());
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: null, backupSha256: null,
      expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  const result = await publishEvidence(input(paths));
  expect(result.status).toBe('published');
  expect(await readFile(target, 'utf8')).toContain(paperText());
});

test('removes a validated target temporary left before rename and retries cleanly', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await writeFile(`${target}.new`, paperText());
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: null, backupSha256: null,
      expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  expect((await publishEvidence(input(paths))).status).toBe('published');
  await expect(readFile(`${target}.new`)).rejects.toThrow();
});

test('finalizes a validated journal temporary left before rename', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await writeFile(join(evidence, 'publication-journal.json.new'), canonicalJson({ schemaVersion: 1, ...journalBinding(), actions: [] }));

  expect((await publishEvidence(input(paths))).status).toBe('published');
  await expect(readFile(join(evidence, 'publication-journal.json.new'))).rejects.toThrow();
});

test('finalizes a validated receipt temporary after Evidence was fully installed', async () => {
  const paths = await workspace();
  const initial = await publishEvidence(input(paths));
  const receipt = join(paths.stateRoot, 'runs', 'run-1', 'evidence', 'publication.json');
  await rename(receipt, `${receipt}.new`);

  const replay = await publishEvidence(input(paths));
  expect(replay.status).toBe('replayed');
  expect(replay.receipt).toEqual(initial.receipt);
  await expect(readFile(`${receipt}.new`)).rejects.toThrow();
});

test('rejects an unexpected target temporary instead of deleting it', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await writeFile(`${target}.new`, 'not publisher bytes\n');
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: null, backupSha256: null,
      expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_CONFLICT');
  expect(await readFile(`${target}.new`, 'utf8')).toBe('not publisher bytes\n');
});

test('keeps an unexpected target when a null-backup journal action requests rollback', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(join(evidence, 'backups'), { recursive: true });
  await writeFile(target, 'manual bytes must survive\n');
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: null, backupSha256: null,
      expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_CONFLICT');
  expect(await readFile(target, 'utf8')).toBe('manual bytes must survive\n');
});

test('finalizes a validated recovery temporary without overwriting unexpected target bytes', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  const backup = 'old publisher bytes\n';
  await mkdir(dirname(target), { recursive: true });
  await mkdir(join(evidence, 'backups', 'Evidence', 'papers', '2601.00001-v1'), { recursive: true });
  await writeFile(target, paperText());
  await writeFile(join(evidence, 'backups', 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), backup);
  await writeFile(`${target}.recovery`, backup);
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: 'Evidence/papers/2601.00001-v1/paper.md',
      backupSha256: sha256(backup), expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_CONFLICT');
  expect(await readFile(target, 'utf8')).toBe(backup);
  await expect(readFile(`${target}.recovery`)).rejects.toThrow();
});

test('rejects an unexpected recovery temporary without deleting it', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  const backup = 'old publisher bytes\n';
  await mkdir(dirname(target), { recursive: true });
  await mkdir(join(evidence, 'backups', 'Evidence', 'papers', '2601.00001-v1'), { recursive: true });
  await writeFile(target, paperText());
  await writeFile(join(evidence, 'backups', 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), backup);
  await writeFile(`${target}.recovery`, 'manual recovery bytes\n');
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: 'Evidence/papers/2601.00001-v1/paper.md',
      backupSha256: sha256(backup), expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_CONFLICT');
  expect(await readFile(`${target}.recovery`, 'utf8')).toBe('manual recovery bytes\n');
});

test('rejects a linked recovery temporary without following it', async () => {
  const paths = await workspace();
  const evidence = join(paths.stateRoot, 'runs', 'run-1', 'evidence');
  const target = join(paths.vaultRoot, 'Evidence', 'papers', '2601.00001-v1', 'paper.md');
  const backup = 'old publisher bytes\n';
  const outside = join(paths.tempRoot, 'outside-recovery');
  await mkdir(dirname(target), { recursive: true });
  await mkdir(join(evidence, 'backups', 'Evidence', 'papers', '2601.00001-v1'), { recursive: true });
  await mkdir(outside);
  await writeFile(target, paperText());
  await writeFile(join(evidence, 'backups', 'Evidence', 'papers', '2601.00001-v1', 'paper.md'), backup);
  await symlink(outside, `${target}.recovery`, 'junction');
  await writeFile(join(evidence, 'publication-journal.json'), canonicalJson({
    schemaVersion: 1, ...journalBinding(),
    actions: [{
      target: 'Evidence/papers/2601.00001-v1/paper.md', backup: 'Evidence/papers/2601.00001-v1/paper.md',
      backupSha256: sha256(backup), expectedSha256: sha256(paperText()), replacementStarted: true, installed: false,
    }],
  }));

  await expect(publishEvidence(input(paths))).rejects.toThrow('EVIDENCE_PATH');
  expect(await readdir(outside)).toEqual([]);
});
