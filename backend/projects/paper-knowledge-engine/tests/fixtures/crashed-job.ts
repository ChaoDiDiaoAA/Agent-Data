import { admitOperation } from '../../src/library/operations/operation-store.ts';
import { executeOperation } from '../../src/library/workflow.ts';
const root = process.argv[2];
if (!root) throw new Error('fixture root required');
const { job } = await admitOperation({ operationsRoot: root, request: { libraryId: 'fsd', requestId: 'crash', operation: { kind: 'current' } } });
await executeOperation({ root, jobId: job.jobId }, { operationsRoot: root, dataRoot: root, runTask: async (_, context) => {
  context.onProgress({ type: 'task-start', runId: 'crashed-run' });
  process.stdout.write(JSON.stringify({ jobId: job.jobId }));
  process.exit(19);
}, mineruSession: {
  async ensureReady() { return 'http://127.0.0.1:17860'; },
  async run() { throw new Error('crash fixture must not invoke MinerU'); },
  async dispose() {},
} });
