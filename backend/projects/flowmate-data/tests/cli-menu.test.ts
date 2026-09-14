import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMenu, type MenuOptions } from '../src/cli.ts';
import { hashCanonical } from '../src/engine-bridge.ts';

const temporaryDirectories: string[] = [];

async function menuFixture(acquireLimit: number): Promise<{ pathsPath: string; configPath: string; dataRoot: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'flowmate-menu-'));
  temporaryDirectories.push(directory);
  const pathsPath = join(directory, 'paths.json');
  const configPath = join(directory, 'workbench.json');
  const configuredPaths = {
    projectRoot: join(import.meta.dir, '..'),
    paperEngineRoot: join(directory, 'engine'),
    originalRoot: join(directory, 'original'),
    dataRoot: join(directory, 'data'),
    vaultRoot: join(directory, 'vault'),
    backupRoot: join(directory, 'backup'),
  };
  await writeFile(pathsPath, JSON.stringify(configuredPaths));
  await writeFile(configPath, JSON.stringify({
    schema_version: 1,
    sample: {
      source_id: 'voxel51-invoice-ocr',
      dataset_id: 'voxel51-hq-invoice-ocr',
      selection_id: 'initial-20',
      acquire_limit: acquireLimit,
      publish_snapshot: false,
    },
    knowledge: { source_ids: [], parse_source_ids: [] },
    release: { version: 'public-invoice-p0-v1', include_originals: false },
    backup: { verify: false, restore_smoke: false },
  }));
  return { pathsPath, configPath, dataRoot: configuredPaths.dataRoot };
}

function fakeOutput(lines: string[]): MenuOptions['output'] {
  return {
    write(value: string) {
      lines.push(value);
      return true;
    },
  };
}

async function runChoice(choice: string, acquireLimit = 7): Promise<{ commands: string[][]; output: string }> {
  const { pathsPath, configPath } = await menuFixture(acquireLimit);
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
  test('defers source and task details until option 1 is selected', async () => {
    const result = await runChoice('0', 7);

    expect(result.output).toContain('FlowmateData（Bun CLI）');
    expect(result.output).toContain('[任务] voxel51-hq-invoice-ocr / initial-20');
    expect(result.output).toContain('1. 查看来源和任务配置');
    expect(result.output).not.toContain('路径配置：');
    expect(result.output).not.toContain('当前来源：');
  });

  test('shows one task quantity for acquisition and parsing', async () => {
    const result = await runChoice('1', 7);

    expect(result.output).toContain('[数据集] 总量 8181 条，可标注 1489 条');
    expect(result.output).toContain('[说明] 获取与 MinerU 解析使用同一批 7 条发票');
    expect(result.output).toContain('[配置]');
    expect(result.output).toContain('2. 执行当前任务（获取并解析 7 条）');
    expect(result.output).not.toContain('parse_limit');
  });

  test('runs the complete current task with the configured quantity and no manual limit', async () => {
    const result = await runChoice('2', 7);

    expect(result.commands).toHaveLength(9);
    expect(result.commands[0]).toEqual(expect.arrayContaining(['source', 'probe', 'voxel51-invoice-ocr']));
    expect(result.commands[1]).toEqual(expect.arrayContaining(['acquire', 'voxel51-invoice-ocr']));
    expect(result.commands[2]).toEqual(expect.arrayContaining(['labels', 'map', 'voxel51-hq-invoice-ocr']));
    expect(result.commands[3]).toEqual(expect.arrayContaining(['parse']));
    expect(result.commands[4]).toEqual(expect.arrayContaining(['catalog', 'build']));
    expect(result.commands[5]).toEqual(expect.arrayContaining(['release', 'build', 'public-invoice-p0-v1']));
    expect(result.commands[6]).toEqual(expect.arrayContaining(['release', 'verify', 'public-invoice-p0-v1']));
    expect(result.commands[7]).toEqual(expect.arrayContaining(['verify']));
    expect(result.commands[8]).toEqual(expect.arrayContaining(['backup', 'create']));
    expect(result.commands.every(command => !command.includes('--limit'))).toBe(true);
    expect(result.output).toContain('[任务] current / voxel51-hq-invoice-ocr / initial-20 开始');
    expect(result.output).toContain('[配置]');
    expect(result.output).toContain('[说明] 获取与 MinerU 解析使用同一批 7 条发票');
    expect(result.output).toContain('[探测 1/8] 探测公开来源 开始');
    expect(result.output).toContain('[备份 8/8] 创建备份 完成');
    expect(result.output).toContain('[任务] 完成');
    expect(result.output).not.toContain('"source_id"');
    expect(result.output).not.toContain('"selection_hash"');
  });

  test('prints each invoice progress while the MinerU step is running', async () => {
    const { pathsPath, configPath } = await menuFixture(2);
    const answers = ['2', '0'];
    const lines: string[] = [];
    await runMenu({
      pathsPath,
      configPath,
      ask: async () => answers.shift()!,
      output: fakeOutput(lines),
      execute: async (args, executeOptions) => {
        if (args[0] === 'parse') {
          const onProgress = executeOptions?.parseDependencies?.onProgress;
          await onProgress?.({ index: 1, total: 2, sampleId: 'invoice-a', status: 'started', elapsedMs: 0 });
          await onProgress?.({ index: 1, total: 2, sampleId: 'invoice-a', status: 'completed', elapsedMs: 1_234 });
          await onProgress?.({ index: 2, total: 2, sampleId: 'invoice-b', status: 'started', elapsedMs: 0 });
        }
        return 0;
      },
    });
    const output = lines.join('');
    expect(output).toContain('[发票 1/2] invoice-a 开始（MinerU）');
    expect(output).toContain('[发票 1/2] invoice-a 完成（耗时 00:01）');
    expect(output).toContain('[发票 2/2] invoice-b 开始（MinerU）');
  });

  test('prints each invoice progress while the acquisition step is running', async () => {
    const { pathsPath, configPath } = await menuFixture(2);
    const answers = ['2', '0'];
    const lines: string[] = [];
    await runMenu({
      pathsPath,
      configPath,
      ask: async () => answers.shift()!,
      output: fakeOutput(lines),
      execute: async (args, executeOptions) => {
        if (args[0] === 'acquire') {
          const onProgress = executeOptions?.acquireProgress;
          await onProgress?.({ index: 1, total: 2, sampleId: 'invoice-a', annotationStatus: 'annotated', status: 'started', elapsedMs: 0 });
          await onProgress?.({ index: 1, total: 2, sampleId: 'invoice-a', annotationStatus: 'annotated', status: 'completed', elapsedMs: 1_234 });
          await onProgress?.({ index: 2, total: 2, sampleId: 'invoice-b', annotationStatus: 'unannotated', status: 'started', elapsedMs: 0 });
        }
        return 0;
      },
    });
    const output = lines.join('');
    expect(output).toContain('[发票 1/2] invoice-a 开始（获取，带标注）');
    expect(output).toContain('[发票 1/2] invoice-a 完成（获取，带标注，耗时 00:01）');
    expect(output).toContain('[发票 2/2] invoice-b 开始（获取，无标注）');
  });

  test('prints concise start and completion lines for each Obsidian invoice', async () => {
    const { pathsPath, configPath } = await menuFixture(2);
    const answers = ['2', '0'];
    const lines: string[] = [];
    await runMenu({
      pathsPath,
      configPath,
      ask: async () => answers.shift()!,
      output: fakeOutput(lines),
      execute: async (args, executeOptions) => {
        if (args[0] === 'catalog') {
          await executeOptions?.catalogProgress?.({ phase: 'sample-assets', status: 'started', current: 1, total: 2, item: '000001', elapsedMs: 0 });
          await executeOptions?.catalogProgress?.({ phase: 'sample-assets', status: 'completed', current: 1, total: 2, item: '000001', elapsedMs: 1_234 });
          await executeOptions?.catalogProgress?.({ phase: 'sample-assets', status: 'started', current: 2, total: 2, item: '000002', elapsedMs: 0 });
          await executeOptions?.catalogProgress?.({ phase: 'sample-assets', status: 'completed', current: 2, total: 2, item: '000002', elapsedMs: 2_345 });
          await executeOptions?.catalogProgress?.({ phase: 'publish', status: 'started', current: 0, total: 10, elapsedMs: 0 });
          await executeOptions?.catalogProgress?.({ phase: 'publish', status: 'completed', current: 10, total: 10, elapsedMs: 3_456 });
          executeOptions?.print?.({ files: 6, samples: 2, current_task_samples: 2 });
        }
        return 0;
      },
    });
    const output = lines.join('');
    expect(output).toContain('[Obsidian 5/8] 构建 Obsidian 目录 开始');
    expect(output).toContain('[Obsidian] 000001 开始');
    expect(output).toContain('[Obsidian] 000001 完成（耗时 00:01）');
    expect(output).toContain('[Obsidian] 000002 开始');
    expect(output).toContain('[Obsidian] 000002 完成（耗时 00:02）');
    expect(output).toContain('[Obsidian] 写入目录 开始');
    expect(output).toContain('[Obsidian] 写入目录 完成');
    expect(output).toContain('[Obsidian 5/8] 构建 Obsidian 目录 完成：当前任务样本 2 条，写入 6 个文件');
    expect(output).not.toContain('[Obsidian] 目录资产');
  });

  test('maps verify and backup entries to the correct commands', async () => {
    const verification = await runChoice('3');
    expect(verification.commands).toHaveLength(2);
    expect(verification.commands[0]).toEqual(expect.arrayContaining(['release', 'verify', 'public-invoice-p0-v1']));
    expect(verification.commands[1]).toEqual(expect.arrayContaining(['verify']));

    const backup = await runChoice('4');
    expect(backup.commands).toHaveLength(1);
    expect(backup.commands[0]).toEqual(expect.arrayContaining(['backup', 'create']));
  });

  test('prints a compact MinerU diagnostic when the task fails', async () => {
    const { pathsPath, configPath } = await menuFixture(1);
    const answers = ['2', '0'];
    const lines: string[] = [];
    await runMenu({
      pathsPath,
      configPath,
      ask: async () => answers.shift()!,
      output: fakeOutput(lines),
      execute: async args => {
        if (args[0] === 'parse') throw Object.assign(new Error('MinerU GPU resource is busy; wait for the other MinerU task to finish'), { code: 'MINERU_RESOURCE_BUSY', stderrSummary: 'worker failed\napi_key=secret-token' });
        return 0;
      },
    });
    const output = lines.join('');
    expect(output).toContain('MinerU 4/8');
    expect(output).toContain('MINERU_RESOURCE_BUSY: MinerU GPU resource is busy; wait for the other MinerU task to finish；诊断：worker failed api_key=[redacted]');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('"source_id"');
  });

  test('resumes the failed task at its first incomplete stage', async () => {
    const fixture = await menuFixture(2);
    const firstAnswers = ['2', '0'];
    const firstCommands: string[][] = [];
    const firstLines: string[] = [];
    await runMenu({
      pathsPath: fixture.pathsPath,
      configPath: fixture.configPath,
      ask: async () => firstAnswers.shift()!,
      output: fakeOutput(firstLines),
      execute: async args => {
        firstCommands.push(args);
        if (args[0] === 'parse') throw new Error('INTERRUPTED');
        return 0;
      },
    });
    expect(firstCommands.map(command => command[0])).toEqual(['source', 'acquire', 'labels', 'parse']);

    const resumedAnswers = ['2', '0'];
    const resumedCommands: string[][] = [];
    const resumedLines: string[] = [];
    await runMenu({
      pathsPath: fixture.pathsPath,
      configPath: fixture.configPath,
      ask: async () => resumedAnswers.shift()!,
      output: fakeOutput(resumedLines),
      execute: async args => { resumedCommands.push(args); return 0; },
    });
    expect(resumedCommands.map(command => command[0])).toEqual(['parse', 'catalog', 'release', 'release', 'verify', 'backup']);
    expect(resumedLines.join('')).toContain('[恢复]');
  });

  test('passes resume only to workflow stages that already started', async () => {
    const fixture = await menuFixture(2);
    const firstAnswers = ['2', '0'];
    await runMenu({
      pathsPath: fixture.pathsPath,
      configPath: fixture.configPath,
      ask: async () => firstAnswers.shift()!,
      output: fakeOutput([]),
      execute: async args => {
        if (args[0] === 'source') throw new Error('PROBE_INTERRUPTED');
        return 0;
      },
    });

    const resumedAnswers = ['2', '0'];
    let acquireResume: boolean | undefined;
    await runMenu({
      pathsPath: fixture.pathsPath,
      configPath: fixture.configPath,
      ask: async () => resumedAnswers.shift()!,
      output: fakeOutput([]),
      execute: async (args, options) => {
        if (args[0] === 'acquire') acquireResume = options?.resumeTask;
        return 0;
      },
    });
    expect(acquireResume).not.toBe(true);

    const failedAcquireFixture = await menuFixture(2);
    const failedAcquireAnswers = ['2', '0'];
    await runMenu({
      pathsPath: failedAcquireFixture.pathsPath,
      configPath: failedAcquireFixture.configPath,
      ask: async () => failedAcquireAnswers.shift()!,
      output: fakeOutput([]),
      execute: async args => {
        if (args[0] === 'acquire') throw new Error('ACQUIRE_INTERRUPTED');
        return 0;
      },
    });

    const failedAcquireResumeAnswers = ['2', '0'];
    let failedAcquireResume: boolean | undefined;
    await runMenu({
      pathsPath: failedAcquireFixture.pathsPath,
      configPath: failedAcquireFixture.configPath,
      ask: async () => failedAcquireResumeAnswers.shift()!,
      output: fakeOutput([]),
      execute: async (args, options) => {
        if (args[0] === 'acquire') failedAcquireResume = options?.resumeTask;
        return 0;
      },
    });
    expect(failedAcquireResume).toBe(true);
  });

  test('checks MinerU process safety before starting any task stage', async () => {
    const fixture = await menuFixture(2);
    await mkdir(join(fixture.dataRoot, 'work', 'processes'), { recursive: true });
    await writeFile(join(fixture.dataRoot, 'work', 'processes', 'active.json'), '{}');
    const answers = ['2', '0'];
    const commands: string[][] = [];
    const lines: string[] = [];
    await runMenu({
      pathsPath: fixture.pathsPath,
      configPath: fixture.configPath,
      ask: async () => answers.shift()!,
      output: fakeOutput(lines),
      execute: async args => { commands.push(args); return 0; },
    });
    expect(commands).toHaveLength(0);
    expect(lines.join('')).toContain('PROCESS_CLEANUP_UNCONFIRMED');
  });

  test('allows a changed task quantity and refreshes the configured selection during acquisition', async () => {
    const { pathsPath, configPath, dataRoot } = await menuFixture(7);
    const selectionDirectory = join(dataRoot, 'tasks', 'voxel51', 'selections');
    await mkdir(selectionDirectory, { recursive: true });
    const content = {
      schema_version: 1,
      source_id: 'voxel51-invoice-ocr',
      dataset_id: 'voxel51-hq-invoice-ocr',
      selection_id: 'initial-20',
      index_url: 'https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr/resolve/d21f03cfeea2b330e15a229883c66d7ebece8e69/samples.json',
      index_sha256: 'a'.repeat(64),
      revision: 'd21f03cfeea2b330e15a229883c66d7ebece8e69',
      counts: { with_publisher_annotation: 2, without_publisher_annotation: 0 },
      records: [{}, {}],
    };
    await writeFile(join(selectionDirectory, 'initial-20.json'), JSON.stringify({ ...content, selection_hash: hashCanonical(content) }));
    const answers = ['2', '0'];
    const commands: string[][] = [];
    const lines: string[] = [];
    await runMenu({
      pathsPath,
      configPath,
      ask: async () => answers.shift()!,
      output: fakeOutput(lines),
      execute: async args => { commands.push(args); return 0; },
    });
    const output = lines.join('');
    expect(commands).toHaveLength(9);
    expect(commands[1]).toContain('acquire');
    expect(output).toContain('[探测 1/8]');
    expect(output).not.toContain('SELECTION_LIMIT_CONFLICT');
  });
});
