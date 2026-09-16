import type { StateStore } from '../library/state/state-store.ts';
import { existsSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { loadConfig } from '../shared/config.ts';
import { loadEngineContext } from '../shared/engine-context.ts';
import { asLibraryId, type LibraryId } from '../shared/identity.ts';
import { loadMinerULocalConfig } from '../mineru/mineru-local-config.ts';
import { openReadOnlyStateStore, openStateStore } from '../library/state/state-store.ts';
import { buildHarvestPlan } from '../discovery/harvest-plan.ts';
import { taskPaperLimit } from '../library/selection/task-selection.ts';
import { buildScheduleDescriptor } from '../library/schedule/schedule-config.ts';
import { createTerminalProgressReporter } from './progress.ts';
import { randomUUID } from 'node:crypto';
import { admitOperation } from '../library/operations/operation-store.ts';
import { executeOperation } from '../library/workflow.ts';
import { validateRequest, type SubmitRequest } from '../library/operations/operation-contracts.ts';
import { applyEvidenceMigration, createEvidenceMigrationInventory, refreshEvidenceMigrationMetadata } from '../maintenance/evidence-migration.ts';
import { applyArchiveMigration, createArchiveMigrationPlan, type ArchiveMigrationInput } from '../maintenance/archive-migration.ts';
import { applyLibraryStatePlan, createLibraryStatePlan, type LibraryStateInput } from '../maintenance/library-state-migration.ts';
import { applyVaultRebuild, createVaultRebuildPlan, type VaultRebuildInput } from '../maintenance/vault-rebuild.ts';
import { applyRendererUpgradeBaseline, createRendererUpgradeBaseline, readRendererUpgradeBaseline, type RendererUpgradeBaselineInput } from '../maintenance/publication-baseline.ts';
import { historicalStateDatabasePath } from '../library/state/state-store.ts';
import { canonicalJson } from '../shared/manifest.ts';
import { applyVaultCleanup, createVaultCleanupReview, publicVaultCleanupPlan } from '../maintenance/vault-cleanup.ts';
import { applyCleanupPlan, createCleanupPlan, type CleanupPlanInput } from '../maintenance/cleanup-plan.ts';
import { prepareOpenCli } from '../discovery/opencli-install.ts';
import { runArxivProbe, type ArxivProbeOptions } from '../discovery/arxiv-probe.ts';
import { runConfiguredTask as executeConfiguredTask, bootstrapLibrary, parseLocalPaper, importLocalSources, publishLibraryEvidence, reconcileLibrary, type Config, type RootContext, type ConfiguredContext, type BootstrapContext, type ParseContext, type ImportContext, type EvidenceContext, type ResearchExecutionContext } from '../library/execution.ts';
import { resolveTaskWindow } from '../library/schedule/run-window.ts';
import type { EngineContext } from '../types/config.ts';
import type { MainContext } from './context.ts';
import { runWorker } from '../library/worker.ts';
import { bridgeMain } from '../library/operations/job-bridge.ts';
import { runWindowsJobLauncher } from '../runtime/windows-job-launcher.ts';
import { runProcessSupervisor } from '../runtime/process-supervisor.ts';
import { LEGACY_ARCHIVE_RELATIVE_PATH, LEGACY_STATE_RELATIVE_PATH, LEGACY_CODE_ROOT, LEGACY_PDF_ROOT, LEGACY_VAULT_ROOT } from '../shared/historical-compatibility.ts';
import { libraryCleanupInput } from '../library/workflow.ts';
import { isPaperLibrary, isResearchLibrary, type LibraryKind, type ResearchSourceKind } from '../types/config.ts';
import { createResearchExecutionContext } from '../research/cli-runtime.ts';
interface ConfigContext extends RootContext { config?: Config; matrix?: unknown; systemTimezone?: string }
interface MineruContext extends RootContext { config?: ReturnType<typeof loadMinerULocalConfig>; stageConfig?: Pick<Config, 'stateRoot'> }
interface EvidenceMigrationContext extends RootContext {
  config?: Pick<Config, 'stateRoot' | 'vaultRoot' | 'tempRoot'>;
  store?: StateStore;
  refreshMetadata?: (identity: { baseId: string; arxivId: string; version: number }) => Promise<import('../types/papers.ts').StoredSourceMetadataV1>;
}
interface VaultCleanupContext extends RootContext {
  config?: Pick<Config, 'vaultRoot' | 'backupRoot'>;
  confirmApply?: () => boolean | Promise<boolean>;
}
interface CleanupContext extends RootContext { input?: CleanupPlanInput }
interface ArxivCheckContext extends ConfigContext { probe?: (options: ArxivProbeOptions) => Promise<unknown> }
interface RendererBaselineContext extends RootContext { input?: RendererUpgradeBaselineInput }
export interface ResearchImportArguments { path: string; kind: 'local-artifact'; track: string }
const argValue = (args: string[], name: string, fallback: string | null = null) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const has = (args: string[], name: string) => args.includes(name);

type CliSummaryRecord = Record<string, unknown>;

function summaryRecord(value: unknown): CliSummaryRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CliSummaryRecord : undefined;
}

function summaryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

function operationLabel(command: string): string {
  return ({
    bootstrap: '初始化',
    'run-task': '任务',
    'import-local': '导入',
    'parse-local': '解析',
    'evidence-publish': 'Evidence',
    reconcile: '对账',
  } as Record<string, string>)[command] ?? command;
}

/** Keep human-facing CLI completion output short; callers with `context.output` still receive the full result. */
export function formatCliOperationSummary(command: string, job: unknown, business?: unknown): string {
  const jobRecord = summaryRecord(job);
  const businessRecord = summaryRecord(business);
  const status = summaryText(jobRecord?.status) ?? summaryText(businessRecord?.status) ?? 'completed';
  const label = operationLabel(command);

  if (status === 'failed' || status === 'blocked') {
    const stage = summaryText(jobRecord?.stage) ?? summaryText(businessRecord?.failedPhase);
    const runId = summaryText(jobRecord?.runId) ?? summaryText(businessRecord?.runId);
    const jobError = summaryRecord(jobRecord?.error);
    const businessError = summaryRecord(businessRecord?.error);
    const reason = summaryText(jobError?.message)
      ?? summaryText(jobError?.code)
      ?? summaryText(businessError?.message)
      ?? summaryText(businessError?.code)
      ?? summaryText(businessRecord?.errorMessage)
      ?? (typeof businessRecord?.error === 'string' ? summaryText(businessRecord.error) : undefined);
    const details = [stage, runId ? `runId=${runId}` : undefined, reason ? `原因：${reason}` : undefined].filter((item): item is string => Boolean(item));
    return `[${label}] ${status === 'blocked' ? '阻塞' : '失败'}${details.length ? `：${details.join('；')}` : ''}`;
  }

  if (status === 'completed' || status === 'succeeded' || status === 'already_processed' || status === 'skipped' || status === 'applied') {
    let details: string | undefined;
    const baseId = summaryText(businessRecord?.baseId);
    if (command === 'run-task' && typeof businessRecord?.paperCount === 'number') details = `已处理 ${businessRecord.paperCount} 篇论文`;
    else if (command === 'evidence-publish' && typeof businessRecord?.sourceCount === 'number') details = `已发布 ${businessRecord.sourceCount} 个来源`;
    else if (command === 'import-local' && typeof businessRecord?.paperCount === 'number') details = `已导入 ${businessRecord.paperCount} 篇论文`;
    else if (command === 'parse-local' && baseId) details = `已解析 ${baseId}`;
    return `[${label}] 成功${details ? `：${details}` : ''}`;
  }

  return `[${label}] ${status}`;
}

function parseTaskWindow(args: string[]) { return resolveTaskWindow(argValue(args, '--from'), argValue(args, '--to')); }

const researchSourceKinds = new Set<ResearchSourceKind>([
  'paper', 'technical-report', 'official-doc', 'specification', 'repository',
  'release', 'evaluation-method', 'local-artifact',
]);

/** Strict parser for the only CLI path that grants a local research source. */
export function parseResearchImportArguments(args: string[]): ResearchImportArguments {
  const values = new Map<string, string>();
  const known = new Set(['--path', '--kind', '--track', '--format']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!known.has(flag)) throw new Error(`UNKNOWN_ARGUMENT: ${flag}`);
    if (values.has(flag)) throw new Error(`DUPLICATE_ARGUMENT: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE: ${flag}`);
    values.set(flag, value);
  }
  const path = values.get('--path');
  const kind = values.get('--kind');
  const track = values.get('--track');
  if (!path) throw new Error('PATH_REQUIRED: import-source requires --path ABSOLUTE_PATH');
  if (!win32.isAbsolute(path)) throw new Error('ABSOLUTE_PATH_REQUIRED: --path must be an absolute path');
  if (!kind) throw new Error('SOURCE_KIND_REQUIRED: import-source requires --kind');
  if (values.has('--format') && values.get('--format') !== 'json') throw new Error('import-source supports only --format json');
  if (!researchSourceKinds.has(kind as ResearchSourceKind)) throw new Error(`INVALID_SOURCE_KIND: ${kind}`);
  if (kind !== 'local-artifact') throw new Error('LOCAL_ARTIFACT_KIND_REQUIRED: local imports must use --kind local-artifact');
  if (!track || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(track)) throw new Error('INVALID_TRACK: --track must be a safe Track id');
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('INVALID_PATH: --path contains control characters');
  return { path, kind: 'local-artifact', track };
}

export function routeSourceConfig(args: string[] = [], context: RootContext = {}) {
  const format = argValue(args, '--format');
  if (format && format !== 'json') throw new Error('source-config supports only --format json');
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId;
  if (!libraryId) throw new Error('LIBRARY_ID_REQUIRED: source-config requires --library');
  const layered = loadEngineContext({ root, libraryId });
  if (!isResearchLibrary(layered.library)) throw new Error('UNSUPPORTED_LIBRARY_KIND: source-config requires a research library');
  const library = layered.library;
  return {
    kind: library.kind,
    libraryId: library.libraryId,
    displayName: library.displayName,
    startDate: library.startDate,
    maxSources: library.currentTask.maxSources,
    weeklyMaxSources: library.weeklySchedule.maxSources,
    sourceKinds: [...library.sourcePolicy.sourceKinds],
    allowedDomains: [...library.sourcePolicy.allowedDomains],
    dateLowerBound: library.sourcePolicy.dateLowerBound,
    tracks: library.tracks.map(track => ({
      id: track.id, query: track.query, sourceKinds: [...track.sourceKinds], arxivCategories: [...track.arxivCategories],
      domains: [...track.domains], dateFields: [...track.dateFields],
    })),
    roots: {
      dataRoot: layered.paths.dataRoot,
      archiveRoot: layered.paths.archiveRoot,
      runsRoot: layered.paths.runsRoot,
      operationsRoot: layered.paths.operationsRoot,
      workRoot: layered.paths.workRoot,
      backupRoot: layered.paths.backupRoot,
      vaultRoot: layered.paths.vaultRoot,
    },
  };
}

export async function runConfiguredTask(args: string[], root: string, context: ConfiguredContext = {}) {
  return executeConfiguredTask({ mode: argValue(args, '--mode'), ...(has(args, '--limit') ? { limit: Number(argValue(args, '--limit')) } : {}), window: parseTaskWindow(args) }, root, { ...context, onProgress: context.onProgress ?? createTerminalProgressReporter() });
}
export async function routeBootstrap(_args: string[], context: BootstrapContext = {}) { return bootstrapLibrary(context); }
export async function routeParseLocal(args: string[], context: ParseContext = {}) { return parseLocalPaper({ baseId: argValue(args, '--base-id') ?? '', reparse: has(args, '--reparse') }, context); }
export async function routeImportLocal(args: string[], context: ImportContext = {}) { return importLocalSources({ path: argValue(args, '--path') ?? '', preview: has(args, '--preview'), reparse: has(args, '--reparse') }, { ...context, onProgress: context.onProgress ?? createTerminalProgressReporter() }); }
export async function routeEvidencePublish(args: string[], context: EvidenceContext = {}) { return publishLibraryEvidence(argValue(args, '--run-id') ?? '', context); }
export async function routeReconcile(args: string[], context: RootContext = {}) { return reconcileLibrary({ baseId: argValue(args, '--repair-duplicate-pdf') ?? undefined, keepPath: argValue(args, '--keep') ?? undefined }, context); }
export function routeScheduleConfig(args: string[] = [], context: ConfigContext = {}) {
  const format = argValue(args, '--format');
  if (format && format !== 'json') throw new Error('schedule-config supports only --format json');
  const root = context.root ?? process.cwd();
  const systemTimezone = context.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const layered = context.libraryId ? loadEngineContext({ root, libraryId: context.libraryId }) : undefined;
  if (layered && isResearchLibrary(layered.library)) {
    return buildScheduleDescriptor(layered.library, root, systemTimezone, { libraryId: layered.library.libraryId });
  }
  const config = context.config ?? loadConfig({ root, libraryId: context.libraryId });
  return buildScheduleDescriptor(config, root, systemTimezone, { libraryId: context.libraryId });
}

export function routeHarvestPlan(args: string[] = [], context: ConfigContext = {}) {
  if (argValue(args, '--format') !== 'json') throw new Error('harvest-plan requires --format json');
  const mode = argValue(args, '--mode', 'current');
  if (mode !== 'current' && mode !== 'weekly') throw new Error('harvest-plan requires --mode current|weekly');
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  const config = context.config ?? loadConfig({ root, libraryId });
  const matrix = context.matrix ?? { tracks: loadEngineContext({ root, libraryId }).library.tracks };
  const plan = buildHarvestPlan({
    matrix,
    trackLimits: config.currentTask.trackLimits,
    arxiv: config.arxiv,
  });
  return {
    trackCount: plan.tracks.length,
    totalShards: plan.totalShards,
    submittedShards: plan.shards.filter((item) => item.dateMode === 'submitted').length,
    updatedShards: plan.shards.filter((item) => item.dateMode === 'updated').length,
    maximumCandidateObservations: plan.maximumCandidateObservations,
    maxPapers: taskPaperLimit(config, mode),
  };
}

export function routeMineruConfig(args: string[] = [], context: MineruContext = {}) {
  const format = argValue(args, '--format');
  if (format && format !== 'json') throw new Error('mineru-config supports only --format json');
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  const layered = loadEngineContext({ root, libraryId });
  if (!isPaperLibrary(layered.library)) throw new Error('UNSUPPORTED_LIBRARY_KIND: MinerU is only available for paper libraries');
  const stageConfig = context.stageConfig ?? loadConfig({ root, libraryId });
  const config = context.config ?? loadMinerULocalConfig(root, { stateRoot: stageConfig.stateRoot, libraryId });
  return {
    configFile: join(root, 'config', 'engine.yaml'),
    sourceRoot: config.sourceRoot,
    expectedVersion: config.expectedVersion,
    expectedCommit: config.expectedCommit,
    pythonVersion: config.pythonVersion,
    venvRoot: config.venvRoot,
    modelSourceSetup: config.modelSourceSetup,
    modelSourceRuntime: config.modelSourceRuntime,
    modelScopeRevision: config.modelScopeRevision,
    modelDownloadType: config.modelDownloadType,
    modelsRoot: config.modelsRoot,
    modelScopeCacheRoot: config.modelScopeCacheRoot,
    mineruToolsConfig: config.mineruToolsConfig,
    pipelineModelsDir: config.pipelineModelsDir,
    vlmModelsDir: config.vlmModelsDir,
    pipelineModelRepository: config.pipelineModelRepository,
    pipelineRequiredPaths: config.pipelineRequiredPaths,
    vlmModelRepository: config.vlmModelRepository,
    expectedGpuName: config.expectedGpuName,
    mineruInstallExtras: config.mineruInstallExtras,
    torchIndexUrl: config.torchIndexUrl,
    lmdeployWheelUrl: config.lmdeployWheelUrl,
    cudaRuntimeDll: config.cudaRuntimeDll,
    model: config.model,
    allowedModels: config.allowedModels,
    cliBackend: config.cliBackend,
    maxConcurrency: config.maxConcurrency,
    processingWindowSize: config.processingWindowSize,
    pipelineBatchRatio: config.pipelineBatchRatio,
    cudaVisibleDevices: config.cudaVisibleDevices,
    pipelineDeviceMode: config.pipelineDeviceMode,
    pipelineMethod: config.pipelineMethod,
    pipelineLanguage: config.pipelineLanguage,
    formulaEnabled: config.formulaEnabled,
    tableEnabled: config.tableEnabled,
    vlmDevice: config.vlmDevice,
    vlmLmdeployBackend: config.vlmLmdeployBackend,
    vlmBatchSize: config.vlmBatchSize,
    vlmCacheMaxEntryCount: config.vlmCacheMaxEntryCount,
    taskTimeoutSeconds: config.taskTimeoutMs / 1000,
    resultDownloadTimeoutSeconds: config.resultDownloadTimeoutMs / 1000,
    apiHost: config.apiHost,
    apiPort: config.apiPort,
    apiUrl: `http://${config.apiHost}:${config.apiPort}`,
    apiStartupTimeoutSeconds: config.apiStartupTimeoutMs / 1000,
    outputRoot: config.outputRoot,
    modelLockPath: join(stageConfig.stateRoot, 'runs', 'mineru-model-lock.json'),
  };
}

export async function routeArxivCheck(args: string[] = [], context: ArxivCheckContext = {}) {
  if (argValue(args, '--format') !== 'json') throw new Error('arxiv-check requires --format json');
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  const config = context.config ?? loadConfig({ root, libraryId });
  const probe = context.probe ?? runArxivProbe;
  return probe({ arxiv: config.arxiv, network: config.network, projectRoot: root, tempRoot: config.tempRoot });
}

/** No store, bootstrap, operation admission, or implicit plan-file writes. */
export async function routeArchiveMigrate(args: string[], context: RootContext & { input?: ArchiveMigrationInput } = {}) {
  const values = new Map<string, string | true>();
  const flags = new Set(['--dry-run', '--apply']);
  const options = new Set(['--format', '--plan-file', '--plan-sha256', '--source-root']);
  const invalid = (): never => { throw new Error('ARCHIVE_MIGRATION_ARGUMENTS: use --dry-run --format json or --apply --plan-file FILE --plan-sha256 SHA256 [--source-root ABSOLUTE_PATH]'); };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (values.has(key)) invalid();
    if (flags.has(key)) values.set(key, true);
    else if (options.has(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) invalid();
      values.set(key, value!);
    } else invalid();
  }
  const dryRun = values.has('--dry-run');
  if (dryRun === values.has('--apply')) invalid();
  if (dryRun) {
    if (values.get('--format') !== 'json' || values.has('--plan-file') || values.has('--plan-sha256')) invalid();
  } else if (values.has('--format') || !values.has('--plan-file') || !/^[0-9a-f]{64}$/.test(String(values.get('--plan-sha256')))) invalid();
  const libraryId = context.libraryId ?? context.input?.libraryId ?? asLibraryId('fsd');
  const paths = context.input?.paths ?? loadEngineContext({ root: context.root ?? process.cwd(), libraryId }).paths;
  const sourceRoot = values.get('--source-root');
  if (!context.input && !sourceRoot && libraryId !== 'fsd') invalid();
  const input: ArchiveMigrationInput = { libraryId, paths,
    legacyArchiveRoot: typeof sourceRoot === 'string' ? sourceRoot : context.input?.legacyArchiveRoot ?? resolve(paths.dataRoot, LEGACY_ARCHIVE_RELATIVE_PATH) };
  if (dryRun) return createArchiveMigrationPlan(input);
  return applyArchiveMigration({ ...input, planFile: resolve(String(values.get('--plan-file'))), planSha256: String(values.get('--plan-sha256')) });
}

/** Offline state migration never admits operations or implicitly writes a plan. */
export async function routeLibraryMigrate(args: string[], context: RootContext & { input?: LibraryStateInput } = {}) {
  const values = new Map<string, string | true>();
  const flags = new Set(['--dry-run', '--apply']);
  const options = new Set(['--format', '--plan-file', '--plan-sha256', '--source-root', '--pdf-root']);
  const invalid = (): never => { throw new Error('LIBRARY_MIGRATION_ARGUMENTS: use --dry-run --format json or --apply --plan-file FILE --plan-sha256 SHA256 [--source-root ABSOLUTE_PATH --pdf-root ABSOLUTE_PATH]'); };
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (values.has(name)) invalid();
    if (flags.has(name)) values.set(name, true);
    else if (options.has(name)) { const value = args[++i]; if (!value || value.startsWith('--')) invalid(); values.set(name, value!); }
    else invalid();
  }
  const dryRun = values.has('--dry-run');
  if (dryRun === values.has('--apply')) invalid();
  if (dryRun) { if (values.get('--format') !== 'json' || values.has('--plan-file') || values.has('--plan-sha256')) invalid(); }
  else if (values.has('--format') || !values.has('--plan-file') || !/^[0-9a-f]{64}$/.test(String(values.get('--plan-sha256')))) invalid();
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? context.input?.libraryId ?? asLibraryId('fsd');
  const paths = context.input?.paths ?? loadEngineContext({ root, libraryId }).paths;
  if (context.input && context.libraryId && context.input.libraryId !== context.libraryId) invalid();
  if (!context.input && libraryId !== 'fsd' && (!values.has('--source-root') || !values.has('--pdf-root'))) invalid();
  const legacyStateRoot = String(values.get('--source-root') ?? context.input?.legacyStateRoot ?? resolve(paths.dataRoot, LEGACY_STATE_RELATIVE_PATH));
  const legacyPdfRoot = String(values.get('--pdf-root') ?? context.input?.legacyPdfRoot ?? LEGACY_PDF_ROOT);
  const input: LibraryStateInput = { legacyStateRoot, legacyPdfRoot, libraryId, paths,
    pathRewrites: context.input ? context.input.pathRewrites : [
      { from: resolve(legacyStateRoot, '..'), to: paths.dataRoot },
      { from: LEGACY_CODE_ROOT, to: resolve(root) },
      { from: LEGACY_VAULT_ROOT, to: loadEngineContext({ root, libraryId }).paths.vaultRoot },
    ] };
  if (dryRun) return createLibraryStatePlan(input);
  return applyLibraryStatePlan({ ...input, planFile: resolve(String(values.get('--plan-file'))), planSha256: String(values.get('--plan-sha256')) });
}

/** Offline Vault rebuild does not admit operations or create implicit runtime state. */
export async function routeVaultRebuild(args: string[], context: RootContext & { input?: VaultRebuildInput } = {}) {
  const values = new Map<string, string | true>();
  const flags = new Set(['--dry-run', '--apply']);
  const options = new Set(['--format', '--plan-file', '--plan-sha256', '--source-root']);
  const invalid = (): never => { throw new Error('VAULT_REBUILD_ARGUMENTS: use --dry-run --format json or --apply --plan-file FILE --plan-sha256 SHA256 [--source-root ABSOLUTE_PATH]'); };
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (values.has(name)) invalid();
    if (flags.has(name)) values.set(name, true);
    else if (options.has(name)) { const value = args[++i]; if (!value || value.startsWith('--')) invalid(); values.set(name, value!); }
    else invalid();
  }
  const dryRun = values.has('--dry-run');
  if (dryRun === values.has('--apply')) invalid();
  if (dryRun) { if (values.get('--format') !== 'json' || values.has('--plan-file') || values.has('--plan-sha256')) invalid(); }
  else if (values.has('--format') || !values.has('--plan-file') || !/^[0-9a-f]{64}$/.test(String(values.get('--plan-sha256')))) invalid();
  const libraryId = context.libraryId ?? context.input?.libraryId ?? asLibraryId('fsd');
  if (context.input && context.libraryId && context.input.libraryId !== context.libraryId) invalid();
  if (!context.input && libraryId !== 'fsd' && !values.has('--source-root')) invalid();
  const paths = context.input ?? loadEngineContext({ root: context.root ?? process.cwd(), libraryId }).paths;
  const input: VaultRebuildInput = { libraryId, archiveRoot: paths.archiveRoot, vaultRoot: paths.vaultRoot,
    runtimeRoots: 'runtimeRoots' in paths ? paths.runtimeRoots : {
      dataRoot: paths.dataRoot, workRoot: paths.workRoot, runsRoot: paths.runsRoot,
      operationsRoot: paths.operationsRoot, backupRoot: paths.backupRoot,
      pdfRoot: paths.pdfRoot ?? join(paths.workRoot, 'downloads'),
    },
    legacyVaultRoot: String(values.get('--source-root') ?? context.input?.legacyVaultRoot ?? LEGACY_VAULT_ROOT) };
  if (dryRun) return createVaultRebuildPlan(input);
  return applyVaultRebuild({ ...input, planFile: resolve(String(values.get('--plan-file'))), planSha256: String(values.get('--plan-sha256')) });
}

/** Explicit offline recovery for an intentional Evidence renderer upgrade.
 * Dry-run only computes a reviewed baseline; apply re-authenticates the
 * Vault-rebuild plan, Archive, Vault, receipts, and current projections before
 * installing one SQLite trust anchor. */
export async function routeEvidenceRendererBaseline(
  args: string[],
  context: RendererBaselineContext = {},
) {
  const values = new Map<string, string | true>();
  const flags = new Set(['--dry-run', '--apply']);
  const options = new Set([
    '--format', '--vault-plan-file', '--vault-plan-sha256',
    '--baseline-file', '--baseline-sha256',
  ]);
  const invalid = (): never => {
    throw new Error(
      'EVIDENCE_BASELINE_ARGUMENTS: use --dry-run --format json [--vault-plan-file FILE --vault-plan-sha256 SHA256] '
      + 'or --apply --baseline-file FILE --baseline-sha256 SHA256 '
      + '[--vault-plan-file FILE --vault-plan-sha256 SHA256]',
    );
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (values.has(name)) invalid();
    if (flags.has(name)) values.set(name, true);
    else if (options.has(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) invalid();
      values.set(name, value);
    } else invalid();
  }

  const dryRun = values.has('--dry-run');
  if (dryRun === values.has('--apply')) invalid();
  const hasVaultPlanFile = values.has('--vault-plan-file');
  const hasVaultPlanSha256 = values.has('--vault-plan-sha256');
  if (hasVaultPlanFile !== hasVaultPlanSha256) invalid();
  if (dryRun) {
    if (values.get('--format') !== 'json' || values.has('--baseline-file') || values.has('--baseline-sha256')) invalid();
  } else if (values.has('--format')
    || !values.has('--baseline-file')
    || !values.has('--baseline-sha256')
    || !/^[0-9a-f]{64}$/.test(String(values.get('--baseline-sha256')))) invalid();

  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? context.input?.libraryId ?? asLibraryId('fsd');
  if (context.input && context.libraryId && context.input.libraryId !== context.libraryId) invalid();
  const injectedPlan = context.input?.vaultPlan;
  const vaultPlan = hasVaultPlanFile
    ? { path: resolve(String(values.get('--vault-plan-file'))), sha256: String(values.get('--vault-plan-sha256')) }
    : injectedPlan;
  const resolvedVaultPlan = vaultPlan ?? invalid();

  const paths = context.input ? undefined : loadEngineContext({ root, libraryId }).paths;
  const ownsStore = !context.input;
  const store = context.input?.store ?? (dryRun
    ? openReadOnlyStateStore(paths!.databasePath)
    : openStateStore(paths!.databasePath));
  const input: RendererUpgradeBaselineInput = context.input
    ? { ...context.input, libraryId, vaultPlan: resolvedVaultPlan }
    : {
      libraryId,
      stateRoot: paths!.dataRoot,
      vaultRoot: paths!.vaultRoot,
      store,
      vaultPlan: resolvedVaultPlan,
    };
  try {
    if (dryRun) return createRendererUpgradeBaseline(input);
    const baseline = await readRendererUpgradeBaseline({
      path: resolve(String(values.get('--baseline-file'))),
      sha256: String(values.get('--baseline-sha256')),
    });
    return {
      mode: 'apply' as const,
      ...(await applyRendererUpgradeBaseline({
        ...input,
        baseline,
        baselineSha256: String(values.get('--baseline-sha256')),
      })),
    };
  } finally {
    if (ownsStore) store.close();
  }
}

/** Historical Archive migration stays outside the normal operation workflow and is always hash-bound. */
export async function routeEvidenceMigrate(args: string[], context: EvidenceMigrationContext = {}) {
  const dryRun = has(args, '--dry-run');
  const apply = has(args, '--apply');
  const refresh = has(args, '--refresh-metadata');
  const inventorySha256 = argValue(args, '--inventory-sha256');
  const format = argValue(args, '--format');
  if (Number(dryRun) + Number(apply) + Number(refresh) !== 1) throw new Error('evidence-migrate requires exactly one of --dry-run, --apply, or --refresh-metadata');
  if (dryRun && format !== 'json') throw new Error('evidence-migrate --dry-run requires --format json');
  if ((apply || refresh) && (!inventorySha256 || !/^[0-9a-f]{64}$/.test(inventorySha256))) {
    throw new Error('evidence-migrate apply/refresh requires --inventory-sha256 SHA256');
  }
  const root = context.root ?? process.cwd();
  const config = context.config ?? loadConfig({ root, libraryId: context.libraryId });
  const databasePath = historicalStateDatabasePath(config.stateRoot);
  if (!context.store && !existsSync(databasePath)) {
    if (!dryRun) throw new Error('EVIDENCE_MIGRATION_EMPTY_STATE: no SQLite state exists; run --dry-run first and do not create historical migration state');
    const emptyStore = { findSourceMetadata: () => undefined } as unknown as Parameters<typeof createEvidenceMigrationInventory>[0]['store'];
    return { mode: 'dry-run' as const, inventory: await createEvidenceMigrationInventory({ stateRoot: config.stateRoot, vaultRoot: config.vaultRoot, store: emptyStore }) };
  }
  const ownsStore = !context.store;
  // A historical inventory is an inspection, never an implicit database
  // upgrade.  Use a readonly connection that intentionally skips migrations
  // and compatibility backfills; apply/refresh remain normal write paths.
  const store = context.store ?? (dryRun ? openReadOnlyStateStore(databasePath) : openStateStore(databasePath));
  try {
    if (dryRun) return { mode: 'dry-run' as const, inventory: await createEvidenceMigrationInventory({ stateRoot: config.stateRoot, vaultRoot: config.vaultRoot, store }) };
    if (refresh) {
      if (!context.refreshMetadata) throw new Error('EVIDENCE_MIGRATION_METADATA_REFRESH_UNAVAILABLE: exact arXiv metadata adapter is not configured');
      return { mode: 'refresh-metadata' as const, inventory: await refreshEvidenceMigrationMetadata({ stateRoot: config.stateRoot, vaultRoot: config.vaultRoot, store, inventorySha256: inventorySha256!, refreshMetadata: context.refreshMetadata }) };
    }
    return { mode: 'apply' as const, ...(await applyEvidenceMigration({ stateRoot: config.stateRoot, vaultRoot: config.vaultRoot, tempRoot: config.tempRoot, store, inventorySha256: inventorySha256! })) };
  } finally { if (ownsStore) store.close(); }
}

/** Legacy Vault cleanup is deliberately outside normal FSD operations and never implicit. */
export async function routeVaultCleanup(args: string[], context: VaultCleanupContext = {}) {
  const dryRun = has(args, '--dry-run');
  const apply = has(args, '--apply');
  const format = argValue(args, '--format');
  const planSha256 = argValue(args, '--plan-sha256');
  if (Number(dryRun) + Number(apply) !== 1) throw new Error('vault-cleanup requires exactly one of --dry-run or --apply');
  if (dryRun && format !== 'json') throw new Error('vault-cleanup --dry-run requires --format json');
  if (apply && (!planSha256 || !/^[0-9a-f]{64}$/.test(planSha256))) throw new Error('vault-cleanup --apply requires --plan-sha256 SHA256');
  if (apply && !has(args, '--confirm')) throw new Error('VAULT_CLEANUP_CONFIRMATION_REQUIRED: add --confirm only after reviewing the dry-run and backup plan');
  const known = new Set(['--dry-run', '--apply', '--format', '--plan-sha256', '--confirm', 'json', planSha256 ?? '']);
  if (args.some(arg => !known.has(arg))) throw new Error('vault-cleanup received an unknown argument');
  const root = context.root ?? process.cwd();
  const config = context.config ?? loadConfig({ root, libraryId: context.libraryId });
  if (dryRun) {
    const review = await createVaultCleanupReview({ vaultRoot: config.vaultRoot });
    return { mode: 'dry-run' as const, plan: publicVaultCleanupPlan(review) };
  }
  const confirmed = context.confirmApply ? await context.confirmApply() : true;
  if (!confirmed) throw new Error('VAULT_CLEANUP_CONFIRMATION_REQUIRED: execution-time confirmation was declined');
  return { mode: 'apply' as const, ...(await applyVaultCleanup({ vaultRoot: config.vaultRoot, backupRoot: config.backupRoot, planSha256: planSha256!, confirmed })) };
}

/** Generic cleanup is a JSON dry-run unless --apply, plan hash, and --confirm are all present. */
export async function routeCleanup(args: string[], context: CleanupContext = {}) {
  const apply = has(args, '--apply');
  const explicitDryRun = has(args, '--dry-run');
  const format = argValue(args, '--format');
  const planSha256 = argValue(args, '--plan-sha256');
  if (apply && explicitDryRun) throw new Error('cleanup requires either --dry-run or --apply');
  if (format !== 'json') throw new Error('cleanup requires --format json');
  if (apply && !planSha256) throw new Error('cleanup --apply requires --plan-sha256 SHA256');
  if (apply && !has(args, '--confirm')) throw new Error('CLEANUP_CONFIRMATION_REQUIRED: add --confirm after reviewing the dry-run');
  const known = new Set(['--dry-run', '--apply', '--format', '--plan-sha256', '--confirm', 'json', planSha256 ?? '']);
  if (args.some(arg => !known.has(arg))) throw new Error('cleanup received an unknown argument');
  const root = context.root ?? process.cwd();
  const libraryId = context.libraryId ?? asLibraryId('fsd');
  const input = context.input ?? libraryCleanupInput(root, libraryId);
  if (!apply) return { mode: 'dry-run' as const, plan: await createCleanupPlan(input) };
  return { mode: 'apply' as const, ...(await applyCleanupPlan({ ...input, planSha256: planSha256!, confirm: true })) };
}

export function normalizeCliOperation(command: string, args: string[], libraryId: LibraryId, libraryKind: LibraryKind = 'paper'): SubmitRequest['operation'] {
  const value = (name: string) => argValue(args, name) ?? undefined;
  let operation: unknown;
  if (command === 'run-task') {
    const mode = value('--mode');
    if (mode === 'backfill' && libraryKind !== 'research') throw new Error('UNSUPPORTED_LIBRARY_KIND: backfill requires a research library');
    if (mode === 'backfill' && (!value('--from') || !value('--to'))) throw new Error('BACKFILL_WINDOW_REQUIRED: backfill requires --from and --to');
    parseTaskWindow(args);
    operation = { kind: mode, ...(has(args, '--limit') ? { limit: Number(value('--limit')) } : {}),
      ...(has(args, '--from') ? { from: value('--from') } : {}), ...(has(args, '--to') ? { to: value('--to') } : {}) };
  } else if (command === 'import-local') operation = { kind: command, path: value('--path'), reparse: has(args, '--reparse') };
  else if (command === 'parse-local') operation = { kind: command, baseId: value('--base-id'), reparse: has(args, '--reparse') };
  else if (command === 'evidence-publish') operation = { kind: command, runId: value('--run-id') };
  else if (command === 'reconcile') operation = { kind: command, ...(value('--repair-duplicate-pdf') ? { baseId: value('--repair-duplicate-pdf') } : {}), ...(value('--keep') ? { keepPath: value('--keep') } : {}) };
  else operation = { kind: command };
  return validateRequest({ libraryId, requestId: 'cli', operation }, true).operation;
}

async function routeResearchImport(
  args: string[],
  engine: EngineContext,
  context: MainContext & { root: string; libraryId: LibraryId },
): Promise<unknown> {
  if (!isResearchLibrary(engine.library)) throw new Error('UNSUPPORTED_LIBRARY_KIND: import-source requires a research library');
  const input = parseResearchImportArguments(args);
  const runtime = context.research ?? createResearchExecutionContext(engine);
  const targets = { ...(runtime.dependencies.discoveryTargets ?? {}) };
  targets[input.track] = {
    ...(targets[input.track] ?? {}),
    localPaths: [input.path],
    localPurpose: 'methodology',
    purpose: 'research',
  };
  const result = await executeConfiguredTask({ mode: 'backfill', limit: 1, tracks: [input.track], sourceKinds: ['local-artifact'] }, context.root, {
    libraryId: context.libraryId,
    signal: context.signal,
    research: {
      ...runtime,
      dependencies: { ...runtime.dependencies, discoveryTargets: targets, publish: undefined },
    },
  } as never);
  return result;
}

export async function routeCommand(argv: string[], engine: () => EngineContext, context: MainContext & { root: string; libraryId?: LibraryId }): Promise<number | undefined> {
  const { root, libraryId } = context;
  const [command, ...args] = argv;
  if (command === '--process-launcher') return runWindowsJobLauncher(args);
  if (command === '--process-supervisor') return runProcessSupervisor(args);
  if (!command || command === '--help' || command === '-h') {
    console.log([
      '论文知识引擎（Bun CLI）',
      'Usage: bun src/cli.ts [--library LIBRARY_ID] [COMMAND]',
      '不默认选择方向库；省略 COMMAND 先选择方向库，方向命令必须指定 --library LIBRARY_ID。',
      '',
      'Commands:',
      '  bootstrap',
      '  run-task --mode current [--limit N] [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
      '  run-task --mode weekly [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
      '  run-task --mode backfill --from YYYY-MM-DD --to YYYY-MM-DD [--limit N] (research only)',
      '  harvest-plan --mode current|weekly --format json',
      '  schedule-config --format json',
      '  source-config --format json (research only)',
      '  mineru-config --format json',
      '  arxiv-check --format json',
      '  opencli-prepare',
      '  import-local --path PDF_FILE_OR_FOLDER [--preview] [--reparse]',
      '  import-source --path ABSOLUTE_PATH --kind local-artifact --track TRACK (research only)',
      '  parse-local --base-id BASE_ID [--reparse]',
      '  evidence-publish --run-id RUN_ID',
      '  reconcile',
      '',
      'Offline maintenance (apply requires the dry-run SHA-256):',
      '  archive-migrate --dry-run --format json [--source-root ABSOLUTE_PATH]',
      '  archive-migrate --apply --plan-file FILE --plan-sha256 SHA256 [--source-root ABSOLUTE_PATH]',
      '  library-migrate --dry-run --format json [--source-root ABSOLUTE_PATH --pdf-root ABSOLUTE_PATH]',
      '  library-migrate --apply --plan-file FILE --plan-sha256 SHA256 [--source-root ABSOLUTE_PATH --pdf-root ABSOLUTE_PATH]',
      '  vault-rebuild --dry-run --format json [--source-root ABSOLUTE_PATH]',
      '  vault-rebuild --apply --plan-file FILE --plan-sha256 SHA256 [--source-root ABSOLUTE_PATH]',
      '  evidence-renderer-baseline --dry-run --format json --vault-plan-file FILE --vault-plan-sha256 SHA256',
      '  evidence-renderer-baseline --apply --baseline-file FILE --baseline-sha256 SHA256 [--vault-plan-file FILE --vault-plan-sha256 SHA256]',
      '  evidence-migrate --dry-run --format json',
      '  evidence-migrate --apply --inventory-sha256 SHA256',
      '  evidence-migrate --refresh-metadata --inventory-sha256 SHA256',
      '  vault-cleanup --dry-run --format json',
      '  vault-cleanup --apply --plan-sha256 SHA256 --confirm',
      '  cleanup [--dry-run] --format json',
      '  cleanup --apply --format json --plan-sha256 SHA256 --confirm',
      '  --process-supervisor --inspect RECORD_PATH',
      '  --process-supervisor --resolve RECORD_PATH',
    ].join('\n'));
    return;
  }
  if (!libraryId) throw new Error('LIBRARY_ID_REQUIRED: 请使用 --library 指定方向库，或不带命令启动选库菜单');
  if (command === '--worker') return runWorker(['--library', libraryId, ...args], root);
  if (command === '--bridge') return bridgeMain(['--library', libraryId, ...args]);
  if (command === 'vault-rebuild') {
    const result = await routeVaultRebuild(args, { root, libraryId, input: context.vaultRebuild });
    if (context.output) context.output(result); else process.stdout.write(canonicalJson(result));
    return;
  }
  if (command === 'evidence-renderer-baseline') {
    const result = await routeEvidenceRendererBaseline(args, { root, libraryId, input: context.rendererBaseline });
    if (context.output) context.output(result); else process.stdout.write(canonicalJson(result));
    return;
  }
  if (command === 'library-migrate') {
    const result = await routeLibraryMigrate(args, { root, libraryId, input: context.libraryMigration });
    if (context.output) context.output(result); else process.stdout.write(canonicalJson(result));
    return;
  }
  if (command === 'archive-migrate') {
    const result = await routeArchiveMigrate(args, { root, libraryId, input: context.archiveMigration });
    if (context.output) context.output(result);
    else process.stdout.write(canonicalJson(result));
    return;
  }
  if (command === 'evidence-migrate') {
    const result = await routeEvidenceMigrate(args, { root, libraryId });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'vault-cleanup') {
    const result = await routeVaultCleanup(args, { root });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'cleanup') {
    const result = await routeCleanup(args, { root, libraryId });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'opencli-prepare') {
    const result = await prepareOpenCli(root);
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  // Existing injected FSD/bridge tests can route without a layered config. The
  // configured non-default library is loaded here so command routing follows
  // its declared kind instead of a library-id special case.
  const selected = libraryId && libraryId !== 'fsd' ? engine() : undefined;
  const researchLibrary = selected ? isResearchLibrary(selected.library) : false;
  const paperLibrary = !researchLibrary;
  if (command === 'source-config') {
    const result = routeSourceConfig(args, { root, libraryId });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'import-source') {
    if (!researchLibrary) throw new Error('UNSUPPORTED_LIBRARY_KIND: import-source requires a research library');
    const result = await routeResearchImport(args, selected!, { ...context, root, libraryId });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'mineru-config' && !paperLibrary) throw new Error('UNSUPPORTED_LIBRARY_KIND: MinerU is only available for paper libraries');
  if (['bootstrap', 'import-local', 'parse-local'].includes(command) && !paperLibrary) {
    throw new Error('UNSUPPORTED_LIBRARY_KIND: paper-only operation is not available for research libraries');
  }
  if (command === 'harvest-plan' && !paperLibrary) throw new Error('UNSUPPORTED_LIBRARY_KIND: harvest-plan is only available for paper libraries');
  if (command === 'arxiv-check' && !paperLibrary) throw new Error('UNSUPPORTED_LIBRARY_KIND: arxiv-check is only available for paper libraries');
  if (['bootstrap', 'run-task', 'import-local', 'parse-local', 'evidence-publish', 'reconcile'].includes(command)
      && !(command === 'import-local' && has(args, '--preview'))) {
    if (has(args, '--format') && argValue(args, '--format') !== 'json') throw new Error(`${command} supports only --format json`);
    const operation = normalizeCliOperation(command, args, libraryId, selected?.library.kind ?? 'paper');
    const paths = context.operationsRoot ? undefined : engine().paths;
    const operationsRoot = context.operationsRoot ?? paths!.operationsRoot;
    const { job } = await admitOperation({ operationsRoot, root, internal: true, request: { libraryId, requestId: randomUUID(), operation } });
    let businessResult: unknown;
    let hasBusinessResult = false;
    const result = await (context.execute ?? executeOperation)({ root, jobId: job.jobId }, {
      operationsRoot, dataRoot: context.dataRoot ?? paths?.dataRoot, onProgress: createTerminalProgressReporter(),
      signal: context.signal,
      mineruSession: context.mineruSession,
      createMineruSession: context.createMineruSession,
      research: researchLibrary ? (context.research ?? createResearchExecutionContext(selected!)) : undefined,
      onResult: value => { businessResult = value; hasBusinessResult = true; },
    });
    const output = hasBusinessResult ? businessResult : result;
    if (has(args, '--format')) console.log(JSON.stringify(output, null, 2));
    else if (context.output) context.output(output);
    else console.log(formatCliOperationSummary(command, result, hasBusinessResult ? businessResult : undefined));
    return result.status === 'failed' || result.status === 'blocked' ? 1 : undefined;
  }
  if (command === 'import-local') {
    const result = await routeImportLocal(args, { root, libraryId, mineruSession: context.mineruSession, signal: context.signal });
    console.log(JSON.stringify(result, null, 2));
    return result.status === 'failed' ? 1 : undefined;
  }
  if (command === 'harvest-plan') { console.log(JSON.stringify(routeHarvestPlan(args, { root, libraryId }), null, 2)); return; }
  if (command === 'schedule-config') {
    const result = routeScheduleConfig(args, { root, libraryId });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'mineru-config') {
    const config = { ...loadConfig({ root, libraryId }), root };
    const result = routeMineruConfig(args, { root, libraryId, stageConfig: config });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  if (command === 'arxiv-check') {
    const config = { ...loadConfig({ root, libraryId }), root };
    const result = await routeArxivCheck(args, { root, libraryId, config });
    (context.output ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
