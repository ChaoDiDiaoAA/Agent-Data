import type { StateStore } from './state/state-store.ts';
import { isPaperLibrary, isResearchLibrary } from '../types/config.ts';
import type { PipelineConfig, PaperLibraryConfig, PaperPolicy, MinerUParseConfig, MinerUCliConfig, ResearchSourceKind } from '../types/config.ts';
import type { HarvestPlan, LocalPaper } from '../types/papers.ts';
import type { TaskParseJob, TaskDownloadedPaper, TaskResult } from '../types/jobs.ts';
import type { ParseDependencies, ParseStore } from '../mineru/mineru-local-jobs.ts';
import type { ProcessContext } from '../runtime/process.ts';
import type { LocalImportOptions } from './sources/local-pdf-import.ts';
import type { MineruApiSession } from '../mineru/mineru-api-session.ts';
import type { LibraryPaths } from '../shared/paths.ts';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { loadConfig } from '../shared/config.ts';
import { loadEngineContext } from '../shared/engine-context.ts';
import { asLibraryId, type LibraryId } from '../shared/identity.ts';
import { loadMinerULocalConfig } from '../mineru/mineru-local-config.ts';
import { bootstrapStageOne } from './bootstrap.ts';
import { openStateStore } from './state/state-store.ts';
import { assertTrackReachability, evaluateCandidate } from './selection/paper-policy.ts';
import { buildHarvestPlan } from '../discovery/harvest-plan.ts';
import { runHarvestShards } from '../discovery/opencli-runner.ts';
import { createHarvestCheckpointSession } from '../discovery/checkpoint.ts';
import { downloadAcceptedPdf } from './sources/pdf-store.ts';
import { buildLocalParseJob, buildLocalParseManifest, localParserConfigKey, writeLocalParseManifest, runLocalParse } from '../mineru/mineru-local-jobs.ts';
import { runTask } from './pipeline.ts';
import { reconcileLibraryArtifacts, repairDuplicatePdf } from '../maintenance/reconciliation.ts';
import { assessExtraction } from '../mineru/mineru-quality.ts';
import { normalizeLocalMinerUResult } from '../mineru/mineru-local-result.ts';
import { assertMinerURunnerConfig, validateMineruConfig } from '../mineru/mineru-cli-runner.ts';
import { notifyProgressObserver } from '../shared/progress.ts';
import { withRunLock } from '../runtime/run-lock.ts';
import { scanLocalPdfs } from './sources/local-pdf-files.ts';
import { importLocalPdfs } from './sources/local-pdf-import.ts';
import { createProcessContext } from '../runtime/process.ts';
import { readVerifiedRunSources } from '../evidence/archive-reader.ts';
import { EvidencePublicationError } from '../evidence/publisher.ts';
import { publishRunEvidence } from '../evidence/publication-service.ts';
import { runResearchTask, resumeResearchTask, type ResearchWorkflowDependencies, type ResearchRunResult } from '../research/research-workflow.ts';
import type { ResearchRunMode } from '../types/research-sources.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { readFile as readTextFile } from 'node:fs/promises';
import { readVerifiedResearchArchive } from '../research/source-archive.ts';
import { publishResearchEvidence, type ResearchEvidencePublicationStore } from '../evidence/source-publisher.ts';
import { researchCheckpointHash } from '../research/research-checkpoints.ts';
import { readSourcePublicationReceipt } from '../evidence/source-receipt-store.ts';
import { sha256 } from '../research/source-identity.ts';
export type Categories = { tracks: Record<string, { pdf: string }>; fallback_pdf?: string };
export type Config = PipelineConfig & { root?: string };
export interface RootContext { root?: string; jobId?: string; libraryId?: LibraryId }
export interface ResearchExecutionContext {
  dependencies: Omit<ResearchWorkflowDependencies, 'library' | 'stateRoot' | 'store'>;
  run?: typeof runResearchTask;
  resume?: typeof resumeResearchTask;
}
export interface ConfiguredContext { jobId?: string; libraryId?: LibraryId; resumeRunId?: string; onProgress?: import('../types/jobs.ts').ProgressReporter; openStateStore?: typeof openStateStore; bootstrap?: (config: Config, categories: Categories) => Promise<unknown>; harvest?: (shards: HarvestPlan['shards'], window: import('../types/jobs.ts').RunWindow, options: NonNullable<Parameters<typeof runHarvestShards>[2]> & { checkpoint: ReturnType<typeof createHarvestCheckpointSession> }) => ReturnType<typeof runHarvestShards>; executeTask?: typeof runTask; publishRunEvidence?: typeof publishRunEvidence; rules?: PaperPolicy; processContext?: ProcessContext; signal?: AbortSignal; runner?: ParseDependencies['runner']; mineruSession?: MineruApiSession }
export type ConfiguredResearchContext = ConfiguredContext & { research: ResearchExecutionContext };
type ReachConfig = { currentTask: { trackLimits: Record<string, number> }; arxiv?: Config['arxiv'] };
export interface BootstrapContext extends RootContext { config?: ReachConfig & { root?: string; pdfRoot: string; vaultRoot: string }; categories?: Categories; rules?: Pick<PaperPolicy, 'trackPriority'>; matrix?: unknown; plan?: { tracks: string[] }; bootstrap?: (config: Parameters<typeof bootstrapStageOne>[0], categories: Categories) => Promise<{ pdfDirectories?: number } | void> }
interface ParseRow { base_id?: string; baseId?: string; arxiv_id?: string | null; arxivId?: string; version?: number; sha256?: string | null; pdf_path?: string | null; pdfPath?: string; page_count?: number | null; pageCount?: number; downloaded_version?: number | null; status?: string; title?: string | null; primary_track?: string | null; primaryTrack?: string | null; matched_tracks?: string[]; matchedTracks?: string[] }
export interface ParseContext extends RootContext { config?: MinerUParseConfig & Partial<MinerUCliConfig> & { stateRoot?: string }; stateStore?: Omit<ParseStore, 'findByBaseId'> & { findByBaseId(id: string): ParseRow | undefined | Promise<ParseRow | undefined>; close?(): void }; processContext?: ProcessContext; signal?: AbortSignal; runner?: ParseDependencies['runner']; mineruSession?: MineruApiSession; normalize?: ParseDependencies['normalize']; assessExtraction?: ParseDependencies['assessExtraction']; validateLocalConfig?: typeof validateMineruConfig }
export interface ImportContext extends RootContext { resumeRunId?: string; confirmedImport?: import('./sources/import-preview.ts').ImportScan; config?: LocalImportOptions['config']; paths?: LibraryPaths; stateStore?: StateStore; processContext?: ProcessContext; signal?: AbortSignal; runner?: LocalImportOptions['runner']; mineruSession?: MineruApiSession; onProgress?: LocalImportOptions['onProgress']; publishRunEvidence?: typeof publishRunEvidence }
export interface EvidenceContext extends RootContext { onProgress?: import('../types/jobs.ts').ProgressReporter; openStateStore?: typeof openStateStore; readVerifiedRunSources?: typeof readVerifiedRunSources; publishRunEvidence?: typeof publishRunEvidence }
function compatibilityCategories(value: import('../types/config.ts').LibraryCategoryConfig): Categories {
  return { tracks: value.tracks, fallback_pdf: value.fallbackPdf };
}
function requireString(value: unknown, label: string): string { if (typeof value !== 'string' || !value) throw new Error(`${label} is required`); return value; }
function sessionRunner(session?: MineruApiSession): ParseDependencies['runner'] {
  return (job) => {
    if (!session) throw Object.assign(new Error('MinerU session is required'), { code: 'MINERU_API_UNAVAILABLE' });
    return session.run({
      ...job,
      fileSource: requireString(job.fileSource, 'fileSource'),
      outputDir: requireString(job.outputDir, 'outputDir'),
    });
  };
}
function downloadedPaper(paper: TaskDownloadedPaper): LocalPaper {
  if (typeof paper.version !== 'number' || !Number.isSafeInteger(paper.version) || paper.version < 1) throw new Error('invalid downloaded paper version');
  return { ...paper, version: paper.version, arxivId: requireString(paper.arxivId, 'arxivId'), sha256: requireString(paper.sha256, 'sha256') };
}
function parseJob(job: TaskParseJob): import('../types/jobs.ts').LocalParseJob {
  if (typeof job.version !== 'number' || !Number.isSafeInteger(job.version) || job.version < 1) throw new Error('invalid parse job version');
  return { ...job, version: job.version, model: requireString(job.model, 'model'), cliBackend: requireString(job.cliBackend, 'cliBackend'), sha256: requireString(job.sha256, 'sha256'), fileSource: job.fileSource ?? job.pdfPath };
}
const assertConfiguredTrackReachability = ({ config, matrix, rules, categories, plan }: { config: ReachConfig; matrix?: unknown; rules: Pick<PaperPolicy, 'trackPriority'>; categories: Categories; plan?: { tracks: string[] } }) => {
  const harvestPlan = plan ?? buildHarvestPlan({ matrix, trackLimits: config.currentTask.trackLimits, arxiv: config.arxiv ?? (() => { throw new Error('arxiv config is required'); })() });
  assertTrackReachability({ plan: harvestPlan, rules, trackLimits: config.currentTask.trackLimits, categories });
  return harvestPlan;
};

function requirePaperLibrary(library: import('../types/config.ts').LibraryConfig): PaperLibraryConfig {
  if (!isPaperLibrary(library)) throw new Error(`UNSUPPORTED_LIBRARY_KIND: ${library.kind}`);
  return library;
}

function rejectResearchPaperOperation(root: string, libraryId: LibraryId | undefined): void {
  if (!libraryId) return;
  const library = loadEngineContext({ root, libraryId }).library;
  if (isResearchLibrary(library)) throw new Error('UNSUPPORTED_LIBRARY_KIND: paper-only operation is not available for research libraries');
}

export function runConfiguredTask(input: TaskInput, root: string, context: ConfiguredResearchContext): Promise<ResearchRunResult>;
export function runConfiguredTask(input: TaskInput, root: string, context?: ConfiguredContext): Promise<TaskResult>;
export async function runConfiguredTask(input: TaskInput, root: string, context: ConfiguredContext | ConfiguredResearchContext = {}): Promise<TaskResult | ResearchRunResult> {
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  const layered = loadEngineContext({ root, libraryId });
  const { mode, limit, window } = input;
  if (isResearchLibrary(layered.library)) {
    if (mode !== 'current' && mode !== 'weekly' && mode !== 'backfill') throw new Error('run-task requires --mode current|weekly|backfill');
    if (!('research' in context) || !context.research) throw new Error('RESEARCH_WORKFLOW_UNCONFIGURED');
    const stateStore = (context.openStateStore ?? openStateStore)(layered.paths.databasePath);
    const dependencies: ResearchWorkflowDependencies = {
      ...context.research.dependencies,
      library: layered.library,
      stateRoot: layered.paths.dataRoot,
      store: stateStore as ResearchWorkflowDependencies['store'],
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    const request = {
      mode: mode as ResearchRunMode,
      ...(limit === undefined ? {} : { limit }),
      ...(window === undefined ? {} : { from: window.from, to: window.to }),
      ...(input.tracks === undefined ? {} : { tracks: input.tracks }),
      ...(input.sourceKinds === undefined ? {} : { sourceKinds: input.sourceKinds }),
    };
    try {
      if (context.resumeRunId) return await (context.research.resume ?? resumeResearchTask)(context.resumeRunId, request, dependencies);
      return await (context.research.run ?? runResearchTask)(request, dependencies);
    } finally {
      stateStore.close();
    }
  }
  if (mode !== 'current' && mode !== 'weekly') throw new Error('run-task requires --mode current|weekly');
  if (mode === 'weekly' && limit !== undefined) throw new Error('weekly run-task does not accept --limit');
  const library = requirePaperLibrary(layered.library);
  const pipelineConfig = loadConfig({ root, libraryId });
  const config: Config & ReturnType<typeof loadMinerULocalConfig> = { ...pipelineConfig, ...loadMinerULocalConfig(root, { stateRoot: pipelineConfig.stateRoot, libraryId }), root };
  const getProcessContext = () => context.processContext ?? createProcessContext(root, join(layered.paths.operationsRoot, 'locks', 'processes'));
  const matrix = { tracks: library.tracks };
  const rules = context.rules ?? library.paperPolicy;
  const categories = compatibilityCategories(library.categories);
  const plan = buildHarvestPlan({ matrix, trackLimits: config.currentTask.trackLimits, arxiv: config.arxiv });
  assertConfiguredTrackReachability({ config, matrix, rules, categories, plan });
  const stateStore = (context.openStateStore ?? openStateStore)(layered.paths.databasePath);
  const onProgress = context.onProgress ?? (() => {});
  try {
    return await (context.executeTask ?? runTask)({ mode, now: new Date().toISOString(), ...(limit === undefined ? {} : { limit }), windowOverride: window, resumeRunId: context.resumeRunId, jobId: context.jobId }, {
      config,
      store: stateStore,
      lockPath: join(requireString(config.stateRoot, 'stateRoot'), 'locks', 'paper-sync.lock'),
      runRoot: join(config.stateRoot, 'runs'),
      bootstrap: () => (context.bootstrap ?? bootstrapStageOne)(config, categories),
      discovery: {
        harvest: async ({ window, run }) => {
          const checkpoint = createHarvestCheckpointSession({ store: stateStore, runId: run.id, plan });
          if (run.resumed) {
            onProgress({
              type: 'task-resume',
              phase: 'task',
              runId: run.id,
              completedShards: checkpoint.completedKeys.size,
              totalShards: plan.shards.length,
            });
          }
          const papers = await (context.harvest ?? runHarvestShards)(plan.shards, window, { arxiv: config.arxiv, network: config.network, onProgress, checkpoint, projectRoot: root, tempRoot: config.tempRoot, processContext: getProcessContext(), signal: context.signal });
          return papers.map(paper => ({ ...paper, baseId: requireString(paper.baseId, 'harvest paper baseId') }));
        },
      },
      policy: { evaluate: (paper) => evaluateCandidate(paper, rules) },
      pdfStore: { download: (decision) => downloadAcceptedPdf(decision, { pdfRoot: config.pdfRoot, tempRoot: config.tempRoot, network: config.network, stateStore, categories: categories.tracks ?? {}, signal: context.signal }) },
      buildManifest: (runId, stored, run) => buildLocalParseManifest(runId, stored.map(downloadedPaper), config, run),
      writeManifest: writeLocalParseManifest,
      parseOne: (job) => runLocalParse({ ...parseJob(job), libraryPaths: layered.paths, libraryId }, {
        store: stateStore,
        config,
        processContext: context.processContext,
        signal: context.signal,
        runner: context.runner ?? sessionRunner(context.mineruSession),
      }),
      publishEvidence: async (runId, manifest) => {
        const publication = await (context.publishRunEvidence ?? publishRunEvidence)({
          runId,
          stateRoot: config.stateRoot,
          tempRoot: config.tempRoot,
          vaultRoot: config.vaultRoot,
          store: stateStore,
          lastSuccess: requireString(manifest.window?.to ?? stateStore.getRun(runId)?.to_utc, 'run completion watermark'),
          eligibility: 'normal',
        });
        return { publicationId: publication.publicationId, sourceCount: publication.sourceCount, replayed: publication.applyReplayed };
      },
      onProgress,
    });
  } finally {
    stateStore.close();
  }
}
function localPaperFromRow(row: ParseRow, pageCount: number): LocalPaper {
  const baseId = requireString(row.base_id ?? row.baseId, 'paper baseId');
  const version = Number(row.version ?? 1);
  return {
    ...row,
    baseId,
    arxivId: row.arxiv_id ?? row.arxivId ?? `${baseId}v${version}`,
    version,
    pdfPath: requireString(row.pdf_path ?? row.pdfPath, 'paper PDF path'),
    sha256: requireString(row.sha256, 'paper sha256'),
    pageCount: Number(row.page_count ?? row.pageCount ?? pageCount),
    title: row.title ?? baseId,
    primaryTrack: row.primary_track ?? row.primaryTrack ?? '99-Unclassified',
    matchedTracks: row.matched_tracks ?? row.matchedTracks ?? [],
    ...(baseId.startsWith('local-') ? { sourceType: 'local_pdf' } : {}),
  };
}

export async function bootstrapLibrary(context: BootstrapContext = {}) {
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  rejectResearchPaperOperation(root, context.libraryId);
  const config = context.config ?? loadConfig({ root, libraryId });
  const needsLayered = !context.categories || !context.rules || (!context.matrix && !context.plan);
  const layered = needsLayered ? loadEngineContext({ root, libraryId }) : undefined;
  const library = layered === undefined ? undefined : requirePaperLibrary(layered.library);
  const categories = context.categories ?? compatibilityCategories(library!.categories);
  const rules = context.rules ?? library!.paperPolicy;
  const matrix = context.matrix ?? (context.plan ? undefined : { tracks: library!.tracks });
  assertConfiguredTrackReachability({ config, matrix, rules, categories, plan: context.plan });
  const bootstrap = context.bootstrap ?? bootstrapStageOne;
  return bootstrap(config, categories);
}
export async function parseLocalPaper(input: { baseId: string; reparse?: boolean }, context: ParseContext = {}) {
  const root = context.root ?? process.cwd();
  rejectResearchPaperOperation(root, context.libraryId);
  let libraryPaths: LibraryPaths | undefined;
  const getLibraryPaths = () => libraryPaths ??= loadEngineContext({ root, libraryId: context.libraryId }).paths;
  const baseId = input.baseId;
  if (!baseId) throw new Error('parse-local requires --base-id BASE_ID');
  const config = context.config ?? (() => {
    const pipelineConfig = loadConfig({ root, libraryId: context.libraryId });
    return { ...pipelineConfig, ...loadMinerULocalConfig(root, { stateRoot: pipelineConfig.stateRoot, libraryId: context.libraryId }) };
  })();
  const stateStore = context.stateStore ?? openStateStore(getLibraryPaths().databasePath);
  const ownsStore = !context.stateStore;
  try {
    const row: ParseRow | undefined = await stateStore.findByBaseId(baseId);
    if (!row) throw new Error(`downloaded paper not found: ${baseId}`);
    const reparsing = Boolean(input.reparse);
    const status = row.status ?? 'downloaded';
    const allowed = status === 'downloaded' || status === 'parse_failed' || (reparsing && ['parsed', 'synthesized'].includes(status));
    if (!allowed) throw new Error(`parse-local requires downloaded or parse_failed paper: ${baseId}`);
    if (!context.runner && !context.mineruSession) {
      const validate = context.validateLocalConfig ?? validateMineruConfig;
      const processContext = context.processContext ?? createProcessContext(root, join(getLibraryPaths().operationsRoot, 'locks', 'processes'));
      assertMinerURunnerConfig(config);
      await validate(config, processContext);
    }
    const pdfPath = row.pdf_path ?? row.pdfPath;
    if (!pdfPath) throw new Error(`downloaded PDF not found: ${baseId}`);
    if ('downloaded_version' in row && Number(row.downloaded_version) !== Number(row.version)) {
      throw new Error(`PDF 版本尚未核实或与最新元数据不一致：${baseId}；请先运行当前任务完成下载`);
    }
    let pageCount = row.page_count ?? row.pageCount;
    if (!Number.isInteger(Number(pageCount))) pageCount = (await PDFDocument.load(readFileSync(pdfPath))).getPageCount();
    const paper = localPaperFromRow(row, Number(pageCount));
    const dependencies: ParseDependencies = {
      store: stateStore,
      processContext: context.processContext, signal: context.signal,
      runner: context.runner ?? sessionRunner(context.mineruSession),
      normalize: context.normalize ?? normalizeLocalMinerUResult,
      assessExtraction: context.assessExtraction ?? assessExtraction,
    };
    const job = {
      ...buildLocalParseJob(paper, config, { reparse: reparsing }),
      ...(paper.sourceType === 'local_pdf' ? { parserConfigKey: localParserConfigKey(config) } : {}),
    };
    const execute = () => runLocalParse(job, dependencies);
    return await (ownsStore ? withRunLock(join(requireString(config.stateRoot, 'stateRoot'), 'locks', 'paper-sync.lock'), execute, { jobId: context.jobId }) : execute());
  } finally {
    if (ownsStore) stateStore.close?.();
  }
}

export async function importLocalSources(input: { path: string; preview?: boolean; reparse?: boolean }, context: ImportContext = {}) {
  const root = context.root ?? process.cwd();
  rejectResearchPaperOperation(root, context.libraryId);
  const paths = context.paths ?? loadEngineContext({ root, libraryId: context.libraryId }).paths;
  const path = input.path;
  if (!path) throw new Error('import-local requires --path PDF_FILE_OR_FOLDER');
  const config = context.config ?? (() => {
    const pipelineConfig = loadConfig({ root, libraryId: context.libraryId });
    return { ...pipelineConfig, ...loadMinerULocalConfig(root, { stateRoot: pipelineConfig.stateRoot, libraryId: context.libraryId }) };
  })();
  if (!config.localImport) throw new Error('local import configuration is required');
  const importConfig = { ...config, localImport: config.localImport };
  const scan = context.confirmedImport ?? await scanLocalPdfs(path, importConfig);
  if (input.preview) return { status: 'preview', ...scan, fileCount: scan.files.length, model: config.model, outputRoot: config.outputRoot, localImport: config.localImport };
  if (!context.runner && !context.mineruSession) {
    const processContext = context.processContext ?? createProcessContext(root, join(paths.operationsRoot, 'locks', 'processes'));
    assertMinerURunnerConfig(config);
    await validateMineruConfig(config, processContext);
  }
  if (!context.stateStore) await mkdir(paths.dataRoot, { recursive: true });
  const store = context.stateStore ?? openStateStore(paths.databasePath);
  try {
    return await withRunLock(join(paths.operationsRoot, 'locks', 'paper-sync.lock'), () => importLocalPdfs(scan, {
      config: importConfig, paths, store, reparse: Boolean(input.reparse), resumeRunId: context.resumeRunId, runner: context.runner, mineruSession: context.mineruSession, processContext: context.processContext, signal: context.signal,
      onProgress: context.onProgress ?? (() => {}),
      publishRunEvidence: context.publishRunEvidence,
    }), { jobId: context.jobId });
  } finally { if (!context.stateStore) store.close(); }
}

export async function publishLibraryEvidence(runId: string, context: EvidenceContext = {}) {
  const root = context.root ?? process.cwd();
  if (!runId) throw new Error('evidence-publish requires --run-id RUN_ID');
  const layered = loadEngineContext({ root, libraryId: context.libraryId });
  if (isResearchLibrary(layered.library)) {
    const paths = layered.paths;
    const store = (context.openStateStore ?? openStateStore)(paths.databasePath) as ResearchWorkflowDependencies['store'] & { close(): void };
    try {
      const run = store.getResearchRun(runId);
      if (!run) throw new Error(`research run not found: ${runId}`);
      const selectionPath = join(paths.dataRoot, 'runs', runId, 'selection.json');
      const selectionRaw = await readTextFile(selectionPath, 'utf8');
      const selection = JSON.parse(selectionRaw) as { selected?: Array<{ source: { sourceId: string; kind: ResearchSourceKind }; version: { versionId: string } }> };
      if (canonicalJson(selection) !== selectionRaw || !Array.isArray(selection.selected)) throw new Error('RESEARCH_SELECTION_INVALID');
      const selectionHash = (await readTextFile(join(paths.dataRoot, 'runs', runId, 'selection.sha256'), 'utf8')).trim();
      if (researchCheckpointHash(selection) !== selectionHash) throw new Error('RESEARCH_SELECTION_INVALID');
      const archives = await Promise.all(selection.selected.map(candidate => readVerifiedResearchArchive(
        join(paths.dataRoot, 'archive', 'sources', candidate.source.kind, candidate.source.sourceId, candidate.version.versionId),
        { libraryId: layered.library.libraryId, sourceId: candidate.source.sourceId, versionId: candidate.version.versionId },
      )));
      notifyProgressObserver(context.onProgress, { type: 'evidence-publish-start', phase: 'evidence-publish', runId, sourceCount: archives.length });
      const publication = await publishResearchEvidence({
        runId,
        stateRoot: paths.dataRoot,
        tempRoot: paths.workRoot,
        vaultRoot: paths.vaultRoot,
        store: store as unknown as ResearchEvidencePublicationStore,
        selectionHash,
        archives,
      });
      notifyProgressObserver(context.onProgress, { type: 'evidence-publish-complete', phase: 'evidence-publish', runId, sourceCount: publication.sourceCount,
        publicationId: publication.publicationId, replayed: publication.replayed });
      return { status: 'completed', runId, publicationId: publication.publicationId, sourceCount: publication.sourceCount, replayed: publication.replayed };
    } finally { store.close(); }
  }
  const config = loadConfig({ root, libraryId: context.libraryId });
  const paths = loadEngineContext({ root, libraryId: context.libraryId }).paths;
  const store = (context.openStateStore ?? openStateStore)(paths.databasePath);
  try {
    const run = store.getRun(runId);
    let sources;
    try {
      sources = await (context.readVerifiedRunSources ?? readVerifiedRunSources)({ runId, stateRoot: config.stateRoot, store });
    } catch (error) {
      if (run?.status === 'failed') {
        throw new EvidencePublicationError('EVIDENCE_CONFLICT', 'failed run does not have a complete verified Archive set');
      }
      throw error;
    }
    notifyProgressObserver(context.onProgress, { type: 'evidence-publish-start', phase: 'evidence-publish', runId, sourceCount: sources.length });
    const publication = await (context.publishRunEvidence ?? publishRunEvidence)({
      runId,
      stateRoot: config.stateRoot,
      tempRoot: config.tempRoot,
      vaultRoot: config.vaultRoot,
      store,
      lastSuccess: requireString(run?.to_utc, 'run completion watermark'),
      eligibility: run?.status === 'failed' ? 'failed-recovery' : 'normal',
    });
    notifyProgressObserver(context.onProgress, { type: 'evidence-publish-complete', phase: 'evidence-publish', runId, sourceCount: publication.sourceCount,
      publicationId: publication.publicationId, replayed: publication.applyReplayed });
    return { status: 'completed', runId, publicationId: publication.publicationId, sourceCount: publication.sourceCount, replayed: publication.applyReplayed };
  } finally { store.close(); }
}

export async function reconcileLibrary(input: { baseId?: string; keepPath?: string }, context: RootContext = {}) {
  const root = context.root ?? process.cwd();
  const layered = loadEngineContext({ root, libraryId: context.libraryId });
  if (isResearchLibrary(layered.library)) {
    if (input.baseId || input.keepPath) throw new Error('UNSUPPORTED_LIBRARY_KIND: PDF duplicate repair is not available for research libraries');
    const entries = [] as { path: string; sourceId: string; versionId: string; status: 'verified' | 'error'; error?: string }[];
    const sourceRoot = join(layered.paths.archiveRoot, 'sources');
    const walk = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as import('node:fs').Dirent[];
        throw error;
      });
      for (const child of children) {
        const path = join(directory, child.name);
        if (child.isDirectory()) { await walk(path); continue; }
        if (child.name !== 'source.json') continue;
        try {
          const archive = await readVerifiedResearchArchive(resolve(directory));
          entries.push({ path: resolve(directory), sourceId: archive.manifest.sourceId, versionId: archive.manifest.versionId, status: 'verified' });
        } catch (error) {
          entries.push({ path: resolve(directory), sourceId: '', versionId: '', status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await walk(sourceRoot);
    const stateStore = openStateStore(layered.paths.databasePath);
    try {
      const researchState = stateStore as typeof stateStore & {
        listResearchSources(): Array<{ sourceId: string; kind: ResearchSourceKind }>;
        listAllResearchSourceVersions(): Array<{ sourceId: string; versionId: string; archivePath: string }>;
      };
      const databaseSources = researchState.listResearchSources();
      const databaseVersions = researchState.listAllResearchSourceVersions();
      const archiveKeys = new Set(entries.filter(item => item.status === 'verified').map(item => `${item.sourceId}/${item.versionId}`));
      const databaseKeys = new Set(databaseVersions.map(item => `${item.sourceId}/${item.versionId}`));
      const receipts: Array<{ runId: string; sourceCount: number; status: 'verified' | 'error'; error?: string }> = [];
      const runEntries = await readdir(layered.paths.runsRoot, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as import('node:fs').Dirent[];
        throw error;
      });
      const sourceKindById = new Map(databaseSources.map(source => [source.sourceId, source.kind]));
      for (const run of runEntries.filter(entry => entry.isDirectory())) {
        const receiptPath = join(layered.paths.runsRoot, run.name, 'evidence', 'source-publication.json');
        try {
          const receipt = await readSourcePublicationReceipt(receiptPath);
          if (!receipt) continue;
          for (const source of receipt.sources) {
            const kind = sourceKindById.get(source.sourceId);
            if (!kind || !archiveKeys.has(`${source.sourceId}/${source.versionId}`)) throw new Error('receipt source is not backed by a verified Archive');
            const manifestPath = join(layered.paths.vaultRoot, 'Evidence', 'sources', kind, source.sourceId, source.versionId, 'manifest.json');
            const manifestBytes = await readFile(manifestPath);
            if (sha256(manifestBytes) !== source.evidenceManifestSha256) throw new Error('Evidence manifest hash differs from receipt');
          }
          receipts.push({ runId: run.name, sourceCount: receipt.sources.length, status: 'verified' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          receipts.push({ runId: run.name, sourceCount: 0, status: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        kind: 'research', archives: entries,
        archiveCount: archiveKeys.size, errorCount: entries.filter(item => item.status === 'error').length,
        databaseSourceCount: databaseSources.length, databaseVersionCount: databaseKeys.size,
        missingDatabaseVersions: [...archiveKeys].filter(key => !databaseKeys.has(key)).sort(),
        missingArchiveVersions: [...databaseKeys].filter(key => !archiveKeys.has(key)).sort(),
        receipts, receiptCount: receipts.filter(receipt => receipt.status === 'verified').length,
        receiptErrorCount: receipts.filter(receipt => receipt.status === 'error').length,
      };
    } finally { stateStore.close(); }
  }
  const config = loadConfig({ root, libraryId: context.libraryId });
  const paths = loadEngineContext({ root, libraryId: context.libraryId }).paths;
  const stateStore = openStateStore(paths.databasePath);
  try {
    const { baseId, keepPath } = input;
    if (Boolean(baseId) !== Boolean(keepPath)) throw new Error('duplicate PDF repair requires both --repair-duplicate-pdf and --keep');
    if (baseId && keepPath) return repairDuplicatePdf(baseId, resolve(keepPath), { store: stateStore, pdfRoot: config.pdfRoot });
    return reconcileLibraryArtifacts({ rows: stateStore.exportManifest(), exists: async path => existsSync(path),
      pdfRoot: config.pdfRoot, archiveRoot: paths.archiveRoot, vaultRoot: paths.vaultRoot });
  } finally { stateStore.close(); }
}


export interface TaskInput { mode: string | null | undefined; limit?: number; window?: import("../types/jobs.ts").RunWindow; tracks?: string[]; sourceKinds?: ResearchSourceKind[] }
