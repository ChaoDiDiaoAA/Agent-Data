import { expect, test } from 'bun:test';
import { buildSourceFileUrl, fetchRepositoryTree, parseTreeEntries } from '../src/huggingface.ts';
import { createSourceHttp } from '../src/http.ts';
import type { HttpClient, SourceConfig } from '../src/contracts.ts';

test('parses and sorts only safe file entries from a Hugging Face tree response', () => {
  expect(parseTreeEntries([
    { type: 'directory', path: 'nodes' },
    { type: 'file', path: 'nodes/submission.csv', size: 12, oid: 'abc' },
    { type: 'file', path: 'README.md', size: 3 },
  ])).toEqual([
    { path: 'README.md', bytes: 3, source_oid: undefined },
    { path: 'nodes/submission.csv', bytes: 12, source_oid: 'abc' },
  ]);
  expect(() => parseTreeEntries([{ type: 'file', path: '../escape.csv', size: 1 }])).toThrow('SOURCE_PATH_INVALID');
});

test('builds a revision-pinned raw file URL without encoding path separators', () => {
  const revision = 'a'.repeat(40);
  expect(buildSourceFileUrl(
    'https://huggingface.co/datasets/example/repo/resolve/{revision}/{path}',
    revision,
    'nodes/submission.csv',
  )).toBe('https://huggingface.co/datasets/example/repo/resolve/' + revision + '/nodes/submission.csv');
});

test('follows paginated repository trees from Link headers', async () => {
  const revision = 'c'.repeat(40);
  const source = {
    tree_url_template: 'https://huggingface.co/api/tree/{revision}',
    allowed_origins: ['https://huggingface.co'],
    redirect_origins: [],
  } as unknown as SourceConfig;
  let calls = 0;
  const http: HttpClient = {
    async get(url) {
      calls += 1;
      if (calls === 1) return {
        url,
        status: 200,
        headers: new Headers({ link: `<https://huggingface.co/api/tree/${revision}?cursor=next>; rel="next"` }),
        bytes: new TextEncoder().encode(JSON.stringify({ items: [{ type: 'file', path: 'b.csv', size: 2 }] })),
      };
      return {
        url,
        status: 200,
        headers: new Headers(),
        bytes: new TextEncoder().encode(JSON.stringify({ items: [{ type: 'file', path: 'a.csv', size: 1 }] })),
      };
    },
  };
  expect(await fetchRepositoryTree(source, revision, http, 1024, 1000)).toEqual([
    { path: 'a.csv', bytes: 1 },
    { path: 'b.csv', bytes: 2 },
  ]);
  expect(calls).toBe(2);
});

test('follows Hugging Face cache redirects with encoded repository paths', async () => {
  const revision = 'b'.repeat(40);
  const source: SourceConfig = {
    schema_version: 1,
    source_id: 'example',
    dataset_id: 'regulatory-affairs',
    repository: 'example/repo',
    homepage: 'https://huggingface.co/datasets/example/repo',
    revision: { kind: 'huggingface-api' as const, url: 'https://huggingface.co/api/datasets/example/repo' },
    tree_url_template: 'https://huggingface.co/api/datasets/example/repo/tree/{revision}',
    file_url_template: 'https://huggingface.co/datasets/example/repo/resolve/{revision}/{path}',
    allowed_origins: ['https://huggingface.co'],
    redirect_origins: ['https://us.aws.cdn.hf.co'],
    declared_license: 'unknown',
    license_evidence: 'https://huggingface.co/datasets/example/repo',
    data_kind: 'test',
    origin_kind: 'public_document' as const,
    retention: 'unknown' as const,
    local_use: 'allowed' as const,
    redistribution: 'unknown' as const,
    language: 'en',
    enabled: true,
  };
  let calls = 0;
  const client = createSourceHttp(source, {
    fetch: async (url) => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 307, headers: { location: `/api/resolve-cache/datasets/example/repo/${revision}/edges%2Fclassified_as.csv` } });
      expect(url).toContain('/api/resolve-cache/');
      return new Response(new TextEncoder().encode('src,tgt\n1,2\n'), { status: 200, headers: { 'content-length': '12' } });
    },
  });
  const result = await client.get(`https://huggingface.co/datasets/example/repo/resolve/${revision}/edges/classified_as.csv`, {
    maxBytes: 1024,
    timeoutMs: 1000,
    allowedOrigins: source.allowed_origins,
    redirectOrigins: source.redirect_origins,
  });
  expect(new TextDecoder().decode(result.bytes)).toBe('src,tgt\n1,2\n');
  expect(calls).toBe(2);
  const rejected = createSourceHttp(source, {
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file.csv' } }),
  });
  await expect(rejected.get(`https://huggingface.co/datasets/example/repo/resolve/${revision}/file.csv`, {
    maxBytes: 1024,
    timeoutMs: 1000,
    allowedOrigins: source.allowed_origins,
    redirectOrigins: source.redirect_origins,
  })).rejects.toMatchObject({ code: 'RESEARCH_REDIRECT_REJECTED' });
});
