import type { EngineContext } from '../types/config.ts';
import type { ResearchExecutionContext } from '../library/execution.ts';
import { createHttpClient } from './http-client.ts';
import { ArxivAdapter } from './adapters/arxiv-adapter.ts';
import { OfficialDocAdapter } from './adapters/official-doc-adapter.ts';
import { ReleaseAdapter } from './adapters/release-adapter.ts';
import { LocalArtifactAdapter } from './adapters/local-artifact-adapter.ts';
import { publishResearchEvidence, type ResearchEvidencePublicationStore } from '../evidence/source-publisher.ts';

/**
 * Assemble the CLI's safe, network-backed research runtime. Repository reads are
 * intentionally injected by callers because a repository boundary must be
 * explicitly read-only and never inferred from the local checkout.
 */
export function createResearchExecutionContext(engine: EngineContext): ResearchExecutionContext {
  const http = createHttpClient();
  const adapters = [
    new ArxivAdapter({ arxiv: engine.engine.arxiv }),
    new OfficialDocAdapter({ http }),
    new ReleaseAdapter({ http }),
    new LocalArtifactAdapter(),
  ];
  return {
    dependencies: {
      adapters,
      network: engine.machine.network,
      fullTextKinds: ['paper', 'technical-report'],
      publish: async input => {
        await publishResearchEvidence({
          runId: input.runId,
          stateRoot: engine.paths.dataRoot,
          tempRoot: engine.paths.workRoot,
          vaultRoot: engine.paths.vaultRoot,
          store: input.store as unknown as ResearchEvidencePublicationStore,
          selectionHash: input.selectionHash,
          archives: input.archives,
        });
      },
    },
  };
}
