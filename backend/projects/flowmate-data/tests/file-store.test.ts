import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installImmutableFile, sha256File, writeCanonicalJson } from '../src/file-store.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flowmate-file-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function png(path: string, tail = 'image'): Promise<string> {
  await writeFile(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]));
  return sha256File(path);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('immutable file installation', () => {
  test('installs matching PNG bytes and treats a matching reinstall as idempotent', async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, 'first.png');
    const second = join(directory, 'second.png');
    const destination = join(directory, 'original.png');
    const sha256 = await png(first);
    await writeFile(second, await readFile(first));

    await installImmutableFile(first, destination, { sha256, mime_type: 'image/png' });
    await installImmutableFile(second, destination, { sha256, mime_type: 'image/png' });

    expect(await sha256File(destination)).toBe(sha256);
  });

  test('does not overwrite an installed original with different bytes', async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, 'first.png');
    const second = join(directory, 'second.png');
    const destination = join(directory, 'original.png');
    const sha256 = await png(first, 'first');
    const secondSha256 = await png(second, 'second');

    await installImmutableFile(first, destination, { sha256, mime_type: 'image/png' });
    await expect(installImmutableFile(second, destination, { sha256: secondSha256, mime_type: 'image/png' }))
      .rejects.toThrow('IMMUTABLE_FILE_CONFLICT');
    expect(await sha256File(destination)).toBe(sha256);
  });

  test('rejects a temporary file whose hash or MIME does not match before installation', async () => {
    const directory = await temporaryDirectory();
    const image = join(directory, 'image.png');
    const html = join(directory, 'error.html');
    await png(image);
    await writeFile(html, '<html><title>Access denied</title></html>');

    await expect(installImmutableFile(image, join(directory, 'wrong-hash.png'), {
      sha256: '0'.repeat(64), mime_type: 'image/png',
    })).rejects.toThrow('FILE_HASH_MISMATCH');
    await expect(installImmutableFile(html, join(directory, 'error-image.png'), {
      sha256: await sha256File(html), mime_type: 'image/png',
    })).rejects.toThrow('FILE_MIME_MISMATCH');
  });

  test('rejects arbitrary binary bytes claimed as Office document formats', async () => {
    const directory = await temporaryDirectory();
    const binary = join(directory, 'arbitrary.bin');
    await writeFile(binary, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const sha256 = await sha256File(binary);

    await expect(installImmutableFile(binary, join(directory, 'document.doc'), { sha256, mime_type: 'application/msword' }))
      .rejects.toThrow('FILE_MIME_MISMATCH');
    await expect(installImmutableFile(binary, join(directory, 'document.ofd'), { sha256, mime_type: 'application/ofd' }))
      .rejects.toThrow('FILE_MIME_MISMATCH');
  });

  test('validates temporary metadata even when the destination already contains matching bytes', async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, 'original.png');
    const first = join(directory, 'first.png');
    const second = join(directory, 'second.png');
    const sha256 = await png(first);
    await writeFile(second, await readFile(first));
    await installImmutableFile(first, destination, { sha256, mime_type: 'image/png' });

    await expect(installImmutableFile(second, destination, {
      sha256: '0'.repeat(64), mime_type: 'image/png',
    })).rejects.toThrow('FILE_HASH_MISMATCH');
  });

  test('does not replace a destination created between validation and installation', async () => {
    const directory = await temporaryDirectory();
    const temporary = join(directory, 'incoming.png');
    const destination = join(directory, 'original.png');
    const sha256 = await png(temporary, 'incoming');

    await expect(installImmutableFile(temporary, destination, { sha256, mime_type: 'image/png' }, {
      copyFile: async () => {
        await png(destination, 'raced');
        const error = Object.assign(new Error('already exists'), { code: 'EEXIST' });
        throw error;
      },
    })).rejects.toThrow('IMMUTABLE_FILE_CONFLICT');
    expect(await sha256File(destination)).not.toBe(sha256);
  });
});

test('writes canonical JSON through a temporary file and replacement', async () => {
  const directory = await temporaryDirectory();
  const destination = join(directory, 'record.json');

  await writeCanonicalJson(destination, { z: 1, a: { second: true, first: false } });

  expect(await readFile(destination, 'utf8')).toBe('{"a":{"first":false,"second":true},"z":1}\n');
});
