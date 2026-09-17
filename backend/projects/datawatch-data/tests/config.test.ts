import { describe, expect, test } from 'bun:test';
import { validatePaths, validateSourceConfig, validateWorkbenchConfig } from '../src/config.ts';

describe('DataWatch configuration', () => {
  test('accepts independent absolute roots and a dataset source', () => {
    const paths = validatePaths({
      projectRoot: 'D:\\agent-data\\backend\\projects\\datawatch-data',
      paperEngineRoot: 'D:\\agent-data\\backend\\projects\\paper-knowledge-engine',
      originalRoot: 'D:\\paper\\DataWatch',
      dataRoot: 'D:\\agent-data\\data\\datawatch-data',
      vaultRoot: 'D:\\obsidian\\data\\datawatch-data',
      backupRoot: 'D:\\agent-data\\backups\\datawatch-data',
    });
    expect(paths.originalRoot).toContain('DataWatch');
    const source = validateSourceConfig({
      schema_version: 1,
      source_id: 'regulatory-affairs',
      dataset_id: 'regulatory-affairs',
      repository: 'VaidhyaMegha/regulatory-affairs-kg',
      homepage: 'https://huggingface.co/datasets/VaidhyaMegha/regulatory-affairs-kg',
      revision: { kind: 'huggingface-api', url: 'https://huggingface.co/api/datasets/VaidhyaMegha/regulatory-affairs-kg' },
      tree_url_template: 'https://huggingface.co/api/datasets/VaidhyaMegha/regulatory-affairs-kg/tree/{revision}?recursive=true',
      file_url_template: 'https://huggingface.co/datasets/VaidhyaMegha/regulatory-affairs-kg/resolve/{revision}/{path}',
      allowed_origins: ['https://huggingface.co'],
      redirect_origins: ['https://cas-bridge.xethub.hf.co'],
      declared_license: 'US government public domain',
      license_evidence: 'https://open.fda.gov/terms/',
      data_kind: 'public-device-regulatory',
      origin_kind: 'public_document',
      retention: 'allowed',
      local_use: 'allowed',
      redistribution: 'allowed',
      language: 'en',
    });
    expect(source.dataset_id).toBe('regulatory-affairs');
  });

  test('rejects overlapping roots and unknown source fields', () => {
    expect(() => validatePaths({
      projectRoot: 'D:\\agent-data\\backend\\projects\\datawatch-data',
      paperEngineRoot: 'D:\\agent-data\\backend\\projects\\paper-knowledge-engine',
      originalRoot: 'D:\\agent-data\\data\\datawatch-data\\original',
      dataRoot: 'D:\\agent-data\\data\\datawatch-data',
      vaultRoot: 'D:\\obsidian\\data\\datawatch-data',
      backupRoot: 'D:\\agent-data\\backups\\datawatch-data',
    })).toThrow('PATH_ROOTS_OVERLAP');
    expect(() => validateSourceConfig({ schema_version: 1, source_id: 'x', unexpected: true })).toThrow('UNKNOWN_FIELD');
  });

  test('requires a non-empty enabled dataset list', () => {
    expect(validateWorkbenchConfig({
      schema_version: 1,
      enabled_dataset_ids: ['regulatory-affairs', 'fda-recalls'],
      publish_snapshot: true,
      max_response_bytes: 32 * 1024 * 1024,
      request_timeout_ms: 30_000,
    }).enabled_dataset_ids).toEqual(['regulatory-affairs', 'fda-recalls']);
    expect(() => validateWorkbenchConfig({
      schema_version: 1,
      enabled_dataset_ids: [],
      publish_snapshot: true,
      max_response_bytes: 1,
      request_timeout_ms: 1,
    })).toThrow('INVALID_CONFIG');
  });
});
