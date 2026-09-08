import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { main } from '../../src/cli.ts';
import { FSD_WEEKLY_CLI_ARGUMENTS } from '../../src/library/schedule/schedule-config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type CliMain = (argv: string[]) => Promise<void>;

export function runWeeklyTask(runMain: CliMain = main): Promise<void> {
  return runMain([...FSD_WEEKLY_CLI_ARGUMENTS]);
}

if (import.meta.main) {
  process.chdir(root);
  runWeeklyTask().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
