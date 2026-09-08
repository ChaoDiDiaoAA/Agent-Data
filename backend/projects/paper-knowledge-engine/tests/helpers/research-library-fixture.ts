import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

export const researchFixtureId = 'research-fixture';

/**
 * Build an isolated layered config containing the generic Research contract.
 * The production Agent Engineering library is intentionally paper-only; these
 * fixtures keep the reusable Research implementation covered without reviving
 * Agent as a Research library.
 */
export function makeResearchFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'paper-engine-research-fixture-'));
  cpSync('config', join(root, 'config'), { recursive: true });
  cpSync(join(process.cwd(), 'tests', 'fixtures', 'research-library'), join(root, 'config', researchFixtureId), { recursive: true });
  const machinePath = join(root, 'config', 'machine.local.yaml');
  const machine = YAML.parse(readFileSync(machinePath, 'utf8')) as Record<string, unknown>;
  machine.roots = {
    data_libraries_root: join(root, 'data-libraries'),
    backup_libraries_root: join(root, 'backup-libraries'),
    pdf_libraries_root: join(root, 'pdf-libraries'),
    vaults_root: join(root, 'vaults'),
  };
  writeFileSync(machinePath, YAML.stringify(machine));
  return root;
}
