import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMenu, type MenuOptions } from '../src/cli.ts';

const validPaths = {
  projectRoot: 'D:\\agent-data\\backend\\projects\\flowmate-data',
  paperEngineRoot: 'D:\\agent-data\\backend\\projects\\paper-knowledge-engine',
  originalRoot: 'D:\\paper\\Invoice',
  dataRoot: 'D:\\agent-data\\data\\flowmate-data',
  vaultRoot: 'D:\\obsidian\\data\\flowmate-data',
  backupRoot: 'D:\\agent-data\\backups\\flowmate-data',
};

const temporaryDirectories: string[] = [];

async function menuFixture(acquireLimit: number, parseLimit: number): Promise<{ pathsPath: string; configPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'flowmate-menu-'));
  temporaryDirectories.push(directory);
  const pathsPath = join(directory, 'paths.json');
  const configPath = join(directory, 'workbench.json');
  await writeFile(pathsPath, JSON.stringify(validPaths));
  await writeFile(configPath, JSON.stringify({
    schema_version: 1,
    sample: {
      source_id: 'voxel51-invoice-ocr',
      dataset_id: 'voxel51-hq-invoice-ocr',
      selection_id: 'initial-20',
      acquire_limit: acquireLimit,
      parse_limit: parseLimit,
      publish_snapshot: false,
    },
    knowledge: { source_ids: [], parse_source_ids: [] },
    release: { version: 'public-invoice-p0-v1', include_originals: false },
    backup: { verify: false, restore_smoke: false },
  }));
  return { pathsPath, configPath };
}

function fakeOutput(lines: string[]): MenuOptions['output'] {
  return {
    write(value: string) {
      lines.push(value);
      return true;
    },
  };
}

async function runChoice(choice: string, acquireLimit = 7, parseLimit = 3): Promise<{ commands: string[][]; output: string }> {
  const { pathsPath, configPath } = await menuFixture(acquireLimit, parseLimit);
  const answers = [choice, '0'];
  const commands: string[][] = [];
  const lines: string[] = [];
  await runMenu({
    pathsPath,
    configPath,
    ask: async () => answers.shift()!,
    output: fakeOutput(lines),
    execute: async args => {
      commands.push(args);
      return 0;
    },
  });
  return { commands, output: lines.join('') };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('interactive CLI menu', () => {
  test('reads acquire_limit from workbench config and does not add a manual limit', async () => {
    const result = await runChoice('3', 7, 3);

    expect(result.output).toContain('数据集发票总量：8181');
    expect(result.output).toContain('可采集的带标注发票：1489');
    expect(result.output).toContain('本次获取数量（来自 config）：7');
    expect(result.output).toContain('3. 获取发票（7 条）');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual(expect.arrayContaining(['acquire', 'voxel51-invoice-ocr']));
    expect(result.commands[0]).not.toContain('--limit');
  });

  test('reads parse_limit from workbench config and does not add a manual limit', async () => {
    const result = await runChoice('5', 7, 3);

    expect(result.output).toContain('本次解析数量（来自 config）：3');
    expect(result.output).toContain('5. MinerU 解析（3 条）');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toEqual(expect.arrayContaining(['parse']));
    expect(result.commands[0]).not.toContain('--limit');
  });

  test('maps verification and backup entries to the correct commands', async () => {
    const verification = await runChoice('8');
    expect(verification.commands[0]).toEqual(expect.arrayContaining(['release', 'verify', 'public-invoice-p0-v1']));
    expect(verification.commands[1]).toEqual(expect.arrayContaining(['verify']));

    const backup = await runChoice('9');
    expect(backup.commands).toHaveLength(1);
    expect(backup.commands[0]).toEqual(expect.arrayContaining(['backup', 'create']));
  });
});
