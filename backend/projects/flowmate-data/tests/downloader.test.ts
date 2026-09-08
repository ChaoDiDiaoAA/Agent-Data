import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpClient, type ResearchHttpClient } from '../src/engine-bridge.ts';
import { createDownloader, downloadToTemp, type DownloadRequest } from '../src/downloader.ts';

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flowmate-downloader-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function serverFor(respond: () => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond });
  servers.push(server);
  return server;
}

function clientFor(server: ReturnType<typeof Bun.serve>): ResearchHttpClient {
  return createHttpClient({ fetch: async (url, options) => {
    const response = await fetch(`${server.url}${new URL(url).pathname}`, { method: 'GET', redirect: 'manual', signal: options.signal });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } });
}

function request(directory: string, patch: Partial<DownloadRequest> = {}): DownloadRequest {
  return {
    url: 'https://source.example/invoice.pdf?X-Amz-Signature=secret',
    source: { allowed_origins: ['https://source.example'], redirect_origins: [] },
    destination: join(directory, 'original.pdf'), temporaryPath: join(directory, 'original.pdf.part'),
    expectedMimeType: 'application/pdf', maxBytes: 1024,
    ...patch,
  };
}

afterEach(async () => {
  servers.splice(0).forEach(server => server.stop(true));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test('downloads a bounded PDF through a part file and records scrubbed provenance', async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from('%PDF-1.7\ninvoice');
  const server = serverFor(() => new Response(bytes, { headers: { 'content-type': 'application/pdf; charset=binary' } }));

  const receipt = await createDownloader({ http: clientFor(server) }).downloadToTemp(request(directory, { expectedSha256: sha256(bytes) }));

  expect(receipt).toEqual({
    stable_url: 'https://source.example/invoice.pdf', final_origin: 'https://source.example',
    bytes: bytes.byteLength, mime_type: 'application/pdf', sha256: sha256(bytes),
  });
  expect(await readFile(join(directory, 'original.pdf'))).toEqual(bytes);
  await expect(access(join(directory, 'original.pdf.part'))).rejects.toThrow();
});

test('records the final origin after an allowed redirect', async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from('%PDF-1.7\nredirected');
  let requests = 0;
  const client = createHttpClient({ fetch: async () => {
    requests += 1;
    return requests === 1
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/invoice.pdf' } })
      : new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  } });

  const receipt = await createDownloader({ http: client }).downloadToTemp(request(directory, {
    source: { allowed_origins: ['https://source.example'], redirect_origins: ['https://cdn.example'] },
  }));

  expect(receipt.final_origin).toBe('https://cdn.example');
  expect(receipt.stable_url).toBe('https://source.example/invoice.pdf');
});

test('rejects an oversized response without installing it', async () => {
  const directory = await temporaryDirectory();
  const server = serverFor(() => new Response(Buffer.from('%PDF-1.7\n'.padEnd(80, 'x')), { headers: { 'content-type': 'application/pdf' } }));

  await expect(createDownloader({ http: clientFor(server) }).downloadToTemp(request(directory, { maxBytes: 20 })))
    .rejects.toThrow('RESEARCH_RESPONSE_TOO_LARGE');
  await expect(access(join(directory, 'original.pdf'))).rejects.toThrow();
  await expect(access(join(directory, 'original.pdf.part'))).rejects.toThrow();
});

test('retries retryable HTTP failures at the injected backoff intervals', async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from('%PDF-1.7\nretry');
  let attempts = 0;
  const server = serverFor(() => {
    attempts += 1;
    return attempts < 4 ? new Response('busy', { status: 503 }) : new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  });
  const waits: number[] = [];

  await createDownloader({ http: clientFor(server), sleep: async milliseconds => { waits.push(milliseconds); } }).downloadToTemp(request(directory));

  expect(attempts).toBe(4);
  expect(waits).toEqual([250, 1000, 4000]);
});

test('retries connection interruptions', async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from('%PDF-1.7\nretry');
  let attempts = 0;
  const client = createHttpClient({ fetch: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('connection reset');
    return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  } });
  const waits: number[] = [];

  await createDownloader({ http: client, sleep: async milliseconds => { waits.push(milliseconds); } }).downloadToTemp(request(directory));

  expect(attempts).toBe(2);
  expect(waits).toEqual([250]);
});

test('serializes concurrent downloads from the same downloader', async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from('%PDF-1.7\nserialized');
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const client = createHttpClient({ fetch: async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 1) started();
    await held;
    active -= 1;
    return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  } });
  const downloader = createDownloader({ http: client });
  const first = downloader.downloadToTemp(request(directory, { destination: join(directory, 'first.pdf'), temporaryPath: join(directory, 'first.pdf.part') }));
  const second = downloader.downloadToTemp(request(directory, { destination: join(directory, 'second.pdf'), temporaryPath: join(directory, 'second.pdf.part') }));

  await firstStarted;
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(maximumActive).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(maximumActive).toBe(1);
});

test('serializes concurrent calls through the public downloader function', async () => {
  const directory = await temporaryDirectory();
  const bytes = Buffer.from('%PDF-1.7\npublic');
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = (async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 1) started();
    await held;
    active -= 1;
    return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  }) as unknown as typeof fetch;
  try {
    const first = downloadToTemp(request(directory, { destination: join(directory, 'public-first.pdf'), temporaryPath: join(directory, 'public-first.pdf.part') }));
    const second = downloadToTemp(request(directory, { destination: join(directory, 'public-second.pdf'), temporaryPath: join(directory, 'public-second.pdf.part') }));

    await firstStarted;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(maximumActive).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.each([401, 403])('does not retry HTTP %i', async status => {
  const directory = await temporaryDirectory();
  let attempts = 0;
  const server = serverFor(() => { attempts += 1; return new Response('denied', { status }); });

  await expect(createDownloader({ http: clientFor(server), sleep: async () => expect.unreachable() }).downloadToTemp(request(directory)))
    .rejects.toThrow('RESEARCH_HTTP_STATUS');
  expect(attempts).toBe(1);
});

test('does not retry MIME, magic, or hash failures', async () => {
  const directory = await temporaryDirectory();
  const cases = [
    { body: Buffer.from('%PDF-1.7\ntext'), contentType: 'text/plain', patch: {} },
    { body: Buffer.from('<html>denied</html>'), contentType: 'application/pdf', patch: {} },
    { body: Buffer.from('%PDF-1.7\nhash'), contentType: 'application/pdf', patch: { expectedSha256: '0'.repeat(64) } },
  ];
  for (const item of cases) {
    let attempts = 0;
    const server = serverFor(() => { attempts += 1; return new Response(item.body, { headers: { 'content-type': item.contentType } }); });
    await expect(createDownloader({ http: clientFor(server), sleep: async () => expect.unreachable() }).downloadToTemp(request(directory, item.patch)))
      .rejects.toThrow();
    expect(attempts).toBe(1);
  }
});
