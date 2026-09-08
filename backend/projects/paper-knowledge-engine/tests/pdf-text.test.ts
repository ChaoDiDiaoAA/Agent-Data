import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinerUPages, renderPageMarkedText } from '../src/mineru/page-text.ts';
import { assessExtraction } from '../src/mineru/mineru-quality.ts';

test('renders zero-based page_idx as one-based markers', () => {
  const pages = normalizeMinerUPages([
    { page_idx: 1, type: 'text', text: 'second' },
    { page_idx: 0, type: 'text', text: 'first' },
  ]);
  assert.equal(renderPageMarkedText(pages), '--- PAGE 1 ---\nfirst\n\n--- PAGE 2 ---\nsecond');
});

test('preserves reference list items instead of treating reference-only pages as empty', () => {
  const pages = normalizeMinerUPages([
    { page_idx: 7, type: 'list', sub_type: 'ref_text', list_items: ['First reference.', 'Second reference.'] },
    { page_idx: 8, type: 'list', sub_type: 'ref_text', list_items: ['Last reference.'] },
  ]);
  assert.deepEqual(pages.map(page => [page.pageNumber, page.text]), [
    [8, 'First reference.\n\nSecond reference.'], [9, 'Last reference.'],
  ]);
});

test('nine-page extraction with two reference pages passes without relaxing empty-page limits', () => {
  const blocks: { page_idx: number; type: string; text?: string; sub_type?: string; list_items?: string[] }[] = Array.from({ length: 7 }, (_, page_idx) => ({ page_idx, type: 'text', text: 'Paper body.' }));
  blocks.push({ page_idx: 7, type: 'list', sub_type: 'ref_text', list_items: ['Reference page eight.'] });
  blocks.push({ page_idx: 8, type: 'list', sub_type: 'ref_text', list_items: ['Reference page nine.'] });
  const good = assessExtraction(normalizeMinerUPages(blocks), { pageCount: 9 });
  assert.equal(good.accepted, true);
  assert.deepEqual(good.reasons, []);
  const trulyEmpty = blocks.map(block => block.page_idx >= 7 ? { ...block, list_items: [] } : block);
  assert.deepEqual(assessExtraction(normalizeMinerUPages(trulyEmpty), { pageCount: 9 }).reasons, ['empty_page_ratio']);
});

test('preserves pipeline code, visual captions, bodies, and footnotes in reading order', () => {
  const pages = normalizeMinerUPages([
    { page_idx: 0, type: 'code', code_caption: ['Algorithm 1'], code_body: 'return result;', code_footnote: ['Code note.'] },
    { page_idx: 1, type: 'image', image_caption: ['Figure 1'], content: 'Diagram content.', image_footnote: ['Figure note.'], img_path: 'images/private.png' },
    { page_idx: 2, type: 'table', table_caption: ['Table 1'], table_body: '<table><tr><td>42</td></tr></table>', table_footnote: ['Table note.'] },
    { page_idx: 3, type: 'chart', chart_caption: ['Chart 1'], content: 'Chart content.', chart_footnote: ['Chart note.'] },
  ]);
  assert.deepEqual(pages.map(page => page.text), [
    'Algorithm 1\n\nreturn result;\n\nCode note.',
    'Figure 1\n\nDiagram content.\n\nFigure note.',
    'Table 1\n\n<table><tr><td>42</td></tr></table>\n\nTable note.',
    'Chart 1\n\nChart content.\n\nChart note.',
  ]);
});

test('metadata and malformed structured values cannot manufacture page evidence', () => {
  const pages = normalizeMinerUPages([
    { page_idx: 0, type: 'image', img_path: 'images/text-looking-name.png', bbox: [1, 2, 3, 4], title: 'not source text' },
    { page_idx: 1, type: 'list', list_items: [{ metadata: 'not text' }, null, 123, '   '] },
  ]);
  assert.deepEqual(pages.map(page => page.text), ['', '']);
  assert.equal(assessExtraction(pages, { pageCount: 2 }).accepted, false);
});

test('an already flattened VLM text field is not duplicated by fallback structured fields', () => {
  const pages = normalizeMinerUPages([{ page_idx: 0, type: 'list', text: 'Already flattened.', list_items: ['Already flattened.'] }]);
  assert.equal(pages[0].text, 'Already flattened.');
});
