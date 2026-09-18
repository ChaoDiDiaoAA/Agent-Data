import type { PdfPage } from '../types/papers.ts';

export interface ExtractionAssessmentOptions {
  isOcrAttempt?: boolean;
  /** Pages whose text is empty but whose visual asset was preserved and validated. */
  visualOnlyPages?: readonly number[];
  /** Pages with a visual block that has no usable asset; table recognition may be the cause. */
  visualBlockPages?: readonly number[];
}

export function assessExtraction(
  pages: Array<Pick<PdfPage, 'text'> & Partial<Pick<PdfPage, 'pageNumber'>>>,
  pdfMetadata: { pageCount?: number } | null,
  { isOcrAttempt = false, visualOnlyPages = [], visualBlockPages = [] }: ExtractionAssessmentOptions = {},
) {
  const normalizedPages = Array.isArray(pages) ? pages : [];
  const text = normalizedPages.map((page) => page.text ?? '').join('');
  const reasons = [];
  const visualOnly = new Set(visualOnlyPages.filter((page) => Number.isSafeInteger(page) && page >= 1));
  const visualBlocks = new Set(visualBlockPages.filter((page) => Number.isSafeInteger(page) && page >= 1));
  const emptyPages = normalizedPages
    .map((page, index) => ({ page, pageNumber: page.pageNumber ?? index + 1 }))
    .filter(({ page }) => !page.text?.trim());
  const uncoveredEmptyPages = emptyPages.filter(({ pageNumber }) => !visualOnly.has(pageNumber));
  const visualOnlyPageNumbers = emptyPages
    .map(({ pageNumber }) => pageNumber)
    .filter((pageNumber) => visualOnly.has(pageNumber));
  if (text.length === 0 && (normalizedPages.length === 0 || visualOnlyPageNumbers.length < normalizedPages.length)) reasons.push('no_text');
  if (normalizedPages.length && uncoveredEmptyPages.length / normalizedPages.length > 0.20) reasons.push('empty_page_ratio');
  if (text.length && (text.match(/�/g)?.length ?? 0) / text.length > 0.02) reasons.push('replacement_character_ratio');
  if (Number.isInteger(pdfMetadata?.pageCount) && normalizedPages.length !== pdfMetadata?.pageCount) reasons.push('page_count_mismatch');
  const retryWithTableDisabled = reasons.includes('empty_page_ratio')
    && [...visualBlocks].some((pageNumber) => uncoveredEmptyPages.some((page) => page.pageNumber === pageNumber));
  return {
    accepted: reasons.length === 0,
    reasons,
    retryWithOcr: reasons.length > 0 && !isOcrAttempt,
    retryWithTableDisabled,
    visualOnlyPages: visualOnlyPageNumbers,
    warnings: visualOnlyPageNumbers.length > 0 ? [`visual_only_pages:${visualOnlyPageNumbers.join(',')}`] : [],
    terminalState: reasons.length === 0 ? 'parsed' : isOcrAttempt ? 'parse_failed' : 'retry_ocr',
  };
}

export function createOcrRetryJob<T extends { isOcr?: boolean }>(job: T) {
  if (job.isOcr) throw new Error('OCR retry already attempted');
  return { ...job, isOcr: true };
}
