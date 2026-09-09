import { sampleDirectory, datasetTasks, datasetAlias } from '../src/layout.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPaths,
  loadSourceConfig,
  loadWorkbenchConfig,
  resolveOwnedPath,
  validatePaths,
  validateWorkbenchConfig,
} from '../src/config.ts';
import type { FlowmatePaths, SourceConfig, WorkbenchConfig } from '../src/contracts.ts';

const validPaths: FlowmatePaths = {
  projectRoot: 'D:\\agent-data\\backend\\projects\\flowmate-data',
  paperEngineRoot: 'D:\\agent-data\\backend\\projects\\paper-knowledge-engine',
  originalRoot: 'D:\\paper\\Invoice',
  dataRoot: 'D:\\agent-data\\data\\flowmate-data',
  vaultRoot: 'D:\\obsidian\\data\\flowmate-data',
  backupRoot: 'D:\\agent-data\\backups\\flowmate-data',
};

const validSource: SourceConfig = {
  schema_version: 1,
  source_id: 'public-invoices',
  dataset_id: 'public-invoices-2026',
  reader: 'public-files',
  homepage: 'https://example.test/invoices',
  revision: { kind: 'content-hash', url: 'https://example.test/invoices/manifest.json' },
  files: [{ id: 'sample-1', url: 'https://example.test/invoices/sample-1.pdf', document_kind: 'invoice', parse: true }],
  allowed_origins: ['https://example.test'],
  redirect_origins: [],
  declared_license: 'CC BY 4.0',
  license_evidence: 'https://example.test/license',
  retention: 'allowed',
  local_use: 'allowed',
  redistribution: 'allowed',
  origin_kind: 'public_redacted',
  language: 'en',
  document_kind: 'invoice',
};

const validWorkbench: WorkbenchConfig = {
  schema_version: 1,
  sample: {
    source_id: 'voxel51-invoice-ocr', dataset_id: 'voxel51-hq-invoice-ocr', selection_id: 'initial-20',
    acquire_limit: 20, publish_snapshot: true,
  },
  knowledge: { source_ids: [], parse_source_ids: [] },
  release: { version: 'public-invoice-p0-v1', include_originals: false },
  backup: { verify: true, restore_smoke: true },
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flowmate-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('path configuration', () => {
  test('accepts the confirmed absolute Windows roots', () => {
    expect(validatePaths(validPaths)).toEqual(validPaths);
  });

  test.each(Object.keys(validPaths) as Array<keyof FlowmatePaths>)('rejects a non-Windows-absolute %s', field => {
    expect(() => validatePaths({ ...validPaths, [field]: 'relative\\path' })).toThrow('PATH_NOT_ABSOLUTE');
  });

  test('rejects an original root nested in the data root', () => {
    expect(() => validatePaths({
      ...validPaths,
      originalRoot: 'D:\\agent-data\\data\\flowmate-data\\raw',
    })).toThrow('PATH_ROOTS_OVERLAP');
  });

  test('rejects roots that differ only by letter case', () => {
    expect(() => validatePaths({
      ...validPaths,
      vaultRoot: 'd:\\agent-data\\data\\flowmate-data',
    })).toThrow('PATH_ROOTS_OVERLAP');
  });

  test('rejects unknown path fields', () => {
    expect(() => validatePaths({ ...validPaths, extra: 'D:\\extra' })).toThrow('UNKNOWN_FIELD');
  });

  test('loads a closed paths object without creating configured roots', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'paths.json');
    await writeFile(configPath, JSON.stringify(validPaths));

    expect(loadPaths(configPath)).toEqual(validPaths);
  });
});

describe('owned relative paths', () => {
  test('resolves a safe relative reference inside its root', async () => {
    const root = await temporaryDirectory();
    expect(resolveOwnedPath(root, 'datasets/sample-1/record.json')).toBe(join(root, 'datasets', 'sample-1', 'record.json'));
  });

  test.each(['../outside.json', 'datasets/../../outside.json'])('rejects a reference that escapes with %s', async reference => {
    const root = await temporaryDirectory();
    expect(() => resolveOwnedPath(root, reference)).toThrow('PATH_TRAVERSAL');
  });

  test('rejects absolute references', async () => {
    const root = await temporaryDirectory();
    expect(() => resolveOwnedPath(root, 'D:\\outside.json')).toThrow('PATH_ABSOLUTE');
  });

  test('rejects control characters in references', async () => {
    const root = await temporaryDirectory();
    expect(() => resolveOwnedPath(root, 'datasets/sample\u0000.json')).toThrow('PATH_CONTROL_CHARACTER');
  });

  test('rejects C1 control characters in references', async () => {
    const root = await temporaryDirectory();
    expect(() => resolveOwnedPath(root, 'datasets/sample\u0085.json')).toThrow('PATH_CONTROL_CHARACTER');
  });

  test('rejects an existing symbolic link that leaves its root', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(root, 'datasets'));
    await symlink(outside, join(root, 'datasets', 'escape'), 'junction');

    expect(() => resolveOwnedPath(root, 'datasets/escape/record.json')).toThrow('PATH_SYMLINK_ESCAPE');
  });
});

describe('source configuration', () => {
  test('loads a closed source configuration object', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'source.json');
    await writeFile(configPath, JSON.stringify(validSource));

    expect(loadSourceConfig(configPath)).toEqual(validSource);
  });

  test('rejects unknown source configuration fields', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'source.json');
    await writeFile(configPath, JSON.stringify({ ...validSource, unexpected: true }));

    expect(() => loadSourceConfig(configPath)).toThrow('UNKNOWN_FIELD');
  });
});

describe('workbench configuration', () => {
  test('loads acquisition, processing, knowledge, release, and backup defaults', async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, 'workbench.json');
    await writeFile(configPath, JSON.stringify(validWorkbench));

    expect(loadWorkbenchConfig(configPath)).toEqual(validWorkbench);
  });

  test('rejects a parse source that is not enabled for acquisition', () => {
    expect(() => validateWorkbenchConfig({
      ...validWorkbench,
      knowledge: { ...validWorkbench.knowledge, parse_source_ids: ['not-enabled'] },
    })).toThrow('INVALID_CONFIG');
  });

  test('rejects unknown workbench fields', () => {
    expect(() => validateWorkbenchConfig({ ...validWorkbench, unexpected: true })).toThrow('UNKNOWN_FIELD');
  });

  test('rejects a separate parse limit because the current task has one quantity', () => {
    expect(() => validateWorkbenchConfig({ ...validWorkbench, sample: { ...validWorkbench.sample, parse_limit: 1 } })).toThrow('UNKNOWN_FIELD');
  });
});
