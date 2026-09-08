import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function readYaml(path: string): Record<string, unknown> {
  return record(YAML.parse(readFileSync(path, 'utf8')) ?? {}, path);
}

/** Migration-only input adapter for fixtures that have not moved to layered configuration. */
export function readLegacyProjectPaths(root: string): Record<string, unknown> {
  const local = join(root, 'config', 'paths.local.yaml');
  return readYaml(existsSync(local) ? local : join(root, 'config', 'paths.example.yaml'));
}

/** Migration-only input adapter for fixtures that have not moved to layered configuration. */
export function readLegacyRuntime(root: string): Record<string, unknown> {
  return readYaml(join(root, 'config', 'runtime.yaml'));
}

/** Migration-only input adapter for fixtures that have not moved to layered configuration. */
export function readLegacyEvidencePolicy(root: string): Record<string, unknown> {
  return readYaml(join(root, 'config', 'evidence-policy.yaml'));
}

/** Migration-only input adapter for fixtures that have not moved to layered configuration. */
export function readLegacyPipeline(root: string): Record<string, unknown> {
  return readYaml(join(root, 'config', 'pipeline.yaml'));
}

/** Migration-only test adapter for the retired standalone paper-policy document. */
export function readLegacyPaperPolicy(path: string): Record<string, unknown> {
  return readYaml(path);
}
