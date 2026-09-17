import type { DatasetFile, SourceConfig } from './contracts.ts';
import type { HttpClient } from './contracts.ts';

export interface TreeFile {
  path: string;
  bytes: number;
  source_oid?: string;
}

function fail(code: string): never { throw new Error(code); }

function safeSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) fail('SOURCE_PATH_INVALID');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part))) fail('SOURCE_PATH_INVALID');
  return value;
}

export function assertRevision(revision: string): void {
  if (!/^[a-f0-9]{40}$/.test(revision)) fail('INVALID_HUGGINGFACE_REVISION');
}

export function parseTreeEntries(value: unknown): TreeFile[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? ((value as Record<string, unknown>).siblings ?? (value as Record<string, unknown>).items ?? (value as Record<string, unknown>).tree)
      : undefined;
  if (!Array.isArray(raw)) fail('INVALID_HUGGINGFACE_TREE');
  const files: TreeFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('INVALID_HUGGINGFACE_TREE');
    const item = entry as Record<string, unknown>;
    if (item.type === 'directory' || item.type === 'tree') continue;
    if (item.type !== undefined && item.type !== 'file' && item.type !== 'blob') fail('INVALID_HUGGINGFACE_TREE');
    const path = safeSourcePath(item.path);
    if (!Number.isSafeInteger(item.size) || Number(item.size) < 0) fail('INVALID_HUGGINGFACE_TREE');
    const sourceOid = typeof item.oid === 'string' ? item.oid : undefined;
    files.push({ path, bytes: Number(item.size), ...(sourceOid ? { source_oid: sourceOid } : {}) });
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) fail('DUPLICATE_SOURCE_FILE');
    seen.add(file.path);
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function buildSourceFileUrl(template: string, revision: string, path: string): string {
  assertRevision(revision);
  const safePath = safeSourcePath(path);
  return template.replaceAll('{revision}', revision).replaceAll('{path}', safePath);
}

export function buildTreeUrl(template: string, revision: string): string {
  assertRevision(revision);
  return template.replaceAll('{revision}', revision);
}

export async function resolveHuggingFaceRevision(source: SourceConfig, http: HttpClient, maxBytes: number, timeoutMs: number): Promise<string> {
  const response = await http.get(source.revision.url, { maxBytes, timeoutMs, allowedOrigins: source.allowed_origins, redirectOrigins: source.redirect_origins });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(response.bytes)); } catch { fail('INVALID_HUGGINGFACE_REVISION'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).sha !== 'string') {
    fail('INVALID_HUGGINGFACE_REVISION');
  }
  const revision = (value as { sha: string }).sha;
  assertRevision(revision);
  return revision;
}

function nextLink(headers: Headers): string | undefined {
  const link = headers.get('link');
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

function treePayload(value: unknown): { entries: unknown; next?: string } {
  if (Array.isArray(value)) return { entries: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_HUGGINGFACE_TREE');
  const object = value as Record<string, unknown>;
  return {
    entries: object.items ?? object.siblings ?? object.tree,
    next: typeof object.next === 'string' ? object.next : undefined,
  };
}

export async function fetchRepositoryTree(source: SourceConfig, revision: string, http: HttpClient, maxBytes: number, timeoutMs: number): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  const seen = new Set<string>();
  let url: string | undefined = buildTreeUrl(source.tree_url_template, revision);
  for (let page = 0; url && page < 100; page += 1) {
    const response = await http.get(url, { maxBytes, timeoutMs, allowedOrigins: source.allowed_origins, redirectOrigins: source.redirect_origins });
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(response.bytes)); } catch { fail('INVALID_HUGGINGFACE_TREE'); }
    const payload = treePayload(value);
    for (const file of parseTreeEntries(payload.entries)) {
      if (seen.has(file.path)) fail('DUPLICATE_SOURCE_FILE');
      seen.add(file.path);
      files.push(file);
    }
    url = payload.next ?? nextLink(response.headers);
  }
  if (url) fail('HUGGINGFACE_TREE_PAGINATION_LIMIT');
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function toDatasetFiles(source: SourceConfig, revision: string, entries: TreeFile[]): DatasetFile[] {
  return entries.map(entry => ({
    ...entry,
    url: buildSourceFileUrl(source.file_url_template, revision, entry.path),
  }));
}
