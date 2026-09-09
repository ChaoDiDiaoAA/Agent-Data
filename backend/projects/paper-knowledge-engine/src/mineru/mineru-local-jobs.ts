import type { MinerUCliConfig, MinerUParseConfig } from '../types/config.ts';
import type { LocalPaper, PdfPage } from '../types/papers.ts';
import type { LocalParseJob, MinerUExecution, NormalizedArtifact, ParseArtifacts, ParseAttemptInput, ParseIdentity, RunWindow } from '../types/jobs.ts';
import type { ProcessContext } from '../runtime/process.ts';
import type { ParseWorkspace } from './mineru-workspace.ts';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { normalizeLocalMinerUResult } from './mineru-local-result.ts';
import { assessExtraction } from './mineru-quality.ts';
import { redactErrorMessage } from '../shared/redaction.ts';
import { createParseWorkspace, publishParseWorkspace } from './mineru-workspace.ts';
import { withRunLock } from '../runtime/run-lock.ts';
import { basename } from 'node:path';
import { assertProcessSafety } from '../runtime/process.ts';
import { safeMkdir } from './archive-writer.ts';

type MaybePromise<T> = T | Promise<T>;
interface ParseAttempt extends ParseArtifacts { attemptId: string; status?: string; notePath?: string | null }
export interface ParseStore {
  paperStatus?: string;
  reserveParseAttempt?: (job: ParseAttemptInput, options: { force: boolean }) => MaybePromise<ParseAttempt | null | undefined>;
  startParseAttempt?: (id: string) => unknown;
  findSuccessfulParse?: (identity: ParseIdentity) => MaybePromise<ParseAttempt | null | undefined>;
  findParseAttempt?: (identity: ParseIdentity) => MaybePromise<ParseAttempt | null | undefined>;
  // Legacy injected rows may omit status; runLocalParse normalizes after awaiting.
  findByBaseId?: (id: string) => MaybePromise<{ status?: string } | undefined>;
  hasSuccessfulParse?: (identity: ParseIdentity | string) => MaybePromise<boolean>;
  finishParseAttempt?: (id: string, artifact: ParseArtifacts) => unknown;
  failParseAttempt?: (id: string, failure: { errorClass: string; errorMessage: string; exitCode?: number }) => unknown;
  markParseFailed?: (id: string, error: string) => unknown;
  assertParseAttemptCurrent?: (id: string) => unknown;
}
export interface ParseDependencies {
  store: ParseStore; config?: Partial<MinerUCliConfig> & { outputRoot?: string }; processContext?: ProcessContext; signal?: AbortSignal;
  runner?: (job: LocalParseJob) => Promise<MinerUExecution>;
  normalize?: (job: LocalParseJob) => Promise<unknown>;
  assessExtraction?: (pages: PdfPage[], metadata: { pageCount: number }, options: { isOcrAttempt: boolean }) => MaybePromise<{ accepted: boolean; reasons?: string[]; retryWithOcr?: boolean }>;
  writeNote?: (...args: unknown[]) => unknown;
}
export interface ParseReport {
  baseId: string; version: number; sha256?: string; model: string; cliBackend?: string; method: string;
  status: 'succeeded' | 'failed' | 'skipped'; attemptId?: string; artifact?: (NormalizedArtifact & { notePath?: string | null }) | null;
  errorClass?: string | null; errorMessage?: string | null;
  cleanupConfirmed?: false; errorCode?: 'PROCESS_CLEANUP_UNCONFIRMED';
}
function processError(error: unknown) {
  const get = (key: string): unknown => error && typeof error === 'object' ? Reflect.get(error, key) : undefined;
  return { message: typeof get('message') === 'string' ? String(get('message')) : String(error), code: typeof get('code') === 'string' ? String(get('code')) : undefined,
    cleanupConfirmed: typeof get('cleanupConfirmed') === 'boolean' ? Boolean(get('cleanupConfirmed')) : undefined,
    errorClass: typeof get('errorClass') === 'string' ? String(get('errorClass')) : undefined, retryWithOcr: get('retryWithOcr') === true };
}
function assertPages(input: unknown, count: number): asserts input is PdfPage[] {
  if (!Array.isArray(input) || input.length !== count || !input.every((page, index) => page && typeof page === 'object' && page.pageNumber === index + 1 && typeof page.text === 'string')) throw invalidArtifact('invalid normalized page identity or text');
}
const reportBase = (job: LocalParseJob) => ({
  baseId: job.baseId,
  version: job.version,
  sha256: job.sha256,
  model: job.model,
  cliBackend: job.cliBackend,
  method: job.method ?? 'auto',
  ...(job.retryOfMethod ? { retryOfMethod: job.retryOfMethod } : {}),
});

export function buildLocalParseJob(paper: LocalPaper, config: MinerUParseConfig, options: { method?: string; reparse?: boolean } = {}) {
  return {
    libraryPaths: config.libraryPaths,
    libraryId: config.libraryId,
    mineruVersion: config.expectedVersion,
    baseId: paper.baseId,
    arxivId: paper.arxivId,
    version: paper.version,
    sha256: paper.sha256,
    fileSource: String(paper.pdfPath).replaceAll('\\', '/'),
    outputDir: join(config.libraryPaths?.archiveRoot ?? config.outputRoot, `${paper.baseId}-v${paper.version}`).replaceAll('\\', '/'),
    model: config.model,
    cliBackend: config.cliBackend,
    method: options.method ?? config.pipelineMethod ?? 'auto',
    language: config.pipelineLanguage,
    formula: config.formulaEnabled,
    table: config.tableEnabled,
    reparse: options.reparse === true,
    pageCount: paper.pageCount,
    title: paper.title,
    authors: paper.authors,
    categories: paper.categories,
    published: paper.published,
    updated: paper.updated,
    primaryTrack: paper.primaryTrack,
    matchedTracks: paper.matchedTracks,
    sourceType: paper.sourceType,
  };
}

/** Stable local-PDF parser identity, shared by batch import and standalone parse-local. */
export function localParserConfigKey(config: Pick<MinerUParseConfig, 'model' | 'cliBackend' | 'pipelineMethod' | 'pipelineLanguage' | 'formulaEnabled' | 'tableEnabled' | 'expectedVersion' | 'expectedCommit'>): string {
  return createHash('sha256').update(JSON.stringify({
    model: config.model, backend: config.cliBackend, method: config.pipelineMethod,
    language: config.pipelineLanguage, formula: config.formulaEnabled, table: config.tableEnabled,
    version: config.expectedVersion, commit: config.expectedCommit,
  })).digest('hex');
}

export function buildLocalParseManifest(runId: string, papers: LocalPaper[], config: MinerUParseConfig, run: Partial<RunWindow> | null = null) {
  if (!runId) throw new Error('local MinerU manifest requires runId');
  const jobs = (papers ?? []).map((paper) => {
    const job = buildLocalParseJob(paper, config);
    return {
      ...(job.libraryPaths ? { libraryPaths: job.libraryPaths, libraryId: job.libraryId } : {}),
      baseId: job.baseId,
      arxivId: job.arxivId,
      version: job.version,
      sha256: job.sha256,
      ...(job.pageCount !== undefined ? { pageCount: job.pageCount } : {}),
      pdfPath: String(paper.pdfPath).replaceAll('\\', '/'),
      outputDir: job.outputDir,
      model: job.model,
      method: job.method,
      language: job.language,
      formula: job.formula,
      table: job.table,
      cliBackend: job.cliBackend,
      title: paper.title,
      authors: paper.authors,
      categories: paper.categories,
      published: paper.published,
      updated: paper.updated,
      primaryTrack: paper.primaryTrack,
      matchedTracks: paper.matchedTracks,
      ...(job.sourceType ? { sourceType: job.sourceType } : {}),
      mineruVersion: config.expectedVersion,
      sourceCommit: config.expectedCommit,
    };
  });
  return {
    runId,
    ...(run?.from || run?.to ? { window: { from: run.from, to: run.to } } : {}),
    model: config.model,
    cliBackend: config.cliBackend,
    jobs,
  };
}

export async function writeLocalParseManifest(path: string, manifest: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
function classifyProcessFailure(execution: Partial<MinerUExecution> | undefined) {
  if (execution?.cleanupConfirmed === false || execution?.errorCode === 'PROCESS_CLEANUP_UNCONFIRMED') return 'process_cleanup_unconfirmed';
  if (execution?.errorCode === 'MINERU_API_UNAVAILABLE') return 'mineru_api_unavailable';
  if (execution?.errorCode === 'MINERU_API_STARTUP_TIMEOUT') return 'mineru_api_startup_timeout';
  if (execution?.errorCode === 'MINERU_API_PORT_IN_USE') return 'mineru_api_port_in_use';
  if (execution?.errorCode === 'MINERU_RESOURCE_BUSY') return 'mineru_resource_busy';
  const text = `${execution?.stderrSummary ?? ''}
${execution?.stdoutSummary ?? ''}`;
  if (execution?.errorCode === 'MINERU_PATH_TOO_LONG' || /路径过长|path too long|filename or extension is too long/i.test(text)) return 'path_too_long';
  if (execution?.timedOut === true || execution?.errorCode === 'ETIMEDOUT' || /tim(?:ed|e)\s*out|timeout|ETIMEDOUT|deadline exceeded/i.test(text)) return 'timeout';
  if (/torch\.cuda\.OutOfMemoryError|CUDA\s+(?:out of memory|error)|CUDA.*OOM|CUBLAS_STATUS_ALLOC_FAILED|cuda.*allocation.*failed/i.test(text)) return 'cuda_oom';
  if (/system\s*(?:ram|memory)|host\s*(?:ram|memory)|cannot allocate memory|memoryerror|std::bad_alloc/i.test(text)) return 'system_memory';
  if (/model(?: file| checkpoint| repository)?\s*(?:is\s*)?(?:missing|not found)|cannot find model|no such file.*model|checkpoint.*not found/i.test(text)) return 'model_missing';
  if (/ModuleNotFoundError|ImportError|No module named|DLL load failed|dependency|cannot import name/i.test(text)) return 'dependency';
  return 'process_error';
}

function invalidArtifact(message: string) {
  return Object.assign(new Error(message), { errorClass: 'invalid_artifact', retryWithOcr: false });
}

async function readArtifactText(path: unknown, label: string) {
  if (typeof path !== 'string' || !path) throw invalidArtifact(`${label} is required`);
  let value;
  try { value = await readFile(path, 'utf8'); }
  catch { throw invalidArtifact(`${label} is required`); }
  if (!value.trim()) throw invalidArtifact(`${label} is empty`);
  return value;
}

async function validateArtifact(job: LocalParseJob, input: unknown, dependencies: ParseDependencies): Promise<NormalizedArtifact> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidArtifact('normalized artifact is required');
  const artifact = input as Record<string, unknown>;
  if ((artifact.model !== undefined && artifact.model !== job.model)
    || (artifact.cliBackend !== undefined && artifact.cliBackend !== job.cliBackend)) throw invalidArtifact('artifact model identity mismatch');
  if (artifact.contentHash !== undefined && typeof artifact.contentHash !== 'string') throw invalidArtifact('invalid artifact content hash');
  for (const key of ['sourcePath', 'fileSource', 'previousOutputDir', 'archivedOutputDir']) {
    if (artifact[key] !== undefined && artifact[key] !== null && typeof artifact[key] !== 'string') throw invalidArtifact('invalid artifact path');
  }
  for (const key of ['elapsedMs', 'exitCode']) {
    if (artifact[key] !== undefined && artifact[key] !== null && (typeof artifact[key] !== 'number' || !Number.isSafeInteger(artifact[key]))) throw invalidArtifact('invalid artifact process metadata');
  }
  for (const key of ['rawOutputDir', 'normalizedDir', 'markdownPath', 'contentListPath', 'pageTextPath', 'outputDir']) {
    const path = artifact[key];
    if (path !== undefined && (typeof path !== 'string' || !path)) throw invalidArtifact('invalid artifact path');
    if (typeof path === 'string' && job.outputDir) {
      const root = await realpath(job.outputDir);
      const actual = await realpath(path);
      const rel = relative(root, actual);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw invalidArtifact('artifact outside output directory');
    }
  }
  const markdown = await readArtifactText(artifact.markdownPath, 'markdown artifact');
  const contentText = await readArtifactText(artifact.contentListPath, 'structured content artifact');
  let contentList: unknown;
  try { contentList = JSON.parse(contentText); }
  catch { throw invalidArtifact('structured content artifact is not valid JSON'); }
  if (!Array.isArray(contentList) || contentList.length === 0) throw invalidArtifact('structured content artifact is empty');

  const pageText = await readArtifactText(artifact.pageTextPath, 'page-marked text artifact');
  const pageCount = Number.isInteger(job.pageCount) ? job.pageCount : artifact.pageCount;
  if (typeof pageCount !== 'number' || !Number.isSafeInteger(pageCount) || pageCount < 1) throw invalidArtifact('page count is required');
  if (artifact.pageCount !== pageCount) throw invalidArtifact('page count mismatch');
  const markers = pageText.match(/(?:^|\n)--- PAGE \d+ ---/g) ?? [];
  if (markers.length !== pageCount) throw invalidArtifact('page-marked text page count mismatch');

  let pages = artifact.pages;
  if (!Array.isArray(pages)) {
    const pagesPath = join(typeof artifact.normalizedDir === 'string' ? artifact.normalizedDir : '', 'pages.json');
    try { pages = JSON.parse(await readFile(pagesPath, 'utf8')); }
    catch { throw invalidArtifact('normalized pages are required'); }
  }
  if (!Array.isArray(pages) || pages.length !== pageCount) throw invalidArtifact('page count mismatch');

  assertPages(pages, pageCount);
  if (markers.some((marker, index) => Number(marker.match(/\d+/)?.[0]) !== index + 1)) throw invalidArtifact('invalid page marker identity');
  const assess = dependencies.assessExtraction ?? assessExtraction;
  const assessment = await assess(pages, { pageCount }, { isOcrAttempt: job.isOcr === true });
  if (!assessment?.accepted) {
    const error = invalidArtifact(`extraction validation failed: ${(assessment?.reasons ?? ['rejected']).join(', ')}`);
    error.retryWithOcr = assessment?.retryWithOcr === true;
    throw error;
  }
  // Every persisted path and page is checked before returning the normalized contract.
  return { ...artifact, markdown, contentList, pages, pageText } as NormalizedArtifact;
}

function failureReport(job: LocalParseJob, attemptId: string, errorClass: string, errorMessage: string): ParseReport {
  return {
    ...reportBase(job),
    attemptId,
    status: 'failed',
    artifact: null,
    errorClass,
    errorMessage,
  };
}

async function hasSuccessfulParse(store: ParseStore, job: LocalParseJob, preserve = false) {
  if (!store) return false;
  if (!preserve && typeof store.hasSuccessfulParse === 'function') {
    if (await store.hasSuccessfulParse(job)) return true;
  } else if (preserve && typeof store.hasSuccessfulParse === 'function') {
    if (await store.hasSuccessfulParse(job.baseId)) return true;
  }
  const row = await store.findByBaseId?.(job.baseId);
  return ['parsed', 'synthesized'].includes(row?.status ?? store.paperStatus ?? '');
}

function recoveredReport(job: LocalParseJob, attempt: ParseAttempt): ParseReport {
  return {
    ...reportBase(job),
    attemptId: attempt.attemptId,
    status: 'succeeded',
    artifact: {
      markdownPath: attempt.markdownPath,
      contentListPath: attempt.contentListPath,
      pageTextPath: attempt.pageTextPath,
      pageCount: attempt.pageCount,
      outputDir: attempt.outputDir,
      notePath: attempt.notePath ?? null,
    },
    errorClass: null,
    errorMessage: null,
  };
}
export async function runLocalParse(job: LocalParseJob, dependencies: ParseDependencies): Promise<ParseReport> {
  job = { ...job, libraryPaths: job.libraryPaths ?? dependencies.config?.libraryPaths,
    libraryId: job.libraryId ?? dependencies.config?.libraryId,
    mineruVersion: job.mineruVersion ?? dependencies.config?.expectedVersion };
  const { store } = dependencies;
  if (dependencies.processContext) await assertProcessSafety(dependencies.processContext);
  const identity = { baseId: job.baseId, version: job.version, sha256: job.sha256, model: job.model, method: job.method ?? 'auto' };
  if (job.reparse !== true) {
    const existing = await store.findSuccessfulParse?.(identity);
    if (existing) return recoveredReport(job, existing);
    const unfinished = await store.findParseAttempt?.(identity);
    const row = await store.findByBaseId?.(job.baseId);
    if (unfinished && ['pending', 'running'].includes(unfinished.status ?? '')
      && ['parsed', 'synthesized'].includes(row?.status ?? store.paperStatus ?? '')
      && unfinished.markdownPath && unfinished.contentListPath && unfinished.pageTextPath
      && Number.isInteger(Number(unfinished.pageCount))) {
      const completed = await store.finishParseAttempt?.(unfinished.attemptId, {
        outputDir: unfinished.outputDir,
        markdownPath: unfinished.markdownPath,
        contentListPath: unfinished.contentListPath,
        pageTextPath: unfinished.pageTextPath,
        pageCount: unfinished.pageCount,
        elapsedMs: unfinished.elapsedMs,
        exitCode: unfinished.exitCode ?? 0,
      });
      return recoveredReport(job, { ...unfinished, ...(completed && typeof completed === 'object' ? completed : {}), status: 'succeeded' });
    }
    if (await hasSuccessfulParse(store, job, false)) return { ...reportBase(job), status: 'skipped' };
  }
  if (!store.reserveParseAttempt) throw new Error('parse attempt store is required');
  const attempt = await store.reserveParseAttempt(job, { force: job.reparse === true });
  if (!attempt) return { ...reportBase(job), status: 'skipped' };
  await store.startParseAttempt?.(attempt.attemptId);
  let attemptJob = {
    ...job,
    attemptStartedAt: Date.now(),
    outputDir: job.outputDir ? join(job.outputDir, `attempt-${attempt.attemptId}`) : job.outputDir,
  };

  let execution: MinerUExecution;
  let workspace: ParseWorkspace | undefined;
  try {
    if (job.fileSource && job.outputDir) {
      workspace = await createParseWorkspace({ ...job, parseAttemptId: attempt.attemptId });
      attemptJob = { ...attemptJob, fileSource: workspace.fileSource, outputDir: workspace.root };
    }
    const runner = dependencies.runner ?? ((_localJob: LocalParseJob) => {
      throw Object.assign(new Error('MinerU session is required'), { code: 'MINERU_API_UNAVAILABLE' });
    });
    execution = await runner(attemptJob);
  } catch (caught) {
    const error = processError(caught);
    execution = { exitCode: 1, stderrSummary: error.message, elapsedMs: 0, errorCode: error.code, cleanupConfirmed: error.cleanupConfirmed };
  }
  if (Number(execution?.exitCode) !== 0 || execution?.cleanupConfirmed === false || execution?.errorCode === 'PROCESS_CLEANUP_UNCONFIRMED') {
    const errorClass = classifyProcessFailure(execution);
    if (errorClass !== 'process_cleanup_unconfirmed') await workspace?.diagnose();
    const errorMessage = redactErrorMessage(String(execution?.stderrSummary ?? execution?.stdoutSummary ?? 'MinerU CLI failed'));
    await store.failParseAttempt?.(attempt.attemptId, { errorClass, errorMessage, exitCode: execution?.exitCode });
    if (!(await hasSuccessfulParse(store, job, true))) await store.markParseFailed?.(job.baseId, errorClass);
    return { ...failureReport(job, attempt.attemptId, errorClass, errorMessage), ...(errorClass === 'process_cleanup_unconfirmed' ? { cleanupConfirmed: false, errorCode: 'PROCESS_CLEANUP_UNCONFIRMED' } : {}) };
  }

  try {
    const normalize = dependencies.normalize ?? normalizeLocalMinerUResult;
    const artifact = await normalize(attemptJob);
    let validated = await validateArtifact(attemptJob, artifact, dependencies);
    const finish = (result: NormalizedArtifact, archive: ParseArtifacts = {}) => store.finishParseAttempt?.(attempt.attemptId, {
      ...result, ...archive, outputDir: result.outputDir ?? attemptJob.outputDir,
      elapsedMs: execution?.elapsedMs, exitCode: execution?.exitCode ?? 0,
    });
    if (workspace) {
      const locksRoot = join(job.libraryPaths!.operationsRoot, 'locks');
      await safeMkdir(locksRoot);
      validated = await withRunLock(join(locksRoot, `.publish-${basename(workspace.destination)}.lock`), async () => {
        await store.assertParseAttemptCurrent?.(attempt.attemptId);
        return publishParseWorkspace(workspace!, validated, { ...job, parseAttemptId: attempt.attemptId }, finish);
      });
    }
    else await finish(validated);
    return {
      ...reportBase(job),
      attemptId: attempt.attemptId,
      status: 'succeeded',
      artifact: { ...validated, outputDir: validated.outputDir ?? attemptJob.outputDir },
      errorClass: null,
      errorMessage: null,
    };
  } catch (caught) {
    const error = processError(caught);
    await workspace?.diagnose();
    const errorClass = error.errorClass ?? 'invalid_artifact';
    const errorMessage = redactErrorMessage(String(error.message ?? error));
    await store.failParseAttempt?.(attempt.attemptId, { errorClass, errorMessage, exitCode: execution?.exitCode ?? 0 });
    if (!(await hasSuccessfulParse(store, job, true))) await store.markParseFailed?.(job.baseId, errorClass);
    if (error.retryWithOcr === true && job.isOcr !== true && (job.method ?? 'auto') !== 'ocr') {
      return runLocalParse({ ...job, method: 'ocr', retryOfMethod: job.method ?? 'auto', isOcr: true, reparse: job.reparse === true }, dependencies);
    }
    return failureReport(job, attempt.attemptId, errorClass, errorMessage);
  }
}

export { classifyProcessFailure };
