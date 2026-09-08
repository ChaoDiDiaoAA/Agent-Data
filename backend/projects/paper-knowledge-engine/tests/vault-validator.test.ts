import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderEvidenceV3 } from '../src/evidence/layout-v3.ts';
import { vaultFixture } from './helpers/vault-fixture.ts';
import { canonicalJson } from '../src/shared/manifest.ts';
import { verifyArchiveV2 } from '../src/shared/archive-v2.ts';

async function api() {
  const path = '../src/evidence/vault-validator.ts';
  const mod = await import(path).catch(() => null);
  expect(mod?.validateVault).toBeFunction();
  return mod as typeof import('../src/evidence/vault-validator.ts');
}

test('validator refuses Archives changed since the caller verified them', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    const manifestPath = join(f.sources[0]!.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.parser.version = 'different'; await writeFile(manifestPath, canonicalJson(manifest));
    const changed = await verifyArchiveV2(f.sources[0]!.root);
    for (const file of renderEvidenceV3([changed])) await writeFile(join(f.input.vaultRoot, file.path), file.bytes);
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(i => i.kind === 'invalid_archive'));
  } finally { await f.close(); }
});

test('validator does not follow an Evidence asset junction', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await symlink(f.input.archiveRoot, join(f.input.vaultRoot, 'Evidence/papers/escape'), 'junction');
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.valid, false); assert.ok(report.issues.some(i => i.kind === 'unsafe_path'));
  } finally { await f.close(); }
});

test('validator rejects a case alias for the managed root', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await rename(join(f.input.vaultRoot, 'Evidence'), join(f.input.vaultRoot, 'temporary'));
    await rename(join(f.input.vaultRoot, 'temporary'), join(f.input.vaultRoot, 'evidence'));
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.valid, false); assert.ok(report.issues.some(i => i.kind === 'unsafe_path'));
  } finally { await f.close(); }
});

test('validator checks code-free local heading/block links without false broken-link reports', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), [
      '', '[heading](pages.md#page-1)', '[block](pages.md#^page-1)', '[[Evidence/papers/2601.00001-v1/pages#PAGE 1]]',
      '`[code](absent.md)`', '```markdown', '[example](absent.md)', '```',
      'Gemma 4 31B [37](a larger cloud model).', '[page](pages.md "page text")',
      '[CH3:19][C:4](=[O:23])[C@@H:13]1',
      '[parent](../../indexes/authors.md)', '<img srcset="assets/figure.png 1x, assets/figure.png 2x">',
    ].join('\n'));
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.brokenLinks, 0, JSON.stringify(report));
    assert.equal(report.valid, false); // Content bytes still correctly differ from the projection.
  } finally { await f.close(); }
});
test('validator ignores LF and CRLF prompt role labels while validating active reference definitions', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), [
      '', '[System]: You will answer the question.', '[User]: Question: What is the answer?',
      '[page][page-link]', '[page-link]: pages.md#page-1',
      '[missing][missing-ref]', '[missing-ref]: lost.md',
      '[unsafe][unsafe-ref]', '[unsafe-ref]: ../../../../outside.md',
    ].join('\n'));
    await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/pages.md'),
      '\r\n[System]: You will answer the question.\r\n[User]: Question: What is the answer?\r\n');
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.brokenLinks, 2, JSON.stringify(report));
    assert.deepEqual(report.issues.filter(issue => issue.kind === 'broken_link').map(issue => issue.target).sort(),
      ['../../../../outside.md', 'lost.md']);
  } finally { await f.close(); }
});
test('validator ignores an inactive definition after astral Unicode text', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'),
      `\n${'😀'.repeat(40)}\n[bad]: lost.md[x][bad]`);
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.brokenLinks, 0, JSON.stringify(report));
  } finally { await f.close(); }
});
async function fixture() {
  const f = await vaultFixture();
  for (const file of renderEvidenceV3(f.sources)) {
    await mkdir(dirname(join(f.input.vaultRoot, file.path)), { recursive: true });
    await writeFile(join(f.input.vaultRoot, file.path), file.bytes);
  }
  return f;
}
test('validator verifies the entire compact projection and ignores root manual files', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await writeFile(join(f.input.vaultRoot, 'manual.md'), '[[my non-managed notes]]');
    const result = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(result.valid, true); assert.equal(result.paperCount, 1); assert.equal(result.indexCount, 4);
    assert.deepEqual(result.issues, []);
  } finally { await f.close(); }
});
for (const [path, kind, action] of [
  ['Evidence/papers/2601.00001-v1/assets/figure.png', 'missing_asset', 'delete'],
  ['Evidence/papers/2601.00001-v1/assets/figure.png', 'asset_hash_mismatch', 'damage'],
  ['Evidence/papers/2601.00001-v1/source.pdf', 'pdf_hash_mismatch', 'damage'],
  ['Evidence/papers/2601.00001-v1/paper.md', 'missing_file', 'delete'],
  ['Evidence/indexes/authors.md', 'missing_index', 'delete'],
  ['Evidence/indexes/extra.md', 'unexpected_file', 'add'],
] as const) {
  test(`validator reports exact relative path for ${kind}`, async () => {
    const f = await fixture();
    try {
      const { validateVault } = await api();
      if (action === 'delete') await rm(join(f.input.vaultRoot, path));
      else await writeFile(join(f.input.vaultRoot, path), 'damaged');
      const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.equal(report.valid, false);
      assert.ok(report.issues.some(issue => issue.path === path && issue.kind === kind), JSON.stringify(report));
    } finally { await f.close(); }
  });
}
for (const link of ['[missing](lost.md)', '[[Evidence/papers/absent/paper]]', '<img src="assets/lost.png">',
  '[ref][missing]\n[missing]: lost.md', '[escape](../../../../outside.md)', '[escape](%2e%2e/%2e%2e/%2e%2e/secret)',
  '[drive](C:/outside.md)', '[anchor](pages.md#missing-heading)']) {
  test(`validator catches broken or unsafe references: ${link}`, async () => {
    const f = await fixture();
    try {
      const { validateVault } = await api();
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), '\n' + link);
      const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.equal(report.valid, false); assert.ok(report.brokenLinks > 0, JSON.stringify(report));
      assert.ok(report.issues.some(issue => issue.kind === 'broken_link' && issue.path.endsWith('/paper.md')));
    } finally { await f.close(); }
  });
}

for (const [html, broken] of [
  ['<a title="1 > 0" href="#absent-heading">missing</a>', 1],
  ['<a title=\'1 > 0\' HREF="#absent-heading">missing</a>', 1],
  ['<a data-href="#absent-heading">not a link</a>', 0],
  ['<span title=\'href="#absent-heading"\'>not an attribute</span>', 0],
  ['<img title="1 > 0" src="assets/missing.png">', 1],
  ['<img title="1 > 0" srcset="assets/figure.png 1x, assets/missing.png 2x">', 1],
  ['<a title="1 > 0" href="source.pdf">valid</a>', 0],
] as const) {
  test(`review R2: HTML closure recognizes complete quote-aware attributes: ${html}`, async () => {
    const f = await fixture();
    try {
      const { validateVault } = await api();
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), '\n' + html);
      const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.equal(report.brokenLinks, broken, JSON.stringify(report));
    } finally { await f.close(); }
  });
}

for (const [name, markdown, broken] of [
  ['real href between attribute backticks', '<a title="`" href="#absent-heading" data-note="`">broken</a>', 1],
  ['real src between attribute backticks', '<img title="`" src="assets/missing.png" data-note="`">', 1],
  ['real srcset between attribute backticks', '<img title="`" srcset="assets/figure.png 1x, assets/missing.png 2x" data-note="`">', 1],
  ['complete names only', '<a title="`" data-href="#absent-heading" data-note="`">text</a>', 0],
  ['quoted greater-than and valid href', '<a title="` >" href="source.pdf" data-note="`">valid</a>', 0],
  ['double-backtick code span', '``<a title="`" href="#absent-heading" data-note="`">example</a>``', 0],
  ['fenced HTML example', '```html\n<a title="`" href="#absent-heading" data-note="`">example</a>\n```', 0],
  ['malformed HTML in real inline code', '`<a title="unterminated href="#absent-heading">`', 0],
  ['multiline inline code', '`example\n<a href="#absent-heading">example</a>\nend`', 0],
  ['unmatched delimiters do not hide HTML', '``example <a href="#absent-heading">broken</a> `', 1],
  ['unmatched code cannot cross a paragraph boundary', '`unclosed\n\n<a title="`" href="#absent-heading" data-note="`">broken</a>', 1],
  ['escaped delimiters do not create code', '\\`<a href="#absent-heading">broken</a>\\`', 1],
  ['HTML attributes are not Markdown links', '<span title="[example](missing.md)">text</span>', 0],
  ['fence-looking attribute contents stay HTML', '<a title="\n```\n" href="#absent-heading" data-note="\n```\n">broken</a>', 1],
  ['real href after code', '`<a href="#example">code</a>` <a title="`" href="#absent-heading" data-note="`">broken</a>', 1],
] as const) {
  test(`review round 2: Markdown/HTML lexical boundary: ${name}`, async () => {
    const f = await fixture();
    try {
      const { validateVault } = await api();
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), '\n\n' + markdown);
      const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.equal(report.brokenLinks, broken, JSON.stringify(report));
    } finally { await f.close(); }
  });
}

for (const html of ['<a title="unterminated > href=\'#absent-heading\'>', '<a href="source.pdf"href="#absent-heading">',
  '<a href="source.pdf" href="#absent-heading">', '<img src>', '<a href="%2e%2e/%2e%2e/%2e%2e/secret">']) {
  test(`review R2: malformed/unsafe HTML resource syntax fails closed: ${html}`, async () => {
    const f = await fixture();
    try {
      const { validateVault } = await api();
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), '\n' + html);
      const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.ok(report.brokenLinks > 0, JSON.stringify(report));
    } finally { await f.close(); }
  });
}

for (const [headings, anchors, missing] of [
  ['Introduction\n============', ['introduction'], 'not-introduction'],
  ['Introduction\n------------', ['introduction'], 'not-introduction'],
  ['# `API` Usage', ['api-usage'], 'usage'],
  ['# **`API`** Usage', ['api-usage'], 'api'],
  ['# API Usage\n\n# API Usage\n\n# API Usage-1\n\n# API Usage',
    ['api-usage', 'api-usage-1', 'api-usage-1-1', 'api-usage-2'], 'api-usage-3'],
] as const) {
  test(`review R3: real heading text and duplicate slugs resolve: ${headings}`, async () => {
    const f = await fixture();
    try {
      const { validateVault } = await api();
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/pages.md'), '\n\n' + headings + '\n');
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), '\n' + anchors.map(anchor => `[heading](pages.md#${anchor})`).join('\n'));
      const valid = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.equal(valid.brokenLinks, 0, JSON.stringify(valid));
      await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), `\n[missing](pages.md#${missing})`);
      const invalid = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
      assert.equal(invalid.brokenLinks, 1, JSON.stringify(invalid));
    } finally { await f.close(); }
  });
}

test('review R3: fenced and indented code never creates heading anchors', async () => {
  const f = await fixture();
  try {
    const { validateVault } = await api();
    await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/pages.md'), '\n\n```md\n# Fake\n```\n\n    # Also Fake\n');
    await appendFile(join(f.input.vaultRoot, 'Evidence/papers/2601.00001-v1/paper.md'), '\n[x](pages.md#fake)\n[y](pages.md#also-fake)');
    const report = await validateVault({ vaultRoot: f.input.vaultRoot, sources: f.sources });
    assert.equal(report.brokenLinks, 2);
  } finally { await f.close(); }
});
