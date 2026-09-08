import { resolve } from 'node:path';
import { loadEngineContext, parseLibrarySelection } from './shared/engine-context.ts';
import { asLibraryId } from './shared/identity.ts';
import { redactErrorMessage } from './shared/redaction.ts';
import { runMenu } from './cli/menu.ts';
import { routeCommand } from './cli/routes.ts';
import type { MainContext } from './cli/context.ts';
import type { EngineContext } from './types/config.ts';

export async function main(argv = process.argv.slice(2), context: MainContext = {}): Promise<void> {
  const selection = parseLibrarySelection(argv);
  const libraryId = selection.libraryId === undefined ? undefined : asLibraryId(selection.libraryId);
  const [command] = selection.argv;
  const root = context.root ?? (command === '--worker' || command === '--bridge'
    ? process.cwd() : resolve(import.meta.dir, '..'));
  // Offline migration arguments must be validated before loading live configuration.
  let loaded: EngineContext | undefined;
  const engine = () => {
    if (!libraryId) throw new Error('LIBRARY_ID_REQUIRED: 请使用 --library 指定方向库');
    return loaded ??= loadEngineContext({ root, libraryId });
  };
  const selected = { ...context, root, libraryId };
  const exitCode = (!command || command === '--menu') && context.interactive !== false
    ? await runMenu(selected)
    : await routeCommand(selection.argv, engine, selected);
  if (exitCode !== undefined) process.exitCode = exitCode;
}

if (import.meta.main) {
  await main().catch(error => { console.error(redactErrorMessage(error)); process.exitCode = 1; });
}
