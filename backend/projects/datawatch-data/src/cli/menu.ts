import { createInterface } from 'node:readline/promises';
import type { DataWatchContext } from '../routes.ts';
import type { DatasetId } from '../contracts.ts';

export interface MenuDataset {
  dataset_id: DatasetId;
  label: string;
}
export interface InteractiveMenuDependencies {
  datasets: MenuDataset[];
  selectedDatasetId?: DatasetId;
  readLine(prompt: string): Promise<string>;
  write(line: string): void;
  runCommand(args: string[]): Promise<unknown>;
}

function printPicker(write: (line: string) => void, datasets: MenuDataset[]): void {
  write('DataWatch 数据工作台');
  write('请选择数据集：');
  datasets.forEach((dataset, index) => write((index + 1) + '. ' + dataset.label));
  write((datasets.length + 1) + '. 获取全部数据集');
  write('0. 退出');
}
function printDatasetMenu(write: (line: string) => void, dataset: MenuDataset): void {
  write('DataWatch 数据工作台');
  write('当前数据集：' + dataset.label + '（' + dataset.dataset_id + '）');
  write('=========================');
  write('1. 查看来源配置');
  write('2. 运行当前任务／恢复未完成任务');
  write('3. 查看本地版本与下载状态');
  write('4. 校验原件与 Obsidian 副本');
  write('5. 发布或恢复 Obsidian 目录');
  write('6. 手动创建全部数据备份');
  write('7. 检查来源网络');
  write('8. 查看任务配置');
  write('9. 切换数据集');
  write('0. 退出');
}
async function runAndShow(deps: InteractiveMenuDependencies, args: string[]): Promise<void> {
  const result = await deps.runCommand(args);
  if (result !== undefined) deps.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

export async function runInteractiveMenu(deps: InteractiveMenuDependencies): Promise<'exit' | 'switch'> {
  let selected = deps.selectedDatasetId;
  while (true) {
    if (!selected) {
      printPicker(deps.write, deps.datasets);
      const choice = (await deps.readLine('请选择数据集')).trim();
      if (choice === '0') return 'exit';
      if (choice === String(deps.datasets.length + 1)) {
        try { await runAndShow(deps, ['run-task', '--all']); }
        catch (error) { deps.write('执行失败：' + (error instanceof Error ? error.message : String(error))); }
        continue;
      }
      const index = Number(choice) - 1;
      if (!Number.isSafeInteger(index) || !deps.datasets[index]) { deps.write('未知选项。'); continue; }
      selected = deps.datasets[index]!.dataset_id;
    }
    const dataset = deps.datasets.find(item => item.dataset_id === selected)!;
    printDatasetMenu(deps.write, dataset);
    const choice = (await deps.readLine('请选择操作')).trim();
    try {
      if (choice === '1') await runAndShow(deps, ['source', 'show', '--dataset', selected, '--format', 'json']);
      else if (choice === '2') await runAndShow(deps, ['run-task', '--dataset', selected]);
      else if (choice === '3') await runAndShow(deps, ['status', '--dataset', selected, '--format', 'json']);
      else if (choice === '4') await runAndShow(deps, ['verify', '--dataset', selected, '--format', 'json']);
      else if (choice === '5') await runAndShow(deps, ['catalog', 'build', '--format', 'json']);
      else if (choice === '6') await runAndShow(deps, ['backup', 'create', '--format', 'json']);
      else if (choice === '7') await runAndShow(deps, ['source', 'probe', '--dataset', selected, '--format', 'json']);
      else if (choice === '8') await runAndShow(deps, ['config', 'show', '--format', 'json']);
      else if (choice === '9') { selected = undefined; continue; }
      else if (choice === '0') return 'exit';
      else deps.write('未知选项。');
    } catch (error) {
      deps.write('执行失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
}

export async function runMenu(context: DataWatchContext, options: { readLine?: (prompt: string) => Promise<string>; write?: (line: string) => void } = {}): Promise<number> {
  const write = options.write ?? (line => console.log(line));
  const readline = options.readLine ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  const readLine = options.readLine ?? (prompt => readline!.question(prompt + ': '));
  const datasets = ([
    { dataset_id: 'regulatory-affairs', label: '器械监管数据' },
    { dataset_id: 'fda-recalls', label: 'FDA 召回数据' },
    { dataset_id: 'procurement-pricing', label: '药品采购价格数据' },
    { dataset_id: 'hospital-resources', label: '医院资源管理数据' },
  ] as MenuDataset[]).filter(item => context.sources.some(source => source.dataset_id === item.dataset_id && source.enabled));
  try {
    await runInteractiveMenu({
      datasets,
      readLine,
      write,
      runCommand: args => import('../routes.ts').then(module => module.routeCommand(args, context)),
    });
    return 0;
  } finally {
    readline?.close();
  }
}
