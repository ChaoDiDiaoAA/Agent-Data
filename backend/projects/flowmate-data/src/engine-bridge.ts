export { canonicalJson, hashCanonical } from '../../paper-knowledge-engine/src/shared/manifest.ts';
export { replaceFileWithRetry } from '../../paper-knowledge-engine/src/evidence/atomic-replace.ts';
import { createHttpClient as createPaperHttpClient, ResearchAdapterError, type HttpFetch, type HttpScope, type ResearchHttpClient } from '../../paper-knowledge-engine/src/research/http-client.ts';

export { ResearchAdapterError };
export type { HttpFetch, HttpScope, ResearchHttpClient };

/** Flowmate's only runtime entry point to the shared, policy-bound HTTP client. */
export function createHttpClient(options: { fetch?: HttpFetch } = {}): ResearchHttpClient {
  return createPaperHttpClient(options);
}

import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadSharedEngineRuntime } from '../../paper-knowledge-engine/src/shared/engine-context.ts';
import { toStandaloneMinerULocalConfig, type MinerULocalConfig } from '../../paper-knowledge-engine/src/mineru/mineru-local-config.ts';
import { createMineruApiSession } from '../../paper-knowledge-engine/src/mineru/mineru-api-session.ts';
import { createProcessContext, type ProcessContext } from '../../paper-knowledge-engine/src/runtime/process.ts';
import { withRunLock } from '../../paper-knowledge-engine/src/runtime/run-lock.ts';
import { normalizeLocalMinerUResult } from '../../paper-knowledge-engine/src/mineru/mineru-local-result.ts';
import { archiveReferences, realTree } from '../../paper-knowledge-engine/src/shared/archive-v2.ts';
import { canonicalJson, hashCanonical } from '../../paper-knowledge-engine/src/shared/manifest.ts';
import { resolveOwnedPath } from './config.ts';
import type { FlowmatePaths } from './contracts.ts';

export type { MinerULocalConfig, ProcessContext };
export { realTree };
export { withRunLock };
export function loadSharedEngineNetwork(root: string): HttpScope['network'] {
  return loadSharedEngineRuntime({ root }).machine.network;
}
export interface ParsedFile { path: string; sha256: string; bytes: number }
export interface ParseReceipt {
  sampleId: string;
  parserKey: string;
  attemptId: string;
  originalSha256: string;
  startedAt: string;
  outputDir: string;
  normalizedDir: string;
  contentHash: string;
  files: ParsedFile[];
}
export interface ParseInput {
  sampleId: string;
  sourcePath: string;
  /** Parent of immutable attempt directories, within mineruConfig.outputRoot. */
  outputDir: string;
  mineruConfig: MinerULocalConfig;
  processContext: ProcessContext;
  lockPath: string;
}
export interface ParseDependencies {
  createSession?: typeof createMineruApiSession;
  now?: () => Date;
  /** Internal use: the caller already holds Flowmate's run lock for a larger operation. */
  lockHeld?: boolean;
  /** Runs after cleanup and receipt verification, while the Flowmate run lock is held. */
  onParsed?: (receipt: ParseReceipt) => Promise<void>;
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** The single identity contract used when creating and verifying parse attempts. */
export function deriveParseAttemptId(input: Pick<ParseReceipt, 'parserKey' | 'originalSha256' | 'startedAt'>): string {
  const { parserKey, originalSha256, startedAt } = input;
  const key = typeof parserKey === 'string' ? /^mineru@(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?);sha=([0-9a-f]{40});model=(pipeline|vlm);backend=(pipeline|vlm-engine);method=(auto|txt|ocr);language=([A-Za-z][A-Za-z0-9_-]*);formula=(true|false);table=(true|false)$/.exec(parserKey) : null;
  const timestamp = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!key || key[0] !== parserKey || key[4] !== (key[3] === 'pipeline' ? 'pipeline' : 'vlm-engine')
    || typeof originalSha256 !== 'string' || originalSha256.length !== 64 || !/^[0-9a-f]{64}$/.test(originalSha256)
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== startedAt) throw new Error('PARSE_IDENTITY_INVALID');
  return `attempt-${hashCanonical({ parserKey, originalSha256, startedAt })}`;
}

export function createFlowmateMinerURuntime(paths: FlowmatePaths) {
  const runtime = loadSharedEngineRuntime({ root: paths.paperEngineRoot });
  const workRoot = resolveOwnedPath(paths.dataRoot, 'work');
  return {
    mineruConfig: toStandaloneMinerULocalConfig(runtime, { tempRoot: workRoot, outputRoot: resolveOwnedPath(paths.dataRoot, 'datasets') }),
    processContext: createProcessContext(paths.paperEngineRoot, resolveOwnedPath(paths.dataRoot, 'work/processes'), runtime.engine.runtime),
    lockPath: resolveOwnedPath(paths.dataRoot, 'work/run.lock'),
  };
}

/** Verify real files, required structured artifacts and every local reference. */
export async function verifyNormalizedOutput(normalizedDir: string): Promise<{ contentHash: string; files: ParsedFile[] }> {
  const names = await realTree(normalizedDir);
  const files: ParsedFile[] = [];
  for (const name of names.filter(name => !name.endsWith('/'))) {
    const path = resolveOwnedPath(normalizedDir, name);
    const body = await readFile(path);
    files.push({ path: name, sha256: digest(body), bytes: body.byteLength });
  }
  for (const required of ['full.md', 'content-list.json', 'pages.json', 'page-marked.txt']) {
    if (!files.some(file => file.path === required && file.bytes > 0)) throw new Error('NORMALIZED_ARTIFACT_MISSING');
  }
  const markdown = await readFile(join(normalizedDir, 'full.md'), 'utf8');
  const content: unknown = JSON.parse(await readFile(join(normalizedDir, 'content-list.json'), 'utf8'));
  const pages: unknown = JSON.parse(await readFile(join(normalizedDir, 'pages.json'), 'utf8'));
  if (!Array.isArray(content) || !Array.isArray(pages) || pages.length === 0) throw new Error('NORMALIZED_ARTIFACT_INVALID');
  const references = archiveReferences(markdown, content);
  for (const asset of references) {
    const path = resolveOwnedPath(normalizedDir, asset);
    if (!(await lstat(path)).isFile()) throw new Error('NORMALIZED_ASSET_MISSING');
  }
  return { contentHash: createHash('sha256').update(markdown).update(JSON.stringify(content)).digest('hex'), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function parseInvoice(input: ParseInput, dependencies: ParseDependencies = {}): Promise<ParseReceipt> {
  const { mineruConfig: config, processContext, lockPath } = input;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.sampleId)) throw new Error('INVALID_SAMPLE_ID');
  if (!isAbsolute(input.sourcePath) || !['.jpg', '.jpeg', '.png', '.pdf'].includes(extname(input.sourcePath).toLowerCase())) throw new Error('PARSE_SOURCE_INVALID');
  if (![config.tempRoot, config.outputRoot, input.outputDir, lockPath, processContext.safetyRoot].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('PARSE_PATH_INVALID');
  if (resolve(lockPath) !== resolve(config.tempRoot, 'run.lock') || resolve(processContext.safetyRoot) !== resolve(config.tempRoot, 'processes')
    || resolve(config.tempRoot) !== resolve(dirname(config.outputRoot), 'work') || config.libraryId || config.libraryPaths) throw new Error('PARSE_PATH_INVALID');
  const outputParent = resolveOwnedPath(config.outputRoot, relative(config.outputRoot, input.outputDir));
  if (outputParent === resolve(config.outputRoot)) throw new Error('PARSE_PATH_INVALID');
  if (!/^[0-9a-f]{40}$/i.test(config.expectedCommit)) throw new Error('PARSER_SOURCE_SHA_INVALID');
  const parserKey = `mineru@${config.expectedVersion};sha=${config.expectedCommit.toLowerCase()};model=${config.model};backend=${config.cliBackend};method=${config.pipelineMethod};language=${config.pipelineLanguage};formula=${config.formulaEnabled};table=${config.tableEnabled}`;
  const operation = async () => {
    const originalSha256 = digest(await readFile(input.sourcePath));
    const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    const attemptId = deriveParseAttemptId({ parserKey, originalSha256, startedAt });
    const outputDir = resolveOwnedPath(outputParent, attemptId);
    await mkdir(outputParent, { recursive: true });
    try { await mkdir(outputDir); } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error('ATTEMPT_EXISTS');
      throw error;
    }
    const session = (dependencies.createSession ?? createMineruApiSession)({ config, processContext });
    let receipt: ParseReceipt;
    try {
      const execution = await session.run({ model: config.model, fileSource: input.sourcePath, outputDir,
        method: config.pipelineMethod, language: config.pipelineLanguage, formula: config.formulaEnabled, table: config.tableEnabled, timeoutMs: config.taskTimeoutMs });
      if (execution.exitCode !== 0 || execution.timedOut || execution.cleanupConfirmed === false || execution.errorCode) throw new Error(`MINERU_PARSE_FAILED: ${execution.errorCode ?? execution.exitCode}`);
      // A newly created attempt cannot contain stale artifacts. ZIP extraction
      // may retain timestamps older than this attempt, so do not filter by mtime.
      const normalized = await normalizeLocalMinerUResult({ model: config.model, cliBackend: config.cliBackend, outputDir });
      // The shared archive normalizer uses attempt-relative assets. Make the
      // standalone normalized directory self-contained without changing its text.
      const assets = join(outputDir, 'assets');
      try { await lstat(assets); await cp(assets, join(normalized.normalizedDir, 'assets'), { recursive: true, errorOnExist: true, force: false }); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      const verified = await verifyNormalizedOutput(normalized.normalizedDir);
      if (verified.contentHash !== normalized.contentHash || digest(await readFile(input.sourcePath)) !== originalSha256) throw new Error('PARSE_HASH_MISMATCH');
      receipt = { sampleId: input.sampleId, parserKey, attemptId, originalSha256, startedAt, outputDir, normalizedDir: normalized.normalizedDir, ...verified };
    } finally { await session.dispose(); }
    await writeFile(join(outputDir, 'receipt.json'), canonicalJson(receipt), { flag: 'wx' });
    await dependencies.onParsed?.(receipt);
    return receipt;
  };
  return dependencies.lockHeld ? operation() : withRunLock(lockPath, operation, { jobId: `flowmate-parse-${input.sampleId}` });
}
