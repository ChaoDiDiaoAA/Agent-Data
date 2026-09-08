import { createHash } from 'node:crypto';
import type { ResearchSourceKind } from '../types/research-sources.ts';
import { archivePath } from '../shared/archive-v2.ts';

export interface SourceIdentityInput {
  kind: ResearchSourceKind;
  canonicalUrl: string;
  contentSha256: string;
  revision?: string;
  arxivId?: string;
  commit?: string;
  tag?: string;
}

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function requireSourceKind(value: unknown): ResearchSourceKind {
  if (typeof value !== 'string' || !['paper', 'technical-report', 'official-doc', 'specification', 'repository', 'release', 'evaluation-method', 'local-artifact'].includes(value)) throw new TypeError('invalid research source kind');
  return value as ResearchSourceKind;
}
export function requireSourceHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError('invalid lowercase SHA-256');
  return value;
}
export function requireVersionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) throw new TypeError('invalid version ID');
  return archivePath(value);
}

export function normalizeSourceUrl(value: string): string {
  if (typeof value !== 'string' || /[\x00-\x20\x7f\\]/.test(value) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodeURIComponent(value)) || /%2f|%5c/i.test(value)) throw new TypeError('unsafe source URL');
  const url = new URL(value);
  const host = url.hostname;
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.') || host.includes(':') || /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|192\.0|198\.(18|19)|22[4-9]|23\d|24\d|25\d)\./.test(host)) throw new TypeError('unsafe source URL');
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.href.replace(/\/$/, '');
}

export function sourceIdentity(input: SourceIdentityInput) {
  requireSourceKind(input.kind);
  requireSourceHash(input.contentSha256);
  let canonicalUrl = input.kind === 'local-artifact' ? '' : normalizeSourceUrl(input.canonicalUrl);
  let identityKey = `doc:${canonicalUrl}`;
  let versionId = input.revision ?? `content-${input.contentSha256.slice(0, 16)}`;
  if (input.kind === 'local-artifact') identityKey = `local:${input.contentSha256}`;
  if (input.kind === 'repository' || input.kind === 'release') {
    if (input.commit !== undefined && !/^[0-9a-fA-F]{40}$/.test(input.commit)) throw new TypeError('invalid full repository commit');
    if (input.kind === 'release' && (!input.tag || input.commit)) throw new TypeError('release requires a tag');
    const url = new URL(canonicalUrl);
    url.protocol = 'https:';
    url.search = '';
    url.pathname = url.pathname.replace(/\.git$/, '');
    if (url.hostname === 'github.com') url.pathname = url.pathname.toLowerCase();
    canonicalUrl = url.href.replace(/\/$/, '');
    versionId = input.commit?.toLowerCase() ?? input.tag?.replace(/^refs\/tags\//, '') ?? '';
    identityKey = input.kind === 'release' ? `release:${canonicalUrl}:${versionId}` : `repo:${canonicalUrl}`;
  }
  if (['paper', 'technical-report'].includes(input.kind) && /^(export\.)?arxiv\.org$/.test(new URL(canonicalUrl).hostname)) {
    const id = input.arxivId ?? new URL(canonicalUrl).pathname.replace(/^\/(abs|pdf)\//, '').replace(/\.pdf$/, '');
    const match = id.toLowerCase().match(/^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})v([1-9]\d*)$/);
    if (!match) throw new Error('invalid arXiv version');
    identityKey = `arxiv:${match[1]}`;
    canonicalUrl = `https://arxiv.org/abs/${match[1]}`;
    versionId = `v${match[2]}`;
  }
  return { sourceId: sha256(identityKey).slice(0, 32), identityKey, canonicalUrl, versionId: requireVersionId(versionId) };
}
