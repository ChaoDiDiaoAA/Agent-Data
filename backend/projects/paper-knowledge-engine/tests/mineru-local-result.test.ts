import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { assertStableMinerUOutputTree, collectMinerUFiles, normalizeLocalMinerUResult } from '../src/mineru/mineru-local-result.ts';
import { assessExtraction } from '../src/mineru/mineru-quality.ts';
import { createParseWorkspace, publishParseWorkspace } from '../src/mineru/mineru-workspace.ts';
import { verifyArchiveV2 } from '../src/shared/archive-v2.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { buildLocalParseJob, runLocalParse } from '../src/mineru/mineru-local-jobs.ts';
import { archiveContext, archiveTestPdf } from './fixtures/library-paths.ts';
import { toMinerULocalConfig } from '../src/mineru/mineru-local-config.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';

const roots: string[] = [];
const links: string[] = [];
const fixtureRoot = async (name: string) => { const root = await mkdtemp(join(tmpdir(), `mineru-${name}-`)); roots.push(root); return root; };
after(async () => {
  // Only unlink junctions this fixture created; never recursively follow them.
  for (const path of links) { assert.ok((await lstat(path)).isSymbolicLink()); await rm(path); }
  for (const root of roots) await removeOwnedTestDirectory(root);
});

test('normalizes table image references in page text with the same asset mapping', async () => {
  const root = await fixtureRoot('table-page-assets');
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'images/table.jpg'), 'table-image');
  await writeFile(join(root, 'paper.md'), '# Paper');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([{ type: 'table', page_idx: 0, table_body: '<img src="images/table.jpg">' }]));
  await normalizeLocalMinerUResult({ outputDir: root, model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 });
  const pages = JSON.parse(await readFile(join(root, 'normalized/pages.json'), 'utf8'));
  assert.ok(pages[0].text.includes('assets/images/table.jpg'));
  assert.ok(!(await readFile(join(root, 'normalized/page-marked.txt'), 'utf8')).includes('src="images/'));
});

test('normalizes MinerU split external image URLs without inventing Archive resources', async () => {
  const root = await fixtureRoot('split-external-image');
  const prose = '![Services Hexagon](https://example.com/\nservices-hexagon.png)';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
  assert.equal(await Bun.file(join(root, 'assets', 'services-hexagon.png')).exists(), false);
});

test('normalizes citation architecture prose without inventing Archive resources', async () => {
  const root = await fixtureRoot('citation-architecture-prose');
  const prose = 'Autoformer [40] and PatchTST [41](Transformer-based), TimesNet [42](temporal CNN), DLinear [43](linear), and TimeMixer [44](token-mixing).';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
  assert.equal(await Bun.file(join(root, 'assets', 'Transformer-based')).exists(), false);
});

test('normalizes quoted OCR image examples without inventing Archive resources', async () => {
  const root = await fixtureRoot('ocr-image-examples');
  const prose = '## Adobe Text Extract\n![Figure](fileoutpart42.png)\n## Ministral 3B\n![Ringlock Scaffold](placeholder)';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
  assert.equal(await Bun.file(join(root, 'assets', 'fileoutpart42.png')).exists(), false);
  assert.equal(await Bun.file(join(root, 'assets', 'placeholder')).exists(), false);
});

test('normalizes bold entity-id examples without inventing Archive resources', async () => {
  const root = await fixtureRoot('entity-id-examples');
  const prose = [
    'Attractions: poi (id: poiId, name: poiName); hotels use hotel (id: hotelId, name: hotelName).',
    'Use the format **[PoiName](poiId)** or **[HotelName](hotelId)** when describing reference data.',
    'The JSON example is **[Beijing Zoo](0001)** and **[Beijing Tiantan Manssion Hotel](0002)**.',
  ].join('\n');
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ outputDir: root, model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
  assert.equal(await Bun.file(join(root, 'assets', '0001')).exists(), false);
  assert.equal(await Bun.file(join(root, 'assets', '0002')).exists(), false);
  assert.equal(await Bun.file(join(root, 'assets', 'poiId')).exists(), false);
  assert.equal(await Bun.file(join(root, 'assets', 'hotelId')).exists(), false);
});

test('normalizes mapped reaction notation without treating atom maps as Archive paths', async () => {
  const root = await fixtureRoot('mapped-reaction');
  const prose = [
    'Original Reaction: [C@@H:6]([C:7]([O:8][CH3:9])=[O:10])[NH:11][C:12](=[O:13])[NH:14]',
    'Updated Reaction: [O:201]=[C:101]([O:202][CH2:203][c:204]1[cH:205][cH:206])',
  ].join('\n');
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'code', code_body: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ outputDir: root, model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
});

test('normalizes Unicode mathematical variables without treating them as Archive paths', async () => {
  const root = await fixtureRoot('unicode-math');
  const prose = 'A matrix 𝑴 ∈ ℝ<sup>!×#</sup> defines ℒ[𝑴]: ℝ<sup>!</sup> → ℝ<sup>#</sup>, ℒ[𝑴](𝒖) ≔ ∑ 𝑢<sub>i</sub>𝑟<sub>i</sub>(𝑴).';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'page_footnote', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ outputDir: root, model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
});

test('normalizes footnote definitions whose first token is prose instead of an Archive asset', async () => {
  const root = await fixtureRoot('footnote-prose-destination');
  const prose = [
    'SiteID: ‘Lorexa‘ z score: ‘-1.60‘ [^1][^2]',
    '[^1]: ‘/Manufacturing\\_Site\\_Operations\\_2020\\_2024.xlsx‘',
    '[^2]: ‘US‘ tabs in ‘/4. Received From Client/Impact Therapeutics/ImpactTherapeutics\\_PnL.xlsx‘',
  ].join('\n');
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), prose);
  assert.equal(await Bun.file(join(root, 'assets', '‘US‘')).exists(), false);
});

test('normalizes split chemical SMILES without inventing Archive resources', async () => {
  const root = await fixtureRoot('chemical-smiles');
  const markdown = '# Paper\n\n[CH3:19][C\n\n:4](=[O:23])[C@@H:13]1';
  const contentList = [
    { type: 'text', page_idx: 0, text: '[CH3:19][C' },
    { type: 'text', page_idx: 0, text: ':4](=[O:23])[C@@H:13]1' },
  ];
  await writeFile(join(root, 'paper.md'), markdown);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify(contentList));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(await readFile(result.markdownPath, 'utf8'), markdown);
  assert.deepEqual(JSON.parse(await readFile(result.contentListPath, 'utf8')), contentList);
});

test('normalizes multi-atom SMILES destinations without treating them as Archive paths', async () => {
  const root = await fixtureRoot('chemical-smiles-sequence');
  const prose = 'Molecule: COc1cc1CN1C[C@H](OC)C[C@@H]1C(N)=O';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /\[C@H\]\(OC\)/);
  assert.equal(await Bun.file(join(root, 'assets', 'OC')).exists(), false);
});

test('publication freezes strict versioned source metadata and its selected parse attempt', async () => {
  const root = await fixtureRoot('archive-source');
  const pdfPath = join(root, 'source.pdf');
  const destination = join(root, 'archive', '2601.00001-v1');
  const pdf = await archiveTestPdf();
  await writeFile(pdfPath, pdf);
  const job = {
    libraryId: asLibraryId('fsd'), mineruVersion: '3.1.0',
    libraryPaths: { dataRoot: root, workRoot: join(root, 'work'), archiveRoot: join(root, 'archive'),
      databasePath: join(root, 'library.sqlite'), operationsRoot: join(root, 'operations'), runsRoot: join(root, 'runs'), vaultRoot: join(root, 'vault'), backupRoot: join(root, 'backup') },
    baseId: '2601.00001', arxivId: '2601.00001v1', version: 1,
    sha256: createHash('sha256').update(pdf).digest('hex'), fileSource: pdfPath, outputDir: destination,
    model: 'pipeline' as const, cliBackend: 'pipeline' as const, method: 'auto' as const,
    title: 'Frozen Archive Source', authors: ['Ada Archive'], categories: ['cs.SE'],
    matchedTracks: ['AI-FSD'], published: '2026-01-01T00:00:00Z', updated: '2026-01-02T00:00:00Z',
    parseAttemptId: 'attempt-selected',
  };
  const workspace = await createParseWorkspace(job);
  assert.equal(workspace.root, join(root, 'work', 'parsing', 'attempt-selected'));
  await writeFile(join(workspace.root, 'paper.md'), '# Frozen source');
  await writeFile(join(workspace.root, 'paper_content_list.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: 'source text' }]));
  const artifact = await normalizeLocalMinerUResult({ ...job, outputDir: workspace.root, pageCount: 1 });
  const published = await publishParseWorkspace(workspace, artifact, job, async () => undefined);
  const { source, manifest } = await verifyArchiveV2(destination);
  assert.equal(published.outputDir, destination);
  assert.equal(source.parseAttemptId, 'attempt-selected');
  assert.equal(source.arxivId, '2601.00001v1');
  assert.deepEqual(source.authors, ['Ada Archive']);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [...manifest.files].map((entry) => entry.path).sort());
  assert.ok(manifest.files.some((entry) => entry.path === 'pages.json'));
  assert.equal(published.pageTextPath, undefined);
});

test('publication refuses an operations junction before creating any lock', async () => {
  const root = await fixtureRoot('operations-link');
  const external = await fixtureRoot('operations-external');
  const context = archiveContext(root);
  await symlink(external, context.libraryPaths.operationsRoot, 'junction');
  links.push(context.libraryPaths.operationsRoot);
  const pdf = await archiveTestPdf();
  const fileSource = join(root, 'source.pdf'); await writeFile(fileSource, pdf);
  let entered = false;
  const result = await runLocalParse({ ...context, baseId: '2601.00001', version: 1,
    fileSource, sha256: createHash('sha256').update(pdf).digest('hex'), model: 'pipeline', cliBackend: 'pipeline',
    outputDir: join(context.libraryPaths.archiveRoot, '2601.00001-v1') }, {
    store: { reserveParseAttempt: () => ({ attemptId: 'operations-link' }), assertParseAttemptCurrent: () => { entered = true; } },
    runner: async job => {
      await writeFile(join(job.outputDir!, 'paper.md'), '# Paper');
      await writeFile(join(job.outputDir!, 'paper_content_list.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: 'Paper text' }]));
      return { exitCode: 0, cleanupConfirmed: true };
    },
    assessExtraction: () => ({ accepted: true }),
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(await readdir(external), []);
  assert.equal(entered, false);
});

for (const syntax of ['inline', 'nested HTML', 'angle destination', 'reference definition']) test(`normalizer publishes link-only resources through Archive v2 (${syntax})`, async () => {
  const nested = syntax === 'nested HTML';
  const root = await fixtureRoot('link-only');
  const pdf = await archiveTestPdf();
  const fileSource = join(root, 'source.pdf'); await writeFile(fileSource, pdf);
  const context = archiveContext(root);
  const job = { ...context, fileSource, sha256: createHash('sha256').update(pdf).digest('hex'),
    baseId: 'local-link', version: 1, sourceType: 'local_pdf' as const, title: 'Link paper', parserConfigKey: 'pipeline-auto',
    model: 'pipeline', cliBackend: 'pipeline', method: 'auto', parseAttemptId: 'link-only',
    outputDir: join(context.libraryPaths.archiveRoot, 'local-link-v1') };
  const workspace = await createParseWorkspace(job);
  await mkdir(join(workspace.root, 'images'));
  await writeFile(join(workspace.root, 'images', 'figure.jpg'), 'original figure bytes');
  const markdown = nested ? '# Paper' : syntax === 'angle destination' ? '# Paper\n[figure](<images/figure.jpg>)'
    : syntax === 'reference definition' ? '# Paper\n[figure][fig]\n\n[fig]: <images/figure.jpg>'
    : '# Paper\n[figure](images/figure.jpg)';
  await writeFile(join(workspace.root, 'paper.md'), markdown);
  await writeFile(join(workspace.root, 'paper_content_list.json'), JSON.stringify([
    { type: 'text', page_idx: 0, text: 'Paper', ...(nested ? { table_body: '<a href=images/figure.jpg>figure</a>' } : {}) },
  ]));
  const artifact = await normalizeLocalMinerUResult({ ...job, outputDir: workspace.root, pageCount: 1 });
  assert.equal(await readFile(join(workspace.root, 'assets', 'images', 'figure.jpg'), 'utf8'), 'original figure bytes');
  const normalized = await readFile(nested ? artifact.contentListPath : artifact.markdownPath, 'utf8');
  assert.match(normalized, /assets\/images\/figure\.jpg/);
  await publishParseWorkspace(workspace, artifact, job, () => undefined);
  const archive = await verifyArchiveV2(workspace.destination);
  assert.equal(Buffer.from(archive.payloads.get('assets/images/figure.jpg')!).toString(), 'original figure bytes');
  assert.deepEqual(archive.manifest.files.filter(file => file.path.startsWith('assets/')).map(file => file.path), ['assets/images/figure.jpg']);
});

test('pipeline reference lists survive the complete normalized-artifact path', async () => {
  const root = await fixtureRoot('pipeline-references');
  const contentList = [
    { page_idx: 0, type: 'text', text: 'Main paper text.' },
    { page_idx: 1, type: 'list', sub_type: 'ref_text', list_items: ['First reference.', 'Final reference.'] },
  ];
  await writeFile(join(root, 'paper.md'), 'Main paper text.\n\nFirst reference.\n\nFinal reference.');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify(contentList));
  const artifact = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 2 });
  const pages = JSON.parse(await readFile(join(artifact.normalizedDir, 'pages.json'), 'utf8'));
  assert.equal(pages[1].text, 'First reference.\n\nFinal reference.');
  assert.equal(assessExtraction(pages, { pageCount: 2 }).accepted, true);
  assert.match(await readFile(artifact.pageTextPath, 'utf8'), /--- PAGE 2 ---\nFirst reference\.[\s\S]*Final reference\./);
  assert.deepEqual(JSON.parse(await readFile(artifact.contentListPath, 'utf8')), contentList);
});

test('normalizes pipeline content_list into one-based page text', async () => {
  const root = await fixtureRoot('pipeline');
  const markdown = '# Paper';
  const contentList = [{ page_idx: 0, type: 'text', text: 'first' }];
  await writeFile(join(root, 'paper.md'), markdown);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify(contentList));
  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });
  assert.equal(result.rawOutputDir, root);
  assert.equal(result.normalizedDir, join(root, 'normalized'));
  assert.equal(result.markdownPath, join(root, 'normalized', 'full.md'));
  assert.equal(result.contentListPath, join(root, 'normalized', 'content-list.json'));
  assert.equal(result.pageTextPath, join(root, 'normalized', 'page-marked.txt'));
  assert.equal(result.pageCount, 1);
  assert.equal(await readFile(result.markdownPath, 'utf8'), `${markdown}`);
  assert.equal(await readFile(result.contentListPath, 'utf8'), `${JSON.stringify(contentList, null, 2)}\n`);
  assert.equal(await readFile(join(result.normalizedDir, 'pages.json'), 'utf8'), `${JSON.stringify([{ pageNumber: 1, text: 'first', blockCount: 1 }], null, 2)}\n`);
  assert.equal(await readFile(result.pageTextPath, 'utf8'), '--- PAGE 1 ---\nfirst\n');
  const expectedHash = createHash('sha256').update(markdown).update(JSON.stringify(contentList)).digest('hex');
  assert.equal(result.contentHash, expectedHash);
});

test('normalizes code examples with NER labels without treating labels as assets', async () => {
  const root = await fixtureRoot('ner-labels');
  const prose = 'Entities : [ ENTITY ]( TYPE ), [ Apple ]( ORG), [ iPhone 15]( PRODUCT ), [ Cupertino ]( LOC)';
  await writeFile(join(root, 'paper.md'), '# Paper');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'code', code_body: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /LOC/);
  assert.equal(await Bun.file(join(root, 'assets', 'LOC')).exists(), false);
});

test('normalizes conceptual reference examples without requiring a missing refs file', async () => {
  const root = await fixtureRoot('reference-example');
  const prose = 'When the task matches X, read [X](refs/x.md) from the navigation table.';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /refs\/x\.md/);
  assert.equal(await Bun.file(join(root, 'assets', 'refs', 'x.md')).exists(), false);
});

test('normalizes escaped Python attribute notation without treating it as an Archive path', async () => {
  const root = await fixtureRoot('escaped-python-attribute');
  const prose = 'if self.\\_message\\_criteria[self.\\_current\\_msg](self.\\_state):';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /self\.\\_state/);
  assert.equal(await Bun.file(join(root, 'assets', 'self.\\_state')).exists(), false);
});

test('normalizes Python argument unpacking without treating it as an Archive path', async () => {
  const root = await fixtureRoot('python-argument-unpacking');
  const prose = 'result ← registry[tc.name](\\*\\*tc.args)';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /\\\*\\\*tc\.args/);
  assert.equal(await Bun.file(join(root, 'assets', '\\*\\\*tc.args')).exists(), false);
});

test('normalizes parameter required-or-optional notation without treating it as an Archive path', async () => {
  const root = await fixtureRoot('parameter-status-notation');
  const prose = 'Parameters: - {param_name} [{type}](required/optional): {param_description}';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /required\/optional/);
  assert.equal(await Bun.file(join(root, 'assets', 'required', 'optional')).exists(), false);
});

test('normalizes template HTML asset placeholders without treating them as Archive paths', async () => {
  const root = await fixtureRoot('template-html-asset');
  const prose = '<figure class="flow-asset"><img src="{{layer:...}}"><p>readout</p></figure>';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /\{\{layer:\.\.\.\}\}/);
  assert.equal(await Bun.file(join(root, 'assets', '{{layer:...}}')).exists(), false);
});

test('normalizes OCR zero in chemical SMILES bonds without treating it as an Archive path', async () => {
  const root = await fixtureRoot('smiles-ocr-zero');
  const prose = 'Yield SMILES: [N+:17](=0)[0-]';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /=0/);
  assert.equal(await Bun.file(join(root, 'assets', '=0')).exists(), false);
});

test('normalizes SMARTS examples without treating atom predicates as Archive paths', async () => {
  const root = await fixtureRoot('smarts-atom-predicates');
  const prose = 'Functional groups: [CX3](=[OX1]) and [CX3](=O); [OD2]([#6])';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'code', code_body: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /\[CX3\].*\[OD2\]/);
  for (const path of ['=O', '=[OX1]', '[']) {
    assert.equal(await Bun.file(join(root, 'assets', path)).exists(), false);
  }
});

test('normalizes truncated external image examples without requiring a destination', async () => {
  const root = await fixtureRoot('truncated-external-image');
  const prose = '<td>[![Simulator Screen Shot Mar 11, 2017, 11.44.31 PM.png](https://files.gitter.im/patchthecode/JTAppleCalendar/CFRA/thumb/Simulat...</td>';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /Simulator Screen Shot/);
});

test('normalizes generic Markdown image URL placeholders without treating them as assets', async () => {
  const root = await fixtureRoot('markdown-image-url-placeholder');
  const prose = 'Images need to be rendered as ![](url)';
  await writeFile(join(root, 'paper.md'), prose);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: prose },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(result.pageCount, 1);
  assert.match(await readFile(result.pageTextPath, 'utf8'), /!\[\]\(url\)/);
  assert.equal(await Bun.file(join(root, 'assets', 'url')).exists(), false);
});

test('normalizes MinerU Markdown with a truncation placeholder link', async () => {
  const root = await fixtureRoot('truncation-placeholder');
  const markdown = '# Paper\n\n**Paddy Power**: [paddyPower.com](trunc) **Betway**.';
  await writeFile(join(root, 'paper.md'), markdown);
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: markdown }]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(await readFile(result.markdownPath, 'utf8'), markdown);
  assert.equal(await readFile(result.contentListPath, 'utf8'), `${JSON.stringify([{ page_idx: 0, type: 'text', text: markdown }], null, 2)}\n`);
});

test('normalizes real MinerU image references into stable Archive assets', async () => {
  const root = await fixtureRoot('pipeline-images');
  const raw = join(root, '2608.09072v1', 'auto');
  await mkdir(join(raw, 'images'), { recursive: true });
  await writeFile(join(raw, 'paper.md'), '# Paper\n\n![Figure](images/figure.jpg)\n');
  await writeFile(join(raw, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: 'Paper with a figure.' },
    { page_idx: 0, type: 'image', img_path: 'images/figure.jpg' },
  ]));
  await writeFile(join(raw, 'images', 'figure.jpg'), 'real image bytes');

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 });

  assert.equal(await readFile(result.markdownPath, 'utf8'), '# Paper\n\n![Figure](assets/images/figure.jpg)\n');
  const contentList = JSON.parse(await readFile(result.contentListPath, 'utf8'));
  assert.equal(contentList[1].img_path, 'assets/images/figure.jpg');
  assert.equal(await readFile(join(root, 'assets', 'images', 'figure.jpg'), 'utf8'), 'real image bytes');
  assert.equal(await readFile(join(raw, 'images', 'figure.jpg'), 'utf8'), 'real image bytes');
});

test('prefers VLM content_list_v2 and keeps the same normalized interface', async () => {
  const root = await fixtureRoot('vlm');
  await writeFile(join(root, 'paper.md'), '# VLM Paper');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: 'wrong v1' }]));
  await writeFile(join(root, 'paper_content_list_v2.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: 'vlm first' }]));
  const result = await normalizeLocalMinerUResult({ model: 'vlm', cliBackend: 'vlm-engine', outputDir: root, pageCount: 1 });
  assert.equal(result.model, 'vlm');
  assert.match(await readFile(result.pageTextPath, 'utf8'), /vlm first/);
  assert.doesNotMatch(await readFile(result.pageTextPath, 'utf8'), /wrong v1/);
});

test('normalizes nested VLM v2 pages and content fields', async () => {
  const root = await fixtureRoot('vlm-nested');
  await writeFile(join(root, 'paper.md'), '# Nested VLM Paper');
  await writeFile(join(root, 'paper_content_list_v2.json'), JSON.stringify([
    [{ type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: 'nested first' }] } }],
    [{ type: 'title', content: { title_content: [{ type: 'text', content: 'nested second' }] } }],
  ]));
  const result = await normalizeLocalMinerUResult({ model: 'vlm', cliBackend: 'vlm-engine', outputDir: root, pageCount: 2 });
  assert.match(await readFile(result.pageTextPath, 'utf8'), /--- PAGE 1 ---[\s\S]*nested first[\s\S]*--- PAGE 2 ---[\s\S]*nested second/);
});

test('extracts nested VLM list items, captions, and footnotes in order', async () => {
  const root = await fixtureRoot('vlm-content-fields');
  await writeFile(join(root, 'paper.md'), '# VLM Content Fields');
  await writeFile(join(root, 'paper_content_list_v2.json'), JSON.stringify([[
    { type: 'list', content: { list_items: [{ item_content: [{ type: 'text', content: 'list item' }] }] } },
    { type: 'image', content: { image_footnote: [{ type: 'text', content: 'image footnote' }] } },
    { type: 'table', content: { table_footnote: [{ type: 'text', content: 'table footnote' }] } },
    { type: 'chart', content: { chart_footnote: [{ type: 'text', content: 'chart footnote' }] } },
    { type: 'code', content: { code_caption: [{ type: 'text', content: 'code caption' }] } },
    { type: 'algorithm', content: { algorithm_caption: [{ type: 'text', content: 'algorithm caption' }] } },
    { type: 'page_footnote', content: { page_footnote_content: [{ type: 'text', content: 'page footnote' }] } },
  ]]));
  const result = await normalizeLocalMinerUResult({ model: 'vlm', cliBackend: 'vlm-engine', outputDir: root, pageCount: 1 });
  assert.match(
    await readFile(result.pageTextPath, 'utf8'),
    /list item[\s\S]*image footnote[\s\S]*table footnote[\s\S]*chart footnote[\s\S]*code caption[\s\S]*algorithm caption[\s\S]*page footnote/,
  );
});

test('rejects missing structured output', async () => {
  const root = await fixtureRoot('missing');
  await writeFile(join(root, 'paper.md'), '# inline only');
  await assert.rejects(normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 }), /structured content list required/);
});

test('job construction propagates library paths and parser version to v2 destination', () => {
  const context = loadEngineContext({ root: process.cwd(), libraryId: 'fsd' });
  const config = toMinerULocalConfig(context);
  const job = buildLocalParseJob({ baseId: '2601.00001', arxivId: '2601.00001v2', version: 2, sha256: 'a'.repeat(64), pdfPath: 'unused.pdf' }, config);
  assert.deepEqual(job.libraryPaths, context.paths);
  assert.equal(job.libraryId, 'fsd');
  assert.equal(job.mineruVersion, config.expectedVersion);
  assert.equal(job.outputDir, join(context.paths.archiveRoot, '2601.00001-v2').replaceAll('\\', '/'));
});

test('rejects internal junctions even when their targets stay inside the workspace', async () => {
  const root = await fixtureRoot('inside-junction');
  await mkdir(join(root, 'real'));
  await writeFile(join(root, 'paper.md'), '![figure](linked/figure.jpg)');
  await writeFile(join(root, 'paper_content_list.json'), '[{"page_idx":0,"text":"first"}]');
  await writeFile(join(root, 'real', 'figure.jpg'), 'figure');
  const link = join(root, 'linked');
  await symlink(join(root, 'real'), link, 'junction'); links.push(link);
  await assert.rejects(normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root }), /link|reparse/);
});

test('normalization stores identical referenced assets once and rewrites every alias', async () => {
  const root = await fixtureRoot('duplicate-assets');
  await mkdir(join(root, 'images'));
  await writeFile(join(root, 'paper.md'), '![a](images/a.jpg)\n![b](images/b.jpg)');
  await writeFile(join(root, 'paper_content_list.json'), '[{"page_idx":0,"img_path":"images/b.jpg"}]');
  await writeFile(join(root, 'images', 'a.jpg'), 'same bytes');
  await writeFile(join(root, 'images', 'b.jpg'), 'same bytes');
  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root });
  assert.equal(await readFile(result.markdownPath, 'utf8'), '![a](assets/images/a.jpg)\n![b](assets/images/a.jpg)');
  await assert.rejects(lstat(join(root, 'assets', 'images', 'b.jpg')), /ENOENT/);
});

test('rejects a page count mismatch', async () => {
  const root = await fixtureRoot('page-count');
  await writeFile(join(root, 'paper.md'), '# Paper');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: 'first' },
    { page_idx: 2, type: 'text', text: 'third' },
  ]));
  await assert.rejects(normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 2 }), /page count mismatch/);
});

test('skips a file that disappears while collecting MinerU output metadata', async () => {
  const root = await fixtureRoot('vanished-output');
  const stable = join(root, 'paper.md');
  const vanished = join(root, '0');
  await writeFile(stable, '# Paper');
  await writeFile(vanished, 'temporary');

  const files = await collectMinerUFiles(root, 1, async (path) => {
    if (path === vanished) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
    const metadata = await stat(path);
    assert.ok(metadata);
    return metadata;
  });

  assert.deepEqual(files, [stable]);
});

test('retries a transient missing entry while validating the MinerU output tree', async () => {
  let attempts = 0;
  await assertStableMinerUOutputTree('D:/mineru-output', async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
    return [];
  });
  assert.equal(attempts, 2);
});

test('recovers the page count for resumed manifests that omitted it', async () => {
  const root = await fixtureRoot('resume-page-count');
  const pdfPath = join(root, 'source.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage(); pdf.addPage(); pdf.addPage();
  await writeFile(pdfPath, await pdf.save());
  await writeFile(join(root, 'paper.md'), '# Paper');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([
    { page_idx: 0, type: 'text', text: 'first' },
    { page_idx: 2, type: 'text', text: 'third' },
  ]));

  const result = await normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, fileSource: pdfPath });
  const pages = JSON.parse(await readFile(join(root, 'normalized/pages.json'), 'utf8'));
  assert.equal(result.pageCount, 3);
  assert.deepEqual(pages.map((page: { pageNumber: number; text: string }) => [page.pageNumber, page.text]), [
    [1, 'first'], [2, ''], [3, 'third'],
  ]);
});

test('rejects discovered artifacts outside the output directory', async (t) => {
  const root = await fixtureRoot('outside');
  const outside = await fixtureRoot('outside-target');
  await writeFile(join(outside, 'paper.md'), '# Outside');
  await writeFile(join(root, 'paper_content_list.json'), JSON.stringify([{ page_idx: 0, type: 'text', text: 'first' }]));
  try {
    await symlink(join(outside, 'paper.md'), join(root, 'paper.md'));
    links.push(join(root, 'paper.md'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES'))) throw error;
    try {
      await symlink(outside, join(root, 'outside'), 'junction');
      links.push(join(root, 'outside'));
    } catch (fallbackError) {
      if (fallbackError instanceof Error && 'code' in fallbackError && (fallbackError.code === 'EPERM' || fallbackError.code === 'EACCES')) return t.skip('symbolic links unavailable');
      throw fallbackError;
    }
  }
  await assert.rejects(
    normalizeLocalMinerUResult({ model: 'pipeline', cliBackend: 'pipeline', outputDir: root, pageCount: 1 }),
    /artifact outside output directory/,
  );
});
