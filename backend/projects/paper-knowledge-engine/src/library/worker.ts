import { loadEngineContext } from '../shared/engine-context.ts';
import { executeOperation } from './workflow.ts';
import { identifier, publicError } from './operations/operation-contracts.ts';
import { asLibraryId, type LibraryId } from '../shared/identity.ts';

function argumentsOf(argv: string[]): { libraryId: LibraryId; jobId: string } {
  if (argv.length !== 4 || argv[0] !== '--library' || argv[2] !== '--job-id') throw new Error('INVALID_REQUEST');
  const libraryId = asLibraryId(argv[1]);
  identifier(argv[3]);
  return { libraryId, jobId: argv[3] };
}

export async function runWorker(argv: string[], root: string): Promise<number | undefined> {
  try {
    const { libraryId, jobId } = argumentsOf(argv);
    const paths = loadEngineContext({ root, libraryId }).paths;
    const result = await executeOperation({ root, jobId }, { operationsRoot: paths.operationsRoot, dataRoot: paths.dataRoot });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'failed' || result.status === 'blocked' ? 1 : undefined;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    return 1;
  }
}
