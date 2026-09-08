import { resolve } from 'node:path';
import { inspectProcessRecord, resolveProcessRecord } from './process.ts';

export async function runProcessSupervisor(args: string[]): Promise<number> {
  const [operation, recordPath] = args;
  if (!['--inspect', '--resolve'].includes(operation) || !recordPath) {
    console.error('Usage: bun src/cli.ts --process-supervisor --inspect|--resolve <state_root>/locks/processes/active.json');
    return 2;
  }
  try {
    const run = operation === '--resolve' ? resolveProcessRecord : inspectProcessRecord;
    const result = await run(resolve(recordPath));
    console.log(JSON.stringify(result));
    return operation === '--resolve' && !result.resolved ? 1 : 0;
  } catch {
    console.log(JSON.stringify({ ownerAlive: true, rootState: 'unknown', activePids: [], cleanupConfirmed: false, resolved: false, error: 'record inspection could not establish safe cleanup' }));
    return 1;
  }
}
