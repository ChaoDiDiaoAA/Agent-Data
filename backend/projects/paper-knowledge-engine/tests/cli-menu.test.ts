import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { main } from '../src/cli.ts';
import { runInteractiveMenu } from '../src/cli/menu.ts';
import { formatCliOperationSummary } from '../src/cli/routes.ts';
import { executeOperation } from '../src/library/workflow.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';

const projectRoot = join(import.meta.dirname, '..');

for (const argv of [['--library', 'fsd']]) {
  test(`Bun menu shows the engine and selected FSD library (${argv.length ? 'explicit' : 'default'})`, () => fixture(async root => {
    await writeLayeredConfigFixture({ root });
    const lines: string[] = [];
    await main(argv, {
      root, interactive: true, readLine: async () => '0',
      writeLine: line => { lines.push(line); },
    });
    assert.deepEqual(lines.slice(0, 3), [
      '论文知识引擎（Bun CLI）',
      '当前方向库：FSD 论文知识库（fsd）',
      '=========================',
    ]);
    assert.deepEqual(lines.slice(3), [
      '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
      '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
      '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络', '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
    ]);
  }));
}

test('interactive menu routes the arXiv network check as a read-only JSON command', async () => {
  const commands: string[][] = [];
  let choice = 0;
  await runInteractiveMenu({
    library: { libraryId: 'fsd', displayName: 'FSD 论文知识库' },
    readLine: async prompt => prompt === '请选择操作' ? ['9', '0'][choice++]! : '',
    write: () => undefined,
    runCommand: async args => { commands.push(args); return { status: 'reachable' }; },
  });
  assert.deepEqual(commands, [['arxiv-check', '--format', 'json']]);
});

test('Agent Engineering uses the same paper menu as FSD', async () => {
  const lines: string[] = [];
  await main(['--library', 'agent-engineering'], {
    root: projectRoot,
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.deepEqual(lines.slice(3), [
    '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
    '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
    '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络', '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
  ]);
});

test('Multi-Agent Engineering uses the same paper menu as FSD and Agent Engineering', async () => {
  const lines: string[] = [];
  await main(['--library', 'multi-agent-engineering'], {
    root: projectRoot,
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.equal(lines[1], '当前方向库：Multi-Agent Engineering（Multi-Agent 工程知识库）（multi-agent-engineering）');
  assert.deepEqual(lines.slice(3), [
    '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
    '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
    '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络',
    '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
  ]);
});

test('Agent Tool & RSI uses the shared paper menu', async () => {
  const lines: string[] = [];
  await main(['--library', 'agent-tool'], {
    root: projectRoot,
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.equal(lines[1], '当前方向库：Agent Tool & RSI（含 LLM 工具后训练）（agent-tool）');
  assert.deepEqual(lines.slice(3), [
    '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
    '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
    '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络',
    '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
  ]);
});

test('Agent Memory uses the shared paper menu', async () => {
  const lines: string[] = [];
  await main(['--library', 'agent-memory'], {
    root: projectRoot,
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.equal(lines[1], '当前方向库：Agent Memory（智能体记忆知识库）（agent-memory）');
  assert.deepEqual(lines.slice(3), [
    '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
    '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
    '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络',
    '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
  ]);
});

test('Agent & LLM Context uses the shared paper menu', async () => {
  const lines: string[] = [];
  await main(['--library', 'agent-context'], {
    root: projectRoot,
    interactive: true,
    readLine: async () => '0',
    writeLine: line => { lines.push(line); },
  });
  assert.equal(lines[1], '当前方向库：Agent & LLM Context（上下文知识库）（agent-context）');
  assert.deepEqual(lines.slice(3), [
    '1. 查看 MinerU 配置', '2. 运行当前任务', '3. 运行周任务',
    '4. 导入并解析本地 PDF', '5. 解析指定论文', '6. 发布或恢复 Evidence',
    '7. 对账 PDF 与 Evidence', '8. 查看任务配置', '9. 检查 arXiv 网络',
    '10. 准备或修复 OpenCLI', '11. 切换方向库', '0. 退出',
  ]);
});

test('terminal operation summaries stay concise for success and recovery failures', () => {
  assert.equal(formatCliOperationSummary('run-task', { status: 'completed', runId: 'run-1' }, { status: 'completed', paperCount: 79 }),
    '[任务] 成功：已处理 79 篇论文');
  assert.equal(formatCliOperationSummary('run-task', { status: 'failed', stage: 'parse', runId: 'run-1', error: { code: 'OPERATION_FAILED', message: 'OPERATION_FAILED' } }),
    '[任务] 失败：parse；runId=run-1；原因：OPERATION_FAILED');
});

async function fixture(fn: (stateRoot: string) => Promise<void>) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'cli-menu-'));
  try { await fn(stateRoot); } finally { await rm(stateRoot, { recursive: true, force: true }); }
}

function createSessionTracker() {
  const history: string[] = [];
  return {
    history,
    session: {
      async ensureReady() { history.push('ensureReady'); return 'http://127.0.0.1:17860'; },
      async run() { history.push('run'); return { status: 'completed' as const, runId: 'menu-run' }; },
      async dispose() { history.push('dispose'); },
    },
  };
}

test('interactive Bun menu gives each parse-producing command its own MinerU session', () => fixture(async stateRoot => {
  const prompts: string[] = [];
  const writes: string[] = [];
  const commands: string[] = [];
  const trackers: ReturnType<typeof createSessionTracker>[] = [];

  await main(['--library', 'fsd'], {
    root: projectRoot,
    dataRoot: stateRoot,
    operationsRoot: join(stateRoot, 'operations'),
    interactive: true,
    output: () => {},
    readLine: async (prompt: string) => {
      prompts.push(prompt);
      const menuChoices = prompts.filter(value => value === '请选择操作').length;
      if (prompt === '请选择操作') return ['2', '3', '0'][menuChoices - 1] ?? '0';
      throw new Error(`unexpected prompt: ${prompt}`);
    },
    writeLine: (line: string) => { writes.push(line); },
    createMineruSession: () => {
      const tracker = createSessionTracker();
      trackers.push(tracker);
      return tracker.session;
    },
    execute: async (input: { root: string; jobId: string }, dependencies: any) => executeOperation(input, {
      ...dependencies,
      runTask: async (_operation: unknown, workflowContext: any) => {
        commands.push(input.jobId);
        await workflowContext.mineruSession?.ensureReady();
        return { status: 'completed', runId: `run-${commands.length}` };
      },
    }),
  } as any);

  assert.equal(trackers.length, 2);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(id => existsSync(join(stateRoot, 'operations', `${id}.json`))));
  assert.ok(commands.every(Boolean));
  assert.deepEqual(trackers.map(tracker => tracker.history), [
    ['ensureReady', 'dispose'],
    ['ensureReady', 'dispose'],
  ]);
  assert.ok(writes.includes('论文知识引擎（Bun CLI）'));
}));

test('Agent Engineering paper tasks create the shared MinerU session boundary', () => fixture(async stateRoot => {
  const prompts: string[] = [];
  const trackers: ReturnType<typeof createSessionTracker>[] = [];
  let observedSession = false;

  await main(['--library', 'agent-engineering'], {
    root: projectRoot,
    dataRoot: stateRoot,
    operationsRoot: join(stateRoot, 'operations'),
    interactive: true,
    output: () => {},
    readLine: async (prompt: string) => {
      prompts.push(prompt);
      const menuChoices = prompts.filter(value => value === '请选择操作').length;
      if (prompt === '请选择操作') return ['2', '0'][menuChoices - 1] ?? '0';
      throw new Error(`unexpected prompt: ${prompt}`);
    },
    writeLine: () => {},
    createMineruSession: () => {
      const tracker = createSessionTracker();
      trackers.push(tracker);
      return tracker.session;
    },
    execute: async (input: { root: string; jobId: string }, dependencies: any) => executeOperation(input, {
      ...dependencies,
      runTask: async (_operation: unknown, workflowContext: any) => {
        observedSession = Boolean(workflowContext.mineruSession);
        await workflowContext.mineruSession?.ensureReady();
        return { status: 'completed', runId: 'agent-paper-run' };
      },
    }),
  } as any);

  assert.equal(trackers.length, 1);
  assert.equal(observedSession, true);
  assert.deepEqual(trackers[0]!.history, ['ensureReady', 'dispose']);
}));

test('Multi-Agent Engineering paper tasks create the shared MinerU session boundary', () => fixture(async stateRoot => {
  const prompts: string[] = [];
  const trackers: ReturnType<typeof createSessionTracker>[] = [];
  let observedSession = false;

  await main(['--library', 'multi-agent-engineering'], {
    root: projectRoot,
    dataRoot: stateRoot,
    operationsRoot: join(stateRoot, 'operations'),
    interactive: true,
    output: () => {},
    readLine: async (prompt: string) => {
      prompts.push(prompt);
      const menuChoices = prompts.filter(value => value === '请选择操作').length;
      if (prompt === '请选择操作') return ['2', '0'][menuChoices - 1] ?? '0';
      throw new Error(`unexpected prompt: ${prompt}`);
    },
    writeLine: () => {},
    createMineruSession: () => {
      const tracker = createSessionTracker();
      trackers.push(tracker);
      return {
        ensureReady: tracker.session.ensureReady,
        run: async () => ({ exitCode: 0 }),
        dispose: tracker.session.dispose,
      };
    },
    execute: async (input, dependencies) => executeOperation(input, {
      ...dependencies,
      runTask: async (_operation, workflowContext) => {
        observedSession = Boolean(workflowContext.mineruSession);
        await workflowContext.mineruSession?.ensureReady();
        return { status: 'completed', runId: 'multi-agent-paper-run' };
      },
    }),
  });

  assert.equal(trackers.length, 1);
  assert.equal(observedSession, true);
  assert.deepEqual(trackers[0]!.history, ['ensureReady', 'dispose']);
}));

test('interactive menu preserves the selected library and isolates its operation state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-library-menu-'));
  try {
    await writeLayeredConfigFixture({ root, additionalLibraryIds: ['ai-tdd'] });
    const libraryPath = join(root, 'config/ai-tdd/library.yaml');
    await writeFile(libraryPath, (await readFile(libraryPath, 'utf8')).replace('display_name: FSD 论文知识库', 'display_name: 测试驱动研究库'));
    const choices = ['2', '0'];
    let choiceIndex = 0;
    const lines: string[] = [];

    await main(['--library', 'ai-tdd'], {
      root,
      interactive: true,
      output: () => {},
      writeLine: (line: string) => { lines.push(line); },
      readLine: async (prompt: string) => prompt === '请选择操作' ? choices[choiceIndex++] ?? '0' : '',
      execute: async ({ jobId }: { jobId: string }) => ({
        jobId,
        libraryId: 'ai-tdd',
        requestId: 'test',
        status: 'completed',
        stage: 'acquire',
        updatedAt: new Date().toISOString(),
        canResume: false,
      }),
    } as any);

    const dataLibrariesRoot = join(root, 'data-libraries');
    assert.equal(lines[1], '当前方向库：测试驱动研究库（ai-tdd）');
    const selectedOperationRoot = win32.join(dataLibrariesRoot, 'ai-tdd', 'operations');
    const fsdOperationRoot = win32.join(dataLibrariesRoot, 'fsd', 'operations');
    assert.equal((await Array.fromAsync(new Bun.Glob('*.json').scan({ cwd: selectedOperationRoot }))).length, 1);
    assert.equal(existsSync(fsdOperationRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interactive Bun menu outputs only the failed JobView when MinerU cleanup fails', () => fixture(async stateRoot => {
  const outputs: unknown[] = [];
  const choices = ['2', '0'];
  let choiceIndex = 0;
  const previousExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    await main(['--library', 'fsd'], {
      root: projectRoot,
      dataRoot: stateRoot,
      operationsRoot: join(stateRoot, 'operations'),
      interactive: true,
      output: (value: unknown) => { outputs.push(value); },
      readLine: async (prompt: string) => {
        if (prompt === '请选择操作') return choices[choiceIndex++] ?? '0';
        throw new Error(`unexpected prompt: ${prompt}`);
      },
      writeLine: () => {},
      createMineruSession: () => ({
        async ensureReady() { return 'http://127.0.0.1:17860'; },
        async run() { return { status: 'completed' as const, runId: 'run-1' }; },
        async dispose() { throw Object.assign(new Error('cleanup failed'), { code: 'PROCESS_CLEANUP_UNCONFIRMED' }); },
      }),
      execute: async (input: { root: string; jobId: string }, dependencies: any) => executeOperation(input, {
        ...dependencies,
        runTask: async () => ({ status: 'completed', runId: 'run-1', businessOnly: true }),
      }),
    } as any);

    assert.equal(outputs.length, 1);
    assert.equal((outputs[0] as any).status, 'failed');
    assert.equal((outputs[0] as any).error?.code, 'PROCESS_CLEANUP_UNCONFIRMED');
    assert.equal('businessOnly' in (outputs[0] as object), false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode ?? 0;
  }
}));

test('interactive Bun menu creates no MinerU session for view-only commands', () => fixture(async stateRoot => {
  const choices = ['1', '8', '0'];
  let choiceIndex = 0;
  let created = 0;

  await main(['--library', 'fsd'], {
    root: projectRoot,
    dataRoot: stateRoot,
    operationsRoot: join(stateRoot, 'operations'),
    interactive: true,
    readLine: async (prompt: string) => {
      if (prompt === '请选择操作') return choices[choiceIndex++] ?? '0';
      throw new Error(`unexpected prompt: ${prompt}`);
    },
    writeLine: () => {},
    output: () => {},
    createMineruSession: () => {
      created++;
      return createSessionTracker().session;
    },
  } as any);

  assert.equal(created, 0);
}));

test('interactive Bun menu treats an external abort as a clean menu exit without creating MinerU', () => fixture(async stateRoot => {
  const controller = new AbortController();
  let created = 0;
  const run = main(['--library', 'fsd'], {
    root: projectRoot,
    dataRoot: stateRoot,
    operationsRoot: join(stateRoot, 'operations'),
    interactive: true,
    signal: controller.signal,
    readLine: async () => new Promise<string>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('read aborted'), { name: 'AbortError' })), { once: true });
    }),
    writeLine: () => {},
    createMineruSession: () => {
      created++;
      return createSessionTracker().session;
    },
  } as any);

  controller.abort();
  await run;
  assert.equal(created, 0);
}));

test('interactive Bun menu handles a real zero-argument SIGINT callback and exits with code 130', () => fixture(async stateRoot => {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  const previousListeners = new Set(process.listeners('SIGINT'));
  const previousExitCode = process.exitCode;

  try {
    process.exitCode = undefined;
    const running = main(['--library', 'fsd'], {
      root: projectRoot,
      dataRoot: stateRoot,
      operationsRoot: join(stateRoot, 'operations'),
      interactive: true,
      inputStream,
      outputStream,
      writeLine: () => {},
    } as any);
    const handler = process.listeners('SIGINT').find(listener => !previousListeners.has(listener));
    assert.ok(handler);
    (handler as () => void)();
    await running;

    assert.equal(process.exitCode, 130);
    assert.deepEqual(process.listeners('SIGINT'), [...previousListeners]);
  } finally {
    inputStream.destroy();
    outputStream.destroy();
    process.exitCode = previousExitCode ?? 0;
  }
}));

for (const selection of [[], ['--library', 'fsd']]) test(`interactive main settles at EOF (${selection.length ? 'task menu' : 'library picker'})`, async () => {
  const cliUrl = new URL('../src/cli.ts', import.meta.url).href;
  const script = `
    import { PassThrough } from 'node:stream';
    import { main } from ${JSON.stringify(cliUrl)};
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    const running = main(${JSON.stringify(selection)}, {
      root: ${JSON.stringify(projectRoot)},
      interactive: true,
      inputStream,
      outputStream,
      writeLine: () => {},
    });
    await Bun.sleep(25);
    inputStream.end();
    const outcome = await Promise.race([
      running.then(() => 'resolved', error => 'rejected:' + error?.message),
      Bun.sleep(500).then(() => 'timeout'),
    ]);
    console.log(outcome);
    process.exit(outcome === 'resolved' ? 0 : 2);
  `;
  const child = Bun.spawn(['bun', '-e', script], {
    cwd: projectRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();

  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /resolved/);
});
