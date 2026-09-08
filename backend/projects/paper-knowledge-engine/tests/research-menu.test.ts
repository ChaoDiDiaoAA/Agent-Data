import { expect, test } from 'bun:test';
import { runInteractiveMenu } from '../src/cli/menu.ts';

test('generic Research menu contains source workflow only and never offers paper/MinerU actions', async () => {
  const lines: string[] = [];
  const commands: string[][] = [];
  const prompts: string[] = [];
  const answers = new Map<string, string>([
    ['请输入 Backfill 起始日期（YYYY-MM-DD）', '2026-01-01'],
    ['请输入 Backfill 结束日期（YYYY-MM-DD）', '2026-09-07'],
    ['请输入本地资料绝对路径（留空取消）', 'D:\\research\\agent-notes'],
    ['来源类型（当前仅支持 local-artifact）', 'local-artifact'],
    ['归属 Track（例如 agent-loop）', 'agent-loop'],
    ['请输入需要发布或恢复的 run ID（留空取消）', 'research-run-1'],
  ]);
  let menuChoice = 0;
  const result = await runInteractiveMenu({
    library: { libraryId: 'research-fixture', displayName: 'Research Fixture', kind: 'research' },
    readLine: async prompt => {
      prompts.push(prompt);
      if (prompt === '请选择操作') return ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'][menuChoice++] ?? '0';
      return answers.get(prompt) ?? '';
    },
    write: line => lines.push(line),
    runCommand: async args => { commands.push(args); return { status: 'completed' }; },
  });

  expect(result).toBe('switch');
  expect(lines).toContain('1. 查看来源配置');
  expect(lines).toContain('4. 运行 Backfill');
  expect(lines).toContain('5. 导入本地资料');
  expect(lines.some(line => line.includes('MinerU') || line.includes('PDF') || line.includes('解析指定论文'))).toBe(false);
  expect(commands).toEqual([
    ['source-config', '--format', 'json'],
    ['run-task', '--mode', 'current'],
    ['run-task', '--mode', 'weekly'],
    ['run-task', '--mode', 'backfill', '--from', '2026-01-01', '--to', '2026-09-07'],
    ['import-source', '--path', 'D:\\research\\agent-notes', '--kind', 'local-artifact', '--track', 'agent-loop'],
    ['evidence-publish', '--run-id', 'research-run-1'],
    ['reconcile'],
    ['schedule-config', '--format', 'json'],
    ['opencli-prepare'],
  ]);
  expect(prompts).toContain('请选择操作');
});

test('FSD menu remains paper-oriented for existing callers without a kind field', async () => {
  const lines: string[] = [];
  const result = await runInteractiveMenu({
    library: { libraryId: 'fsd', displayName: 'FSD 论文知识库' },
    readLine: async () => '0',
    write: line => lines.push(line),
    runCommand: async () => undefined,
  });
  expect(result).toBe('exit');
  expect(lines).toContain('1. 查看 MinerU 配置');
  expect(lines).toContain('4. 导入并解析本地 PDF');
});
