import { loadSharedMachineRuntime } from '../../paper-knowledge-engine/src/shared/engine-context.ts';
import { replaceFileWithRetry, type ReplaceFileOptions } from '../../paper-knowledge-engine/src/evidence/atomic-replace.ts';
import { createHttpClient as createPaperHttpClient, ResearchAdapterError, type HttpFetch, type HttpScope, type ResearchHttpClient } from '../../paper-knowledge-engine/src/research/http-client.ts';
import { withRunLock } from '../../paper-knowledge-engine/src/runtime/run-lock.ts';

export { canonicalJson, hashCanonical } from '../../paper-knowledge-engine/src/shared/manifest.ts';
export { replaceFileWithRetry, ResearchAdapterError, withRunLock };
export type { HttpFetch, HttpScope, ResearchHttpClient, ReplaceFileOptions };

/** DataWatch's only entry point to the shared Paper Knowledge Engine HTTP client. */
export function createHttpClient(options: { fetch?: HttpFetch } = {}): ResearchHttpClient {
  return createPaperHttpClient(options);
}

/** Read only the shared machine proxy boundary; MinerU settings remain outside DataWatch. */
export function loadSharedEngineNetwork(root: string): HttpScope['network'] {
  return loadSharedMachineRuntime({ root }).machine.network;
}
