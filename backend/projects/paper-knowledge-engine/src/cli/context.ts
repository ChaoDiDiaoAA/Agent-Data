import type { MineruApiSession } from '../mineru/mineru-api-session.ts';
import type { executeOperation } from '../library/workflow.ts';
import type { ArchiveMigrationInput } from '../maintenance/archive-migration.ts';
import type { LibraryStateInput } from '../maintenance/library-state-migration.ts';
import type { VaultRebuildInput } from '../maintenance/vault-rebuild.ts';
import type { RendererUpgradeBaselineInput } from '../maintenance/publication-baseline.ts';
import type { ResearchExecutionContext } from '../library/execution.ts';
export interface MainContext {
  vaultRebuild?: VaultRebuildInput;
  rendererBaseline?: RendererUpgradeBaselineInput;
  archiveMigration?: ArchiveMigrationInput;
  libraryMigration?: LibraryStateInput;
  root?: string;
  dataRoot?: string;
  operationsRoot?: string;
  output?: (value: unknown) => void;
  execute?: typeof executeOperation;
  interactive?: boolean;
  mineruSession?: MineruApiSession;
  createMineruSession?: (root: string, signal?: AbortSignal) => MineruApiSession;
  /** Optional deterministic/injected research runtime; the CLI builds a safe default when absent. */
  research?: ResearchExecutionContext;
  signal?: AbortSignal;
  readLine?: (prompt: string) => Promise<string>;
  writeLine?: (line: string) => void;
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
}
