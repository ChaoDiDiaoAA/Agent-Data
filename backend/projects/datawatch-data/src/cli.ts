import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadContext, routeCommand, helpText, type DataWatchContext } from './routes.ts';
import { runMenu } from './cli/menu.ts';

export interface CliOptions {
  context?: DataWatchContext;
  interactive?: boolean;
  readLine?: (prompt: string) => Promise<string>;
  writeLine?: (line: string) => void;
}

function projectRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args = process.argv.slice(2), options: CliOptions = {}): Promise<number> {
  const commandArgs = args.filter((arg, index) => !['--paths', '--config', '--sources'].includes(arg) && !(index > 0 && ['--paths', '--config', '--sources'].includes(args[index - 1]!)));
  if (commandArgs[0] === '--help' || commandArgs[0] === 'help'
    || (!commandArgs.length && (options.interactive === false || !process.stdin.isTTY))) {
    (options.writeLine ?? (line => console.log(line)))(helpText());
    return 0;
  }
  const context = options.context ?? loadContext(projectRoot(), {
    paths: option(args, '--paths'),
    workbench: option(args, '--config'),
    sources: option(args, '--sources'),
  });
  if (!commandArgs.length || commandArgs[0] === 'menu' || options.interactive) {
    return runMenu(context, { readLine: options.readLine, write: options.writeLine });
  }
  try {
    const result = await routeCommand(commandArgs, context);
    if (result !== undefined) {
      const format = commandArgs.includes('--format') ? 'json' : 'text';
      const output = format === 'json' || typeof result !== 'string' ? (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) : result;
      (options.writeLine ?? (line => console.log(line)))(output);
      if (commandArgs[0] === 'run-task' && result && typeof result === 'object' && 'status' in result && (result as { status?: unknown }).status === 'failed') return 1;
    }
    return 0;
  } catch (error) {
    (options.writeLine ?? (line => console.error(line)))('执行失败：' + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

if (import.meta.main) {
  if (process.argv.includes('--help') || process.argv.includes('help')) console.log(helpText());
  else process.exit(await main());
}
