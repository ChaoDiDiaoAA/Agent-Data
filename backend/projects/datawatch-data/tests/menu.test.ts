import { expect, test } from 'bun:test';
import { runInteractiveMenu } from '../src/cli/menu.ts';

test('interactive menu can run all datasets and exit', async () => {
  const lines: string[] = [];
  const commands: string[][] = [];
  const choices = ['5', '0'];
  const result = await runInteractiveMenu({
    readLine: async () => choices.shift() ?? '0',
    write: line => lines.push(line),
    runCommand: async args => { commands.push(args); return { status: 'completed', datasetCount: 4 }; },
    datasets: [
      { dataset_id: 'regulatory-affairs', label: '器械监管数据' },
      { dataset_id: 'fda-recalls', label: 'FDA 召回数据' },
      { dataset_id: 'procurement-pricing', label: '药品采购价格数据' },
      { dataset_id: 'hospital-resources', label: '医院资源管理数据' },
    ],
    selectedDatasetId: undefined,
  });
  expect(result).toBe('exit');
  expect(commands).toEqual([['run-task', '--all']]);
  expect(lines.join('\n')).toContain('DataWatch 数据工作台');
});
