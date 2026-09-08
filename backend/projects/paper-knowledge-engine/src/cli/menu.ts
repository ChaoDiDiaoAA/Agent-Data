import { createInterface } from 'node:readline/promises';
import { routeCommand } from './routes.ts';
import type { MainContext } from './context.ts';
import type { EngineContext } from '../types/config.ts';
import type { LibraryId } from '../shared/identity.ts';
import { asLibraryId } from '../shared/identity.ts';
import { listLibraries, loadEngineContext } from '../shared/engine-context.ts';

export interface InteractiveMenuDependencies {
  library: Pick<EngineContext['library'], 'libraryId' | 'displayName'> & { kind?: EngineContext['library']['kind'] };
  readLine(prompt: string): Promise<string>;
  write(line: string): void;
  runCommand(args: string[]): Promise<unknown>;
}

const libraryMenuOptions = new Map([
  ['fsd', { order: 0, label: 'FSD 论文知识库' }],
  ['agent-engineering', { order: 1, label: 'Agent Engineering' }],
  ['multi-agent-engineering', { order: 2, label: 'Multi-Agent Engineering' }],
]);

const menu = [
  '=========================',
  '1. 查看 MinerU 配置',
  '2. 运行当前任务',
  '3. 运行周任务',
  '4. 导入并解析本地 PDF',
  '5. 解析指定论文',
  '6. 发布或恢复 Evidence',
  '7. 对账 PDF 与 Evidence',
  '8. 查看任务配置',
  '9. 检查 arXiv 网络',
  '10. 准备或修复 OpenCLI',
  '11. 切换方向库',
  '0. 退出',
];

const researchMenu = [
  '=========================',
  '1. 查看来源配置',
  '2. 运行当前任务',
  '3. 运行周任务',
  '4. 运行 Backfill',
  '5. 导入本地资料',
  '6. 发布或恢复 Evidence',
  '7. 对账来源 Archive 与 Evidence',
  '8. 查看任务配置',
  '9. 准备或修复 OpenCLI',
  '10. 切换方向库',
  '0. 退出',
];

function printMenu(write: (line: string) => void, library: InteractiveMenuDependencies['library']): void {
  write('论文知识引擎（Bun CLI）');
  write(`当前方向库：${library.displayName}（${library.libraryId}）`);
  for (const line of library.kind === 'research' ? researchMenu : menu) write(line);
}

function trimQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function runAndShow(deps: InteractiveMenuDependencies, args: string[]): Promise<unknown> {
  const result = await deps.runCommand(args);
  if (result !== undefined) deps.write(JSON.stringify(result, null, 2));
  return result;
}

async function importLocal(deps: InteractiveMenuDependencies): Promise<void> {
  const input = trimQuotes(await deps.readLine('请输入 PDF 文件或文件夹路径（留空取消）'));
  if (!input) return;
  await runAndShow(deps, ['import-local', '--path', input, '--preview']);
  const confirmed = (await deps.readLine('确认导入并解析这些 PDF？[y/N]')).trim();
  if (!/^y$/i.test(confirmed)) return;
  const reparse = (await deps.readLine('是否强制重新解析已成功的文件？[y/N]')).trim();
  await runAndShow(deps, ['import-local', '--path', input, ...(/^y$/i.test(reparse) ? ['--reparse'] : [])]);
}

async function parseLocal(deps: InteractiveMenuDependencies): Promise<void> {
  const baseId = (await deps.readLine('请输入 arXiv base ID（例如 2608.23146）')).trim();
  if (!/^\d{4}\.\d{4,5}$/.test(baseId)) throw new Error('无效的 arXiv base ID');
  const reparse = (await deps.readLine('是否强制重新解析？[y/N]')).trim();
  await runAndShow(deps, ['parse-local', '--base-id', baseId, ...(/^y$/i.test(reparse) ? ['--reparse'] : [])]);
}

async function backfill(deps: InteractiveMenuDependencies): Promise<void> {
  const from = (await deps.readLine('请输入 Backfill 起始日期（YYYY-MM-DD）')).trim();
  const to = (await deps.readLine('请输入 Backfill 结束日期（YYYY-MM-DD）')).trim();
  if (!from || !to) return;
  await runAndShow(deps, ['run-task', '--mode', 'backfill', '--from', from, '--to', to]);
}

async function importSource(deps: InteractiveMenuDependencies): Promise<void> {
  const path = trimQuotes(await deps.readLine('请输入本地资料绝对路径（留空取消）'));
  if (!path) return;
  const kind = (await deps.readLine('来源类型（当前仅支持 local-artifact）')).trim();
  const track = (await deps.readLine('归属 Track（例如 agent-loop）')).trim();
  if (!kind || !track) return;
  await runAndShow(deps, ['import-source', '--path', path, '--kind', kind, '--track', track]);
}

export async function runInteractiveMenu(deps: InteractiveMenuDependencies): Promise<'switch' | 'exit'> {
  while (true) {
    printMenu(deps.write, deps.library);
    const choice = (await deps.readLine('请选择操作')).trim();
    try {
      if (deps.library.kind === 'research') {
        switch (choice) {
          case '1': await runAndShow(deps, ['source-config', '--format', 'json']); break;
          case '2': await runAndShow(deps, ['run-task', '--mode', 'current']); break;
          case '3': await runAndShow(deps, ['run-task', '--mode', 'weekly']); break;
          case '4': await backfill(deps); break;
          case '5': await importSource(deps); break;
          case '6': {
            const runId = (await deps.readLine('请输入需要发布或恢复的 run ID（留空取消）')).trim();
            if (runId) await runAndShow(deps, ['evidence-publish', '--run-id', runId]);
            break;
          }
          case '7': await runAndShow(deps, ['reconcile']); break;
          case '8': await runAndShow(deps, ['schedule-config', '--format', 'json']); break;
          case '9': await runAndShow(deps, ['opencli-prepare']); break;
          case '10': return 'switch';
          case '0': return 'exit';
          default: deps.write('未知选项。');
        }
        continue;
      }
      switch (choice) {
        case '1': await runAndShow(deps, ['mineru-config', '--format', 'json']); break;
        case '2': await runAndShow(deps, ['run-task', '--mode', 'current']); break;
        case '3': await runAndShow(deps, ['run-task', '--mode', 'weekly']); break;
        case '4': await importLocal(deps); break;
        case '5': await parseLocal(deps); break;
        case '6': {
          const runId = (await deps.readLine('请输入需要发布或恢复的 run ID（留空取消）')).trim();
          if (runId) await runAndShow(deps, ['evidence-publish', '--run-id', runId]);
          break;
        }
        case '7': await runAndShow(deps, ['reconcile']); break;
        case '8': await runAndShow(deps, ['schedule-config', '--format', 'json']); break;
        case '9': await runAndShow(deps, ['arxiv-check', '--format', 'json']); break;
        case '10': await runAndShow(deps, ['opencli-prepare']); break;
        case '11': return 'switch';
        case '0': return 'exit';
        default: deps.write('未知选项。');
      }
    } catch (error) {
      deps.write(`执行失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function runMenu(context: MainContext & { root: string; libraryId?: LibraryId }): Promise<number | undefined> {
  const { root } = context;
  let libraryId = context.libraryId;
  let useInjectedPaths = true;
  let commandExitCode: number | undefined;
  const writeLine = context.writeLine ?? (line => console.log(line));
  const sharedAbort = new AbortController();
  const abortShared = () => sharedAbort.abort();
  const createdReadline = context.readLine
    ? undefined
    : createInterface({ input: context.inputStream ?? process.stdin, output: context.outputStream ?? process.stdout });
  createdReadline?.once('close', abortShared);
  const readLine = context.readLine ?? (prompt => createdReadline!.question(`${prompt}: `, { signal: sharedAbort.signal }));
  if (context.signal) {
    if (context.signal.aborted) sharedAbort.abort();
    else context.signal.addEventListener('abort', abortShared, { once: true });
  }
  let exitSignal: 'SIGINT' | 'SIGTERM' | undefined;
  const handleSignal = (signalName: 'SIGINT' | 'SIGTERM') => {
    exitSignal = signalName;
    sharedAbort.abort();
    createdReadline?.close();
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  try {
    while (!sharedAbort.signal.aborted) {
      if (!libraryId) {
        const libraries = listLibraries(root).sort((a, b) =>
          (libraryMenuOptions.get(a.libraryId)?.order ?? libraryMenuOptions.size)
          - (libraryMenuOptions.get(b.libraryId)?.order ?? libraryMenuOptions.size));
        writeLine('论文知识引擎（Bun CLI）');
        writeLine('请选择方向库：');
        if (!libraries.length) { writeLine('未找到方向库，请先配置 config/<方向>/library.yaml。'); break; }
        libraries.forEach((library, index) => {
          const label = libraryMenuOptions.get(library.libraryId)?.label ?? `${library.displayName}（${library.libraryId}）`;
          writeLine(`${index + 1}. ${label}`);
        });
        writeLine('0. 退出');
        const choice = (await readLine('请选择方向库')).trim();
        if (choice === '0') break;
        const library = /^[1-9]\d*$/.test(choice) ? libraries[Number(choice) - 1] : undefined;
        if (!library) { writeLine('未知选项，请选择方向库。'); continue; }
        libraryId = asLibraryId(library.libraryId);
      }
      const selectedId = libraryId;
      let loaded: EngineContext | undefined;
      const engine = () => loaded ??= loadEngineContext({ root, libraryId: selectedId });
      const result = await runInteractiveMenu({
        library: engine().library,
        readLine,
        write: writeLine,
        runCommand: async commandArgs => {
          const code = await routeCommand(commandArgs, engine, {
            root,
            libraryId: selectedId,
            dataRoot: useInjectedPaths ? context.dataRoot : undefined,
            operationsRoot: useInjectedPaths ? context.operationsRoot : undefined,
            output: context.output,
            execute: context.execute,
            interactive: false,
            createMineruSession: context.createMineruSession,
            research: context.research,
            signal: sharedAbort.signal,
            readLine: context.readLine,
            writeLine,
          });
          if (code !== undefined) commandExitCode = code;
        },
      });
      if (result === 'exit') break;
      libraryId = undefined;
      useInjectedPaths = false;
    }
  } catch (error) {
    if (!sharedAbort.signal.aborted) throw error;
  } finally {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    if (context.signal) context.signal.removeEventListener('abort', abortShared);
    createdReadline?.off('close', abortShared);
    createdReadline?.close();
  }
  return exitSignal ? (exitSignal === 'SIGINT' ? 130 : 143) : commandExitCode;
}
