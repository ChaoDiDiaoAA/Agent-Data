import type { PdfPage } from '../types/papers.ts';

export function assessExtraction(pages: Pick<PdfPage, 'text'>[], pdfMetadata: { pageCount?: number } | null, { isOcrAttempt = false } = {}) {
  const normalizedPages = Array.isArray(pages) ? pages : [];
  const text = normalizedPages.map((page) => page.text ?? '').join('');
  const reasons = [];
  if (text.length === 0) reasons.push('no_text');
  if (normalizedPages.length && normalizedPages.filter((page) => !page.text?.trim()).length / normalizedPages.length > 0.20) reasons.push('empty_page_ratio');
  if (text.length && (text.match(/�/g)?.length ?? 0) / text.length > 0.02) reasons.push('replacement_character_ratio');
  if (Number.isInteger(pdfMetadata?.pageCount) && normalizedPages.length !== pdfMetadata?.pageCount) reasons.push('page_count_mismatch');
  return {
    accepted: reasons.length === 0,
    reasons,
    retryWithOcr: reasons.length > 0 && !isOcrAttempt,
    terminalState: reasons.length === 0 ? 'parsed' : isOcrAttempt ? 'parse_failed' : 'retry_ocr',
  };
}

export function createOcrRetryJob<T extends { isOcr?: boolean }>(job: T) {
  if (job.isOcr) throw new Error('OCR retry already attempted');
  return { ...job, isOcr: true };
}
