import type { PdfPage } from '../types/papers.ts';

function blockText(block: Record<string, unknown>) {
  // VLM v2 is flattened before reaching this function; avoid duplicating it.
  if (typeof block?.text === 'string' && block.text.trim()) return block.text;
  // Pipeline v1 stores references, code and visual annotations outside `text`.
  // Only explicit source-content fields count; paths/metadata cannot fill a page.
  return [
    block?.image_caption, block?.table_caption, block?.chart_caption, block?.code_caption,
    block?.table_body, block?.code_body, block?.content, block?.latex, block?.list_items,
    block?.image_footnote, block?.table_footnote, block?.chart_footnote, block?.code_footnote,
  ].flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n\n');
}

export function normalizeMinerUPages(contentList: unknown): PdfPage[] {
  const byPage = new Map<number, string[]>();
  for (const block of Array.isArray(contentList) ? contentList : []) {
    if (!block || typeof block !== 'object' || Array.isArray(block) || typeof block.page_idx !== 'number' || !Number.isSafeInteger(block.page_idx) || block.page_idx < 0) continue;
    const blocks = byPage.get(block.page_idx) ?? [];
    blocks.push(blockText(block));
    byPage.set(block.page_idx, blocks);
  }
  return [...byPage.entries()].sort(([a], [b]) => a - b).map(([index, blocks]) => ({
    pageNumber: index + 1,
    text: blocks.filter(Boolean).join('\n\n'),
    blockCount: blocks.length,
  }));
}

export function renderPageMarkedText(pages: PdfPage[]): string {
  return pages.map((page) => `--- PAGE ${page.pageNumber} ---\n${page.text}`).join('\n\n');
}
