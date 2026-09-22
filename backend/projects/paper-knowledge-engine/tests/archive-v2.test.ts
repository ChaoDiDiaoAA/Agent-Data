import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, unlink, symlink, rmdir, cp, copyFile, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { asLibraryId } from '../src/shared/identity.ts';
import { writeArchiveV2 } from '../src/mineru/archive-writer.ts';
import { verifyArchiveV2, archiveReferences, rewriteArchiveReferences } from '../src/shared/archive-v2.ts';
import { discoverArchiveAssetPaths, rewriteArchiveAssetReferences } from '../src/shared/archive-references.ts';
import { canonicalJson } from '../src/shared/manifest.ts';
import { removeOwnedTestDirectory } from './fixtures/runtime-fixtures.ts';
import { archiveTestPdf } from './fixtures/library-paths.ts';
import { normalizeLocalMinerUResult } from '../src/mineru/mineru-local-result.ts';

const roots: string[] = [];
test('citation followed by parenthesized prose is not a partial Markdown link', () => {
  const prose = 'Gemma 4 31B [37](a larger cloud model).';
  const content = [{ type: 'text', text: prose }];
  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('[PDF](assets/a.pdf "source")', [])).toEqual(['assets/a.pdf']);
  expect(rewriteArchiveReferences('[PDF](assets/a.pdf "source")', [], new Map([['assets/a.pdf', 'source.pdf']])).fullMarkdown).toBe('[PDF](source.pdf "source")');
});

test('citation labels followed by bare architecture terms are not Archive links', () => {
  const prose = 'Autoformer [40] and PatchTST [41](Transformer-based), TimesNet [42](temporal CNN), DLinear [43](linear), and TimeMixer [44](token-mixing).';
  const content = [{ type: 'text', text: prose }];
  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
  expect(rewriteArchiveReferences(prose, content, new Map([['Transformer-based', 'assets/Transformer-based']])).fullMarkdown).toBe(prose);
  expect(archiveReferences('[41](assets/model.bin)', [])).toEqual(['assets/model.bin']);
});

test('footnote definitions keep prose destinations out of Archive references', () => {
  const prose = [
    'SiteID: ‘Lorexa‘ z score: ‘-1.60‘ [^1][^2]',
    '[^1]: ‘/Manufacturing\\_Site\\_Operations\\_2020\\_2024.xlsx‘',
    '[^2]: ‘US‘ tabs in ‘/4. Received From Client/Impact Therapeutics/ImpactTherapeutics\\_PnL.xlsx‘',
  ].join('\n');
  const content = [{ type: 'text', text: prose }];
  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
});

test('NER label examples in MinerU code text are not treated as Archive assets', () => {
  const prose = 'Entities : [ ENTITY ]( TYPE ), [ Apple ]( ORG), [ iPhone 15]( PRODUCT ), [ Cupertino ]( LOC)';
  const content = [{ type: 'code', code_body: prose }];
  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
  // The exception is chemistry-contextual; a similarly shaped bare link still
  // fails closed so a real invalid local destination cannot be hidden.
  expect(() => archiveReferences('[Guide]([C:7])', [])).toThrow(/unsafe Archive path/);
  expect(() => archiveReferences('Organic reaction reference: [Guide]([C:7])', [])).toThrow(/unsafe Archive path/);
});

test('conceptual reference examples in prose are not treated as Archive assets', () => {
  const prose = 'When the task matches X, read [X](refs/x.md) from the navigation table.';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('[Guide](refs/guide.md)', [])).toEqual(['refs/guide.md']);
});

test('truncated external image examples do not become missing Markdown destinations', () => {
  const prose = '<td>[![Simulator Screen Shot Mar 11, 2017, 11.44.31 PM.png](https://files.gitter.im/patchthecode/JTAppleCalendar/CFRA/thumb/Simulat...</td>';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
  expect(() => archiveReferences('![missing image]', [])).toThrow(/no destination/);
});

test('split external image destinations do not become missing Markdown destinations', () => {
  const prose = '![Services Hexagon](https://example.com/\nservices-hexagon.png)';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
  expect(() => archiveReferences('![missing image](assets/\nmissing.png)', [])).toThrow(/no destination/);
});

test('does not treat quoted OCR image examples as current Archive assets', () => {
  const prose = [
    '## Adobe Text Extract',
    '![Figure](fileoutpart42.png)',
    '## Ministral 3B',
    '![Ringlock Scaffold](placeholder)',
  ].join('\n');
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('![Figure](fileoutpart42.png)', [])).toEqual(['fileoutpart42.png']);
  expect(archiveReferences('![Figure](assets/fileoutpart42.png)', [])).toEqual(['assets/fileoutpart42.png']);
});

test('does not treat generic Markdown image URL placeholders as Archive paths', () => {
  const prose = 'Images need to be rendered as ![](url)';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('![Figure](url)', [])).toEqual(['url']);
  expect(archiveReferences('![](assets/url)', [])).toEqual(['assets/url']);
});

test('does not treat chemical SMILES notation as Markdown asset links', () => {
  const prose = [
    '[CH3:19][C:4](=[O:23])[C@@H:13]1[CH2:9][CH2:10]',
    '[CH3:19][C\n\n:4](=[O:23])[C@@H:13]1',
    'Starting molecule: COc1ccccc1SCC(=O)N[C@@H](C)c1ccon1',
    'Mapped molecule: COc1cc2ncnc(Nc3cccc(Cl)c3F)c2cc1CN1C[C@H](OC)C[C@@H]1C(N)=O',
  ].join('\n');
  const content = [
    { type: 'text', text: prose },
    { type: 'text', text: ':4](=[O:23])[C@@H:13]1' },
  ];

  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('[C](assets/chemical.pdf)', [])).toEqual(['assets/chemical.pdf']);
});

test('does not treat mapped reaction notation as Archive paths', () => {
  const prose = [
    'Original Reaction: [C@@H:6]([C:7]([O:8][CH3:9])=[O:10])[NH:11][C:12](=[O:13])[NH:14]',
    'Updated Reaction: [O:201]=[C:101]([O:202][CH2:203][c:204]1[cH:205][cH:206])',
  ].join('\n');
  const content = [{ type: 'code', code_body: prose }];

  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
});

test('does not treat mathematical bracket expressions as Markdown asset links', () => {
  const prose = 'Term 2: [40 -5c\\_x/7](6) and Term 3: [40 -5c\\_x/7](0).';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
});

test('does not treat Unicode mathematical variables as Archive paths', () => {
  const prose = 'A matrix 𝑴 ∈ ℝ<sup>!×#</sup> defines ℒ[𝑴]: ℝ<sup>!</sup> → ℝ<sup>#</sup>, ℒ[𝑴](𝒖) ≔ ∑ 𝑢<sub>i</sub>𝑟<sub>i</sub>(𝑴).';
  const content = [{ type: 'page_footnote', text: prose }];

  expect(archiveReferences(prose, content)).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('[Guide](𝒖)', [])).toEqual(['𝒖']);
});

test('does not treat MinerU escaped Python attribute notation as an Archive path', () => {
  const prose = 'if self.\\_message\\_criteria[self.\\_current\\_msg](self.\\_state):';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
  const vlmProse = 'if self._message_criteria[self._current_msg](self._state):';
  expect(archiveReferences(vlmProse, [{ type: 'text', text: vlmProse }])).toEqual([]);
  expect(rewriteArchiveReferences(vlmProse, [{ type: 'text', text: vlmProse }], new Map()).fullMarkdown).toBe(vlmProse);
  expect(() => archiveReferences('[Invalid](assets\\\\figure.jpg)', [])).toThrow(/safe relative/);
});

test('does not treat Python argument unpacking as an Archive path', () => {
  const prose = 'result ← registry[tc.name](\\*\\*tc.args)';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('[tc.name](assets/tool.json)', [])).toEqual(['assets/tool.json']);
  expect(archiveReferences('[CX3](assets/chemical.pdf)', [])).toEqual(['assets/chemical.pdf']);
});

test('does not treat required-or-optional parameter notation as an Archive path', () => {
  const prose = 'Parameters: - {param_name} [{type}](required/optional): {param_description}';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
});

test('does not treat bold entity-id examples as Archive paths', () => {
  const prose = [
    'Attractions: poi (id: poiId, name: poiName); hotels use hotel (id: hotelId, name: hotelName).',
    'Use the format **[PoiName](poiId)** or **[HotelName](hotelId)** when describing reference data.',
    'The JSON example is **[Beijing Zoo](0001)** and **[Beijing Tiantan Manssion Hotel](0002)**.',
  ].join('\n');
  const content = [{ type: 'text', text: prose }];

  expect(archiveReferences(prose, content)).toEqual([]);
  expect(archiveReferences('', content)).toEqual([]);
  expect(archiveReferences(prose.replaceAll('**', '\\*\\*'), [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, content, new Map()).fullMarkdown).toBe(prose);
  // A bare, unqualified local link remains strict so missing resources cannot
  // be hidden by the entity-id exception.
  expect(archiveReferences('**[Guide](0001)** is a local artifact.', [])).toEqual(['0001']);
});

test('does not treat template HTML asset placeholders as Archive paths', () => {
  const prose = '<figure class="flow-asset"><img src="{{layer:...}}"><p>readout</p></figure>';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toContain('{{layer:...}}');
});

test('does not treat OCR zero in chemical SMILES bonds as an Archive path', () => {
  const prose = 'Yield SMILES: [N+:17](=0)[0-]';
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
});

test('does not treat SMARTS atom patterns as Archive paths', () => {
  const prose = [
    'Functional groups: [CX3](=[OX1]) and [CX3](=[0X1]) and [CX3](=O)',
    'Other patterns: [SX4](=[OX1]) and [OD2]([#6])',
  ].join('\n');
  expect(archiveReferences(prose, [{ type: 'text', text: prose }])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [{ type: 'text', text: prose }], new Map()).fullMarkdown).toBe(prose);
});

test('ignores MinerU truncation placeholders without weakening missing-resource checks', () => {
  const prose = '**Paddy Power**: [paddyPower.com](trunc) **Betway**: [betway.com](https://www.betway.com)';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('[paddyPower.com](%74%72%75%6e%63)', [])).toEqual([]);
  expect(archiveReferences('[missing](assets/missing.jpg)', [])).toEqual(['assets/missing.jpg']);
});

test('does not treat bracketed metric labels followed by prose as Markdown link definitions', () => {
  const prose = [
    '[m ]: Usefulness. Measures perceived practical value of codebased explanations.',
    '[m<sub>2</sub>]: Readability. Assesses how informative and comprehensible the visualizations are.',
    '[m<sub>3</sub>]: Alignment. Measures how closely the generated rationale reflects human reasoning.',
  ].join('\n');
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
});

test('does not treat prompt placeholders as shortcut Markdown link definitions', () => {
  const prose = [
    'The prompt contains the placeholder [vulnerable-API-list].',
    '[vulnerable-API-list]: Archive.Archive',
  ].join('\n');
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
});

test('treats bare HTML image words in prose as text', () => {
  const prose = 'The paper mentions a literal <img> tag and a <source /> tag.';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown)
    .toBe('The paper mentions a literal &lt;img&gt; tag and a &lt;source /&gt; tag.');
});

test('does not treat less-than comparisons followed by prose as HTML', () => {
  const prose = 'The loop condition i<len must hold initially<sub>y</sub>.';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
});

test('does not treat uppercase mathematical comparison variables as HTML tags', () => {
  const prose = 'The rule <V does not match a post-release. A boundary such as | = > 1 remains prose.';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
  expect(archiveReferences('', [{ type: 'text', text: prose }])).toEqual([]);
});

test('keeps resource discovery for HTML-like custom elements', () => {
  expect(archiveReferences('<widget href="assets/figure.jpg">figure</widget>', [])).toEqual(['assets/figure.jpg']);
});

test('does not treat angle-bracket placeholders as HTML image elements', () => {
  const prose = 'The prompt contains <source\\_request> and <img\\_tag> placeholders.';
  expect(archiveReferences(prose, [])).toEqual([]);
  expect(rewriteArchiveReferences(prose, [], new Map()).fullMarkdown).toBe(prose);
});

test('does not treat image-like syntax inside fenced or inline code as Markdown resources', () => {
  const prose = [
    '```xml',
    '<![CDATA[Backup file content v1]]>',
    '```',
    '',
    'Inline code: `![not-an-image](missing.jpg)`.',
    '![real](assets/figure.jpg)',
  ].join('\n');
  const content = [{ type: 'text', text: prose }];
  expect(archiveReferences(prose, content)).toEqual(['assets/figure.jpg']);
  expect(rewriteArchiveReferences(prose, content, new Map([['assets/figure.jpg', 'assets/real.jpg']])).fullMarkdown)
    .toContain('![real](assets/real.jpg)');
  expect(rewriteArchiveReferences(prose, content, new Map([['assets/figure.jpg', 'assets/real.jpg']])).fullMarkdown)
    .toContain('<![CDATA[Backup file content v1]]>');
});

test('does not treat HTML source examples inside fenced code as Archive resources', () => {
  const prose = [
    '```json',
    '{',
    '  "id": "<source id>",',
    '  "text": "<img alt=\\"example\\">"',
    '}',
    '```',
    '',
    '![real](assets/figure.jpg)',
  ].join('\n');
  expect(archiveReferences(prose, [])).toEqual(['assets/figure.jpg']);
  expect(rewriteArchiveReferences(prose, [], new Map([['assets/figure.jpg', 'assets/real.jpg']])).fullMarkdown)
    .toContain('"id": "<source id>",');
});

test('treats escaped backticks as prose while retaining real inline code masking for image assets', () => {
  const sha = '5b1d0f7e4a8c3e2d9f6b0a1c4d8e7f2a9b3c6d0e1f4a7b8c2d5e9f0a3b6c1d4e';
  const prose = [
    '😀 The literal delimiter \\` is part of this sentence.',
    `![published figure](images/${sha}.jpg)`,
    'Inline code: `![example](images/not-a-resource.jpg)`.',
  ].join('\n');
  const paths = new Map([[`assets/images/${sha}.jpg`, `assets/images/${sha}.jpg`]]);

  expect(discoverArchiveAssetPaths(prose, [])).toEqual([`images/${sha}.jpg`]);
  expect(() => rewriteArchiveAssetReferences(prose, [], new Map())).toThrow(`referenced asset has no normalized destination: images/${sha}.jpg`);
  expect(rewriteArchiveAssetReferences(prose, [], paths).fullMarkdown).toBe([
    '😀 The literal delimiter \\` is part of this sentence.',
    `![published figure](assets/images/${sha}.jpg)`,
    'Inline code: `![example](images/not-a-resource.jpg)`.',
  ].join('\n'));
});

test('treats a backslash before an inline-code closer as code content, not an escaped closer', () => {
  const prose = '`code\\` ![missing](missing.jpg) `';

  expect(discoverArchiveAssetPaths(prose, [])).toEqual(['missing.jpg']);
  expect(archiveReferences(prose, [])).toEqual(['missing.jpg']);
  expect(() => rewriteArchiveAssetReferences(prose, [], new Map()))
    .toThrow('referenced asset has no normalized destination: missing.jpg');
});

test('verifies escaped-backtick raw image references against a frozen normalized asset', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  const rawImage = 'images/figure.jpg';
  const normalizedImage = `assets/${rawImage}`;
  const document = [
    '😀 The literal delimiter \\` is prose.',
    `![figure](${rawImage})`,
    'Inline code: `![example](images/not-a-resource.jpg)`.',
  ].join('\n');
  const image = await readFile(join(archive.root, 'assets', 'figure.jpg'));
  await mkdir(join(archive.root, 'assets', 'images'));
  await writeFile(join(archive.root, normalizedImage), image);
  await unlink(join(archive.root, 'assets', 'figure.jpg'));
  await writeFile(join(archive.root, 'document.md'), document);
  const manifest = JSON.parse(await readFile(join(archive.root, 'manifest.json'), 'utf8'));
  manifest.files = manifest.files.filter((entry: { path: string }) => entry.path !== 'assets/figure.jpg');
  manifest.files.push({ path: normalizedImage, sha256: createHash('sha256').update(image).digest('hex'), bytes: image.byteLength });
  Object.assign(manifest.files.find((entry: { path: string }) => entry.path === 'document.md'), {
    sha256: createHash('sha256').update(document).digest('hex'), bytes: Buffer.byteLength(document),
  });
  await writeFile(join(archive.root, 'manifest.json'), canonicalJson(manifest));

  expect((await verifyArchiveV2(archive.root)).payloads.has(normalizedImage)).toBe(true);
});

test('keeps strict validation for attribute-bearing HTML image tags', () => {
  expect(archiveReferences('<img src="assets/figure.jpg">', [])).toEqual(['assets/figure.jpg']);
  expect(() => archiveReferences('<img alt="figure">', [])).toThrow(/parseable/);
  expect(() => archiveReferences('<source type="image\/png">', [])).toThrow(/parseable/);
});
afterEach(async () => { for (const root of roots.splice(0)) await removeOwnedTestDirectory(root); });
export async function fixtureInput() {
  const root = await mkdtemp(join(tmpdir(), 'archive-v2-')); roots.push(root);
  const paths = { dataRoot: root, archiveRoot: join(root, 'archive'), workRoot: join(root, 'work'),
    runsRoot: join(root, 'runs'), operationsRoot: join(root, 'operations'), databasePath: join(root, 'library.sqlite'),
    backupRoot: join(root, 'backup'), vaultRoot: join(root, 'vault') };
  const workspace = join(paths.workRoot, 'parsing', 'attempt-1');
  await mkdir(workspace, { recursive: true });
  const payloads: Record<string, string | Uint8Array> = {
    'source.pdf': await archiveTestPdf(), 'document.md': '# Paper\n![figure](assets/figure.jpg)',
    'pages.json': '[{"pageNumber":1,"text":"Paper","blockCount":1}]',
    'content-list.json': '[{"page_idx":0,"type":"text","text":"Paper"}]',
    'assets/figure.jpg': 'figure',
  };
  for (const [path, value] of Object.entries(payloads)) {
    await mkdir(join(workspace, path, '..'), { recursive: true });
    await writeFile(join(workspace, path), value);
  }
  await writeFile(join(workspace, 'origin.pdf'), 'intermediate');
  return { paths, workspace, attemptId: 'attempt-1', libraryId: asLibraryId('fsd'),
    sourceKind: 'arxiv' as const, baseId: '2601.00001', version: 1,
    pdfSha256: createHash('sha256').update(payloads['source.pdf']).digest('hex'),
    parser: { name: 'MinerU' as const, version: '3.1.0', model: 'pipeline' as const, method: 'auto' as const },
    source: { title: 'Frozen paper', authors: ['Ada'], categories: ['cs.SE'], matchedTracks: ['AI-FSD'],
      arxivId: '2601.00001v1', published: '2026-01-01', updated: '2026-01-02', parseAttemptId: 'attempt-1', pageCount: 1 },
  };
}

test('writer preserves an asset referenced only by page text', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'assets/page.jpg'), 'page-image');
  await writeFile(join(input.workspace, 'pages.json'), JSON.stringify([{ pageNumber: 1, text: '![page](assets/page.jpg)' }]));
  const archive = await writeArchiveV2(input);
  expect(await readFile(join(archive.root, 'assets/page.jpg'), 'utf8')).toBe('page-image');
});

test('writer and verifier reuse full Markdown context for OCR image examples in page text', async () => {
  const input = await fixtureInput();
  const markdown = '## Adobe Text Extract\n![Figure](fileoutpart7.png)\n![figure](assets/figure.jpg)';
  await writeFile(join(input.workspace, 'document.md'), markdown);
  await writeFile(join(input.workspace, 'pages.json'), JSON.stringify([{ pageNumber: 1, text: '![Figure](fileoutpart7.png)' }]));

  expect(archiveReferences('![Figure](fileoutpart7.png)', [], markdown)).toEqual([]);
  expect(archiveReferences('', [{ text: '![Figure](fileoutpart7.png)' }], markdown)).toEqual([]);
  const archive = await writeArchiveV2(input);
  await expect(verifyArchiveV2(archive.root)).resolves.toBeDefined();
  expect(archive.manifest.files.some(file => file.path.includes('fileoutpart7'))).toBe(false);
});

test('writes a lean archive and excludes MinerU intermediates', async () => {
  const input = await fixtureInput();
  const archive = await writeArchiveV2(input);
  const files = (await readdir(archive.root, { recursive: true, withFileTypes: true }))
    .filter(x => x.isFile()).map(x => join(x.parentPath, x.name).slice(archive.root.length + 1).replaceAll('\\', '/')).sort();
  expect(files).toEqual(['assets/figure.jpg', 'content-list.json', 'document.md', 'manifest.json', 'pages.json', 'source.json', 'source.pdf']);
  expect(archive.root).toBe(join(input.paths.archiveRoot, '2601.00001-v1'));
  expect(await lstat(join(input.paths.archiveRoot, 'papers')).catch(() => null)).toBeNull();
  const manifest = JSON.parse(await readFile(join(archive.root, 'manifest.json'), 'utf8'));
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.files.map((x: {path: string}) => x.path)).toEqual(files.filter(x => x !== 'manifest.json'));
});

for (const [label, html, nested] of [
  ['unquoted escape', '<a href=../outside.pdf>link</a>', false],
  ['unquoted absolute', '<video src=C:/outside.jpg></video>', false],
  ['nested absolute', '<img src="C:/outside.jpg">', true],
  ['nested escape', '<a href=../outside.pdf>link</a>', true],
  ['unquoted missing', '<a href=assets/missing.pdf>link</a>', false],
  ['nested missing', '<img src="assets/missing.jpg">', true],
  ['malformed attribute', '<a href="assets/figure.jpg>link</a>', false],
  ['encoded escape', '<a href=&#46;&#46;/outside.pdf>link</a>', false],
] as const) test(`HTML resource closure rejects ${label}`, async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  const path = nested ? 'content-list.json' : 'document.md';
  const body = nested ? JSON.stringify([{ type: 'table', page_idx: 0, content: { cells: [{ table_body: html }] } }])
    : `# Paper\n![figure](assets/figure.jpg)\n${html}`;
  await writeFile(join(archive.root, path), body);
  const manifest = archive.manifest;
  const entry = manifest.files.find(entry => entry.path === path)!;
  entry.sha256 = createHash('sha256').update(body).digest('hex'); entry.bytes = Buffer.byteLength(body);
  await writeFile(join(archive.root, 'manifest.json'), canonicalJson(manifest));
  // Valid payload hashes cannot make an unsafe or unresolved reference valid.
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
});

test('HTML resource closure accepts existing unquoted and nested payloads', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'document.md'), '# Paper\n<a href=assets/figure.jpg>figure</a>');
  await writeFile(join(input.workspace, 'content-list.json'), JSON.stringify([
    { type: 'table', page_idx: 0, table_body: '<table><tr><td><img src="assets/figure.jpg"></td></tr></table>' },
  ]));
  const archive = await writeArchiveV2(input);
  expect(archive.payloads.has('assets/figure.jpg')).toBe(true);
});

for (const [label, href] of [
  ['href array', ['assets/missing.pdf']],
  ['href nested object', { targets: [['assets/missing.pdf']] }],
] as const) for (const boundary of ['writer', 'verifier']) test(`structured resource context rejects missing ${label} at ${boundary}`, async () => {
  const input = await fixtureInput();
  const content = JSON.stringify([{ type: 'text', page_idx: 0, text: 'Paper', href }]);
  if (boundary === 'writer') {
    await writeFile(join(input.workspace, 'content-list.json'), content);
    await expect(writeArchiveV2(input)).rejects.toThrow();
  } else {
    const archive = await writeArchiveV2(input);
    await writeFile(join(archive.root, 'content-list.json'), content);
    const entry = archive.manifest.files.find(file => file.path === 'content-list.json')!;
    entry.sha256 = createHash('sha256').update(content).digest('hex'); entry.bytes = Buffer.byteLength(content);
    await writeFile(join(archive.root, 'manifest.json'), canonicalJson(archive.manifest));
    await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
  }
});

test('structured resource context retains existing href array and object payloads', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'document.md'), '# Paper');
  await writeFile(join(input.workspace, 'content-list.json'), JSON.stringify([
    { type: 'text', page_idx: 0, text: 'Paper', href: ['assets/figure.jpg', { targets: ['assets/figure.jpg'] }] },
  ]));
  const archive = await writeArchiveV2(input);
  expect((await verifyArchiveV2(archive.root)).payloads.has('assets/figure.jpg')).toBe(true);
});

for (const [label, srcset] of [
  ['missing density candidate', 'assets/figure.jpg 1x, assets/missing.jpg 2x'],
  ['escaping width candidate', 'assets/figure.jpg 320w, ../outside.jpg 640w'],
  ['nested missing candidate', [{ alternatives: ['assets/figure.jpg 1x, assets/missing.jpg 2x'] }]],
] as const) for (const boundary of ['writer', 'verifier']) test(`structured srcset rejects ${label} at ${boundary}`, async () => {
  const input = await fixtureInput();
  const content = JSON.stringify([{ type: 'text', page_idx: 0, text: 'Paper', srcset }]);
  if (boundary === 'writer') {
    await writeFile(join(input.workspace, 'content-list.json'), content);
    await expect(writeArchiveV2(input)).rejects.toThrow();
  } else {
    const archive = await writeArchiveV2(input);
    await writeFile(join(archive.root, 'content-list.json'), content);
    const entry = archive.manifest.files.find(file => file.path === 'content-list.json')!;
    entry.sha256 = createHash('sha256').update(content).digest('hex'); entry.bytes = Buffer.byteLength(content);
    await writeFile(join(archive.root, 'manifest.json'), canonicalJson(archive.manifest));
    await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
  }
});

test('structured srcset retains all existing candidates and their descriptors', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'assets', 'large.jpg'), 'large figure');
  await writeFile(join(input.workspace, 'document.md'), '# Paper');
  const content = [
    { type: 'text', page_idx: 0, text: 'Paper', srcset: 'assets/figure.jpg 1x, assets/large.jpg 2x' },
    { type: 'text', page_idx: 0, text: 'Paper', srcset: [{ alternatives: ['assets/figure.jpg 320w, assets/large.jpg 640w'] }] },
  ];
  await writeFile(join(input.workspace, 'content-list.json'), JSON.stringify(content));
  const archive = await writeArchiveV2(input);
  const verified = await verifyArchiveV2(archive.root);
  expect(verified.manifest.files.filter(file => file.path.startsWith('assets/')).map(file => file.path)).toEqual(['assets/figure.jpg', 'assets/large.jpg']);
  expect(verified.contentList).toEqual(content);
});

test('structured resource context survives normalization and verified installation', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'document.md'), '# Paper');
  await mkdir(join(input.workspace, 'images'));
  await writeFile(join(input.workspace, 'images', 'small.jpg'), 'small image');
  await writeFile(join(input.workspace, 'images', 'large.jpg'), 'large image');
  await writeFile(join(input.workspace, 'paper_content_list.json'), JSON.stringify([
    { type: 'text', page_idx: 0, text: 'Paper', href: [{ targets: ['images/small.jpg'] }],
      srcset: [{ alternatives: ['images/small.jpg 1x, images/large.jpg 2x'] }] },
  ]));
  const normalized = await normalizeLocalMinerUResult({ outputDir: input.workspace, model: 'pipeline', cliBackend: 'pipeline', pageCount: 1 });
  await copyFile(normalized.markdownPath, join(input.workspace, 'document.md'));
  await copyFile(normalized.contentListPath, join(input.workspace, 'content-list.json'));
  await copyFile(join(normalized.normalizedDir, 'pages.json'), join(input.workspace, 'pages.json'));
  const archive = await writeArchiveV2(input);
  const verified = await verifyArchiveV2(archive.root);
  expect(verified.contentList).toEqual([
    { type: 'text', page_idx: 0, text: 'Paper', href: [{ targets: ['assets/images/small.jpg'] }],
      srcset: [{ alternatives: ['assets/images/small.jpg 1x, assets/images/large.jpg 2x'] }] },
  ]);
  expect(verified.manifest.files.filter(file => file.path.startsWith('assets/')).map(file => file.path)).toEqual(['assets/images/large.jpg', 'assets/images/small.jpg']);
});

test('verification recalculates payload hashes and byte lengths', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  expect((await verifyArchiveV2(archive.root)).manifest.pdfSha256).toBe(archive.manifest.pdfSha256);
  await writeFile(join(archive.root, 'assets/figure.jpg'), 'forged');
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow(/hash|bytes/);
});

test('verification rejects noncanonical or invalid manifest schema and paths', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  const original = await readFile(join(archive.root, 'manifest.json'), 'utf8');
  const mutations = [
    (m: any) => { m.schemaVersion = 1; }, (m: any) => { m.extra = true; },
    (m: any) => { m.libraryId = '../fsd'; }, (m: any) => { m.sourceKind = 'web'; },
    (m: any) => { m.version = 0; }, (m: any) => { m.baseId = '../escape'; },
    (m: any) => { m.parser.version = ''; }, (m: any) => { m.parser.model = 'bad'; },
    (m: any) => { m.parser.method = 'bad'; }, (m: any) => { m.artifacts.pdf = 'other.pdf'; },
    (m: any) => { m.files.push(m.files[0]); }, (m: any) => { m.files[0].bytes = -1; },
    ...['/abs', '../escape', 'C:/abs', 'assets\\x', 'assets/x:stream', 'assets/CON', 'assets/a.'].map(path => (m: any) => { m.files[0].path = path; }),
    (m: any) => { m.files.push({ path: 'manifest.json', sha256: 'a'.repeat(64), bytes: 1 }); },
  ];
  for (const mutate of mutations) {
    const m = JSON.parse(original); mutate(m);
    await writeFile(join(archive.root, 'manifest.json'), JSON.stringify(m));
    await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
  }
  await writeFile(join(archive.root, 'manifest.json'), JSON.stringify(JSON.parse(original), null, 2));
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow(/canonical/);
});

test('verification requires the exact payload set and refuses reparse points', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  await writeFile(join(archive.root, 'middle.json'), '{}');
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow(/unexpected|forbidden/);
  await unlink(join(archive.root, 'middle.json'));
  await mkdir(join(archive.root, 'raw'));
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow(/unexpected|forbidden/);
  await rmdir(join(archive.root, 'raw'));
  const target = join(archive.root, 'linked');
  await symlink(join(archive.root, 'assets'), target, 'junction');
  try { await expect(verifyArchiveV2(archive.root)).rejects.toThrow(/link|reparse/); }
  finally { await unlink(target); }
  await unlink(join(archive.root, 'source.pdf'));
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
});

test('verification checks frozen metadata, PDF identity, page schema and resource closure', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  const originals = new Map<string, Buffer>();
  for (const path of ['source.json', 'source.pdf', 'pages.json', 'content-list.json', 'document.md']) {
    originals.set(path, await readFile(join(archive.root, path)));
  }
  const manifest = await readFile(join(archive.root, 'manifest.json'), 'utf8');
  for (const [path, content] of [
    ['source.json', canonicalJson({ ...archive.source, title: '' })],
    ['source.json', canonicalJson({ ...archive.source, unknown: true })],
    ['source.pdf', 'not a PDF'],
    ['pages.json', '[{"pageNumber":2,"text":"wrong page"}]'],
    ['pages.json', '[{"pageNumber":1,"text":"![missing](assets/missing.jpg)"}]'],
    ['pages.json', '[{"pageNumber":1,"text":"[escape](../outside.pdf)"}]'],
    ['content-list.json', '{}'], ['content-list.json', '[null]'], ['pages.json', '{'],
    ['document.md', '![missing](assets/missing.jpg)'],
    ['document.md', '![escape](C:/outside.jpg)'],
    ['document.md', '[download](assets/missing.jpg)'],
  ]) {
    await writeFile(join(archive.root, path), content);
    const m = JSON.parse(manifest);
    const entry = m.files.find((x: {path: string}) => x.path === path);
    entry.sha256 = createHash('sha256').update(content).digest('hex'); entry.bytes = Buffer.byteLength(content);
    await writeFile(join(archive.root, 'manifest.json'), canonicalJson(m));
    await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
    await writeFile(join(archive.root, path), originals.get(path)!);
  }
});

test('invalid staging is never installed and is retained under diagnostics', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'pages.json'), '{}');
  await expect(writeArchiveV2(input)).rejects.toThrow();
  expect(await Bun.file(join(input.paths.archiveRoot, '2601.00001-v1', 'manifest.json')).exists()).toBe(false);
  expect(await Bun.file(join(input.paths.workRoot, 'diagnostics', input.attemptId, 'pages.json')).exists()).toBe(true);
});

test('identical verified packages are reused and conflicts never overwrite', async () => {
  const input = await fixtureInput();
  const replay = join(input.paths.workRoot, 'parsing', 'attempt-2');
  await cp(input.workspace, replay, { recursive: true });
  const first = await writeArchiveV2(input);
  expect(await lstat(input.workspace).catch(() => null)).toBeNull();
  const stat = await lstat(join(first.root, 'manifest.json'));
  const second = await writeArchiveV2({ ...input, workspace: replay, attemptId: 'attempt-2' });
  expect(second.root).toBe(first.root);
  expect((await lstat(join(first.root, 'manifest.json'))).mtimeMs).toBe(stat.mtimeMs);
  const conflict = join(input.paths.workRoot, 'parsing', 'attempt-3');
  await cp(first.root, conflict, { recursive: true });
  await expect(writeArchiveV2({ ...input, workspace: conflict, attemptId: 'attempt-3', source: { ...input.source, title: 'Conflict' } })).rejects.toThrow(/conflict/i);
  expect((await verifyArchiveV2(first.root)).source.title).toBe('Frozen paper');
});

test('writer confines workspace, archive and diagnostic paths before touching them', async () => {
  const input = await fixtureInput();
  const outside = join(input.paths.dataRoot, 'outside');
  await cp(input.workspace, outside, { recursive: true });
  await expect(writeArchiveV2({ ...input, workspace: outside })).rejects.toThrow(/workspace|path/i);
  expect(await Bun.file(join(outside, 'source.pdf')).exists()).toBe(true);
  await expect(writeArchiveV2({ ...input, attemptId: '../escape' })).rejects.toThrow();
  await expect(writeArchiveV2({ ...input, paths: { ...input.paths, archiveRoot: outside } })).rejects.toThrow();
  const link = join(input.workspace, 'linked');
  await symlink(outside, link, 'junction');
  try { await expect(writeArchiveV2(input)).rejects.toThrow(/link|reparse/); }
  finally { await unlink(link); }
});

test('failed install or state commit leaves no partial target and retains diagnostics', async () => {
  for (const failure of ['rename', 'commit'] as const) {
    const input = await fixtureInput();
    await expect(writeArchiveV2({ ...input,
      install: failure === 'rename' ? async () => { throw new Error('install denied'); } : undefined,
      onInstalled: failure === 'commit' ? async () => { throw new Error('commit denied'); } : undefined,
    })).rejects.toThrow(/denied/);
    expect(await lstat(join(input.paths.archiveRoot, '2601.00001-v1')).catch(() => null)).toBeNull();
    expect(await Bun.file(join(input.paths.workRoot, 'diagnostics', input.attemptId, 'source.pdf')).exists()).toBe(true);
  }
});

test('competing writers cannot reuse an uncommitted package', async () => {
  const input = await fixtureInput();
  const replay = join(input.paths.workRoot, 'parsing', 'attempt-2');
  await cp(input.workspace, replay, { recursive: true });
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { reached = r; });
  const pending = new Promise<void>(r => { release = r; });
  const first = writeArchiveV2({ ...input, onInstalled: async () => { reached(); await pending; throw new Error('commit denied'); } });
  // Bun's rejection matcher may wait synchronously: attach a normal handler
  // now, and inspect the rejection only after releasing the commit barrier.
  const rejected = first.catch(error => error);
  await entered;
  let secondCompleted = false;
  const second = writeArchiveV2({ ...input, workspace: replay, attemptId: 'attempt-2' }).then(x => { secondCompleted = true; return x; });
  let raced: boolean;
  try {
    await new Promise(r => setTimeout(r, 100));
    raced = secondCompleted;
  } finally {
    release();
  }
  expect((await rejected).message).toBe('commit denied');
  const result = await second;
  expect(raced).toBe(false);
  expect((await verifyArchiveV2(result.root)).source.title).toBe('Frozen paper');
});

test('failed install never moves a replacement workspace into diagnostics', async () => {
  const input = await fixtureInput();
  await expect(writeArchiveV2({ ...input, install: async () => {
    await rename(input.workspace, input.workspace + '-held');
    await mkdir(input.workspace); await writeFile(join(input.workspace, 'marker'), 'external');
    throw new Error('install denied');
  } })).rejects.toThrow();
  expect(await readFile(join(input.workspace, 'marker'), 'utf8')).toBe('external');
});

test('verification rejects duplicate asset payloads even with valid hashes', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  const m = JSON.parse(await readFile(join(archive.root, 'manifest.json'), 'utf8'));
  const a = m.files.find((x: {path: string}) => x.path === 'assets/figure.jpg');
  await cp(join(archive.root, a.path), join(archive.root, 'assets/duplicate.jpg'));
  m.files.push({ ...a, path: 'assets/duplicate.jpg' });
  const markdown = '# Paper\n![a](assets/figure.jpg)\n![b](assets/duplicate.jpg)';
  await writeFile(join(archive.root, 'document.md'), markdown);
  Object.assign(m.files.find((x: {path: string}) => x.path === 'document.md'), {
    sha256: createHash('sha256').update(markdown).digest('hex'), bytes: Buffer.byteLength(markdown) });
  await writeFile(join(archive.root, 'manifest.json'), canonicalJson(m));
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow(/duplicate/);
});

test('verification rejects a hash-authenticated truncated PDF', async () => {
  const archive = await writeArchiveV2(await fixtureInput());
  const m = JSON.parse(await readFile(join(archive.root, 'manifest.json'), 'utf8'));
  const pdf = '%PDF-1.7\ntruncated';
  await writeFile(join(archive.root, 'source.pdf'), pdf);
  m.pdfSha256 = createHash('sha256').update(pdf).digest('hex');
  Object.assign(m.files.find((x: {path: string}) => x.path === 'source.pdf'), { sha256: m.pdfSha256, bytes: pdf.length });
  await writeFile(join(archive.root, 'manifest.json'), canonicalJson(m));
  await expect(verifyArchiveV2(archive.root)).rejects.toThrow();
});

test('writer rejects filesystem URI and HTML absolute references before installation', async () => {
  for (const reference of ['<img src=C:/outside.jpg>', '<source srcset="file:///C:/outside.jpg 1x">', '![a](file:///C:/outside.jpg)']) {
    const input = await fixtureInput();
    await writeFile(join(input.workspace, 'document.md'), reference);
    await expect(writeArchiveV2(input)).rejects.toThrow();
    expect(await lstat(join(input.paths.archiveRoot, '2601.00001-v1')).catch(() => null)).toBeNull();
  }
});

test('writer validates content-list records and page indices', async () => {
  for (const content of ['[{}]', '[{"type":"text","page_idx":-1}]', '[{"type":"text","page_idx":1}]']) {
    const input = await fixtureInput();
    await writeFile(join(input.workspace, 'content-list.json'), content);
    await expect(writeArchiveV2(input)).rejects.toThrow(/content-list/);
  }
});

test('intermediate basenames are forbidden even when referenced under assets', async () => {
  for (const name of ['origin.pdf', 'layout.pdf', 'span.pdf', 'middle.json', 'model.json', 'page-marked.txt']) {
    const input = await fixtureInput();
    await writeFile(join(input.workspace, 'assets', name), 'intermediate');
    await writeFile(join(input.workspace, 'document.md'), `![bad](assets/${name})`);
    await expect(writeArchiveV2(input)).rejects.toThrow(/manifest|forbidden/);
  }
});

test('writer includes resources referenced by ordinary Markdown links', async () => {
  const input = await fixtureInput();
  await writeFile(join(input.workspace, 'document.md'), '[figure](assets/figure.jpg)');
  expect((await writeArchiveV2(input)).manifest.files.some(x => x.path === 'assets/figure.jpg')).toBe(true);
});

test('rollback never moves an externally replaced installed directory', async () => {
  const input = await fixtureInput();
  const destination = join(input.paths.archiveRoot, '2601.00001-v1');
  await expect(writeArchiveV2({ ...input, onInstalled: async () => {
    await rename(destination, destination + '-held');
    await mkdir(destination); await writeFile(join(destination, 'marker'), 'external');
    throw new Error('commit denied');
  } })).rejects.toThrow();
  expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('external');
});
