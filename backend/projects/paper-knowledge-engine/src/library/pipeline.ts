import { join } from 'node:path';
import { computeRunWindow } from './schedule/run-window.ts';
import { withRunLock } from '../runtime/run-lock.ts';
import { redactErrorMessage } from '../shared/redaction.ts';
import type { StateStore } from './state/state-store.ts';
import { notifyProgressObserver } from '../shared/progress.ts';
import type { LibraryKind, SelectionConfig } from '../types/config.ts';
import type { ProgressReporter, RunWindow, TaskMode, TaskResult, TaskParseJob, TaskParseManifest, TaskDecision, TaskDownloadedPaper, TaskPaper } from '../types/jobs.ts';
interface TaskOptions { mode: TaskMode; now: string; limit?: number; windowOverride?: RunWindow; resumeRunId?: string; jobId?: string }
type Run = ReturnType<StateStore['startRun']>;
interface ParseResult { status: 'succeeded' | 'failed' | 'skipped'; errorClass?: string | null; errorMessage?: string | null; attemptId?: string }
interface ParseDependencies<J extends TaskParseJob = TaskParseJob> {
  clock?: () => number;
  onProgress?: ProgressReporter;
  parseOne: (job: J) => Promise<ParseResult>;
  /** Move a successfully parsed paper into the parsed state without creating a semantic note. */
  markParsed?: (baseId: string) => unknown | Promise<unknown>;
}
interface TaskDependencies extends ParseDependencies {
  config: SelectionConfig & { libraryKind?: LibraryKind; startDate: string; overlapHours: number; root?: string; libraryId?: string; weeklySchedule: { enabled: boolean; maxPapers: number } };
  store: {
    getLastSuccess(): string | null;
    upsertDiscovered(paper: TaskPaper): unknown;
    markExcluded(id: string, reasons: string, version: number): unknown;
    failRun(id: string, error: string): unknown;
    markParsedStatus?(baseId: string): unknown;
    findResumableHarvestRun(mode: string): { from_utc: string; to_utc: string; run_id?: string; kind?: string; status?: string } | undefined;
    startRun(window: RunWindow, mode: string, options?: { autoResume?: boolean }): Run;
    getRun?(id: string): unknown;
    completeEmptyRun(runId: string, to: string): object | void;
    findByBaseId?: Parameters<typeof hasStoredPaperPdf>[1]['findByBaseId'];
    listHarvestObservations?: (runId: string) => { paper: import('../types/papers.ts').PaperMetadata }[];
  };
  lockPath: string; runRoot: string; withLock?: typeof withRunLock;
  bootstrap(): Promise<unknown>;
  discovery: { harvest(input: { window: RunWindow; run: Run }): Promise<TaskPaper[]> };
  policy: { evaluate(paper: TaskPaper): TaskDecision };
  pdfStore: { download(decision: TaskDecision): Promise<TaskDownloadedPaper | { pdfPath: string; duplicateOf: string; skipped?: string }> };
  readManifest?: (path: string) => Promise<unknown>;
  writeManifest(path: string, manifest: unknown): Promise<unknown>;
  buildManifest(runId: string, papers: TaskDownloadedPaper[], run: Run): TaskParseManifest | Promise<TaskParseManifest>;
  publishEvidence(runId: string, manifest: TaskParseManifest): Promise<{ publicationId: string; sourceCount: number; replayed: boolean }>;
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function assertParseManifest(value: unknown, runId: string): asserts value is TaskParseManifest {
  if (!isRecord(value) || value.runId !== runId || !Array.isArray(value.jobs)) throw new Error('invalid parse manifest');
  for (const job of value.jobs) {
    if (!isRecord(job) || typeof job.baseId !== 'string' || !job.baseId) throw new Error('invalid parse manifest job');
    for (const key of ['arxivId', 'title', 'summary', 'published', 'updated', 'submittedAt', 'updatedAt', 'id', 'status', 'model', 'cliBackend', 'method', 'fileSource', 'outputDir', 'pdfPath', 'mineruVersion', 'sourceCommit', 'sourceType', 'language', 'parserConfigKey', 'retryOfMethod']) {
      if (job[key] !== undefined && typeof job[key] !== 'string') throw new Error('invalid parse manifest job');
    }
    for (const key of ['sha256', 'primaryTrack']) if (job[key] !== undefined && job[key] !== null && typeof job[key] !== 'string') throw new Error('invalid parse manifest job');
    for (const key of ['matchedTracks', 'eligibleTracks', 'dateModes', 'categories']) if (job[key] !== undefined && (!Array.isArray(job[key]) || !job[key].every((item: unknown) => typeof item === 'string'))) throw new Error('invalid parse manifest job');
    for (const key of ['version', 'pageCount', 'timeoutMs', 'attemptStartedAt']) if (job[key] !== undefined && (typeof job[key] !== 'number' || !Number.isFinite(job[key]))) throw new Error('invalid parse manifest job');
    for (const key of ['formula', 'table', 'reparse', 'isOcr', 'hasImportant2026Version']) if (job[key] !== undefined && typeof job[key] !== 'boolean') throw new Error('invalid parse manifest job');
  }
}

import { selectTaskDecisions, taskPaperLimit } from './selection/task-selection.ts';
import { hasStoredPaperPdf, isPermanentPdfUnavailable } from './sources/pdf-store.ts';
import { readTaskArtifact, validateTaskArtifact, validateTaskSelection } from './state/task-artifacts.ts';


export async function runParseManifest<J extends TaskParseJob>(runId: string, manifest: TaskParseManifest & { jobs: J[] }, dependencies: ParseDependencies<J>) {
  assertParseManifest(manifest, runId);
  const clock = dependencies.clock ?? Date.now;
  const onProgress = dependencies.onProgress ?? (() => undefined);
  const startedAt = clock();
  const results = [];
  for (let index = 0; index < manifest.jobs.length; index += 1) {
    const job = manifest.jobs[index];
    const jobStartedAt = clock();
    const progressBase = {
      phase: 'parse',
      current: index + 1,
      total: manifest.jobs.length,
      baseId: job.baseId,
      arxivId: job.arxivId,
      model: job.model,
    };
    onProgress({ type: 'parse-start', ...progressBase, totalElapsedMs: jobStartedAt - startedAt });
    let result;
    try {
      result = await dependencies.parseOne(job);
    } catch (error) {
      const failedAt = clock();
      onProgress({
        type: 'parse-failed',
        ...progressBase,
        error: redactErrorMessage(error),
        elapsedMs: failedAt - jobStartedAt,
        totalElapsedMs: failedAt - startedAt,
      });
      throw error;
    }
    results.push(result);
    if (result.status === 'succeeded' || result.status === 'skipped') {
      await dependencies.markParsed?.(job.baseId);
    }
    const finishedAt = clock();
    const failure = !['succeeded', 'skipped'].includes(result.status)
      ? { errorClass: result.errorClass, error: redactErrorMessage(result.errorMessage ?? '未知错误'), attemptId: result.attemptId } : {};
    onProgress({
      type: 'parse-complete',
      ...progressBase,
      status: result.status,
      ...failure,
      elapsedMs: finishedAt - jobStartedAt,
      totalElapsedMs: finishedAt - startedAt,
    });
    if (failure.error) throw new Error(`parse failed: ${job.baseId} [${failure.errorClass ?? 'process_error'}] ${failure.error} (attempt: ${failure.attemptId ?? 'unknown'})`);
  }
  return { runId, status: 'parsed', results };
}

export async function runTask(options: TaskOptions, dependencies: TaskDependencies): Promise<TaskResult> {
  if (dependencies.config.libraryKind === 'research') throw new Error('UNSUPPORTED_LIBRARY_KIND: research');
  if (!['current', 'weekly'].includes(options?.mode)) throw new Error(`unsupported task mode: ${options?.mode}`);
  const withLock = dependencies.withLock ?? withRunLock;
  return withLock(dependencies.lockPath, async () => {
    const clock = dependencies.clock ?? Date.now;
    const onProgress = dependencies.onProgress ?? (() => undefined);
    const taskStartedAt = clock();
    if (options.mode === 'weekly' && !dependencies.config.weeklySchedule.enabled) {
      return { status: 'disabled', mode: 'weekly', selected: [] };
    }
    const selectedRun = options.resumeRunId ? dependencies.store.getRun?.(options.resumeRunId) : undefined;
    if (selectedRun !== undefined && (!isRecord(selectedRun) || typeof selectedRun.run_id !== 'string' || typeof selectedRun.kind !== 'string'
      || typeof selectedRun.status !== 'string' || typeof selectedRun.from_utc !== 'string' || typeof selectedRun.to_utc !== 'string'
      || !Number.isFinite(Date.parse(selectedRun.from_utc)) || !Number.isFinite(Date.parse(selectedRun.to_utc)) || selectedRun.from_utc > selectedRun.to_utc)) throw new Error('invalid specified resume run');
    const specified = selectedRun as { run_id: string; kind: string; status: string; from_utc: string; to_utc: string } | undefined;
    if (options.resumeRunId && (!specified || specified.kind !== options.mode || !['running', 'failed', 'awaiting_local_parse', 'completed'].includes(specified.status))) {
      throw new Error('invalid specified resume run');
    }
    if (specified && options.windowOverride && (specified.from_utc !== options.windowOverride.from || specified.to_utc !== options.windowOverride.to)) throw new Error('resume window mismatch');
    const automaticCandidate = options.windowOverride
      ? undefined
      : dependencies.store.findResumableHarvestRun(options.mode);
    const configuredCurrentStart = new Date(`${dependencies.config.startDate}T00:00:00Z`).toISOString();
    const automaticResumable = options.mode === 'current'
      && automaticCandidate?.from_utc !== configuredCurrentStart
      ? undefined
      : automaticCandidate;
    const resumable = specified ?? automaticResumable;
    const window = options.windowOverride
      ?? (resumable ? { from: resumable.from_utc, to: resumable.to_utc } : undefined)
      ?? computeRunWindow(options.mode === 'current' ? null : dependencies.store.getLastSuccess(), options.now, dependencies.config);
    // Validate the selected run and saved parameters before startRun can mutate status.
    if (specified) {
      const identity = { id: specified.run_id, from: specified.from_utc, to: specified.to_utc };
      const read = dependencies.readManifest ?? readTaskArtifact;
      const selection = await read(join(dependencies.runRoot, specified.run_id, 'selection-manifest.json'));
      if (selection) validateTaskSelection(selection, identity, options.mode, options.limit);
      const manifest = await read(join(dependencies.runRoot, specified.run_id, 'mineru-jobs.json'));
      if (manifest) validateTaskArtifact(manifest, identity);
    }
    await dependencies.bootstrap();
    const run = dependencies.store.startRun(window, options.mode, options.resumeRunId
      ? undefined
      : { autoResume: options.windowOverride === undefined });
    if (options.resumeRunId && run.id !== options.resumeRunId) throw new Error('resume returned a different run identity');
    const configuredLimit = taskPaperLimit(dependencies.config, options.mode);
    const requestedLimit = options.limit ?? configuredLimit;
    onProgress({ type: 'task-start', phase: 'task', mode: options.mode, runId: run.id, window,
      configPath: join(dependencies.config.root ?? '.', 'config', dependencies.config.libraryId ?? 'fsd', 'library.yaml'),
      configuredLimit, requestedLimit, totalElapsedMs: 0 });
    const parseManifestPath = join(dependencies.runRoot, run.id, 'mineru-jobs.json');
    const selectionPath = join(dependencies.runRoot, run.id, 'selection-manifest.json');
    if (run.status === 'completed') {
      return { status: 'completed', mode: options.mode, runId: run.id, window, selected: [], replayed: true };
    }
    let activePhase = 'selection';
    try {
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > configuredLimit) {
        throw new Error(`limit must be an integer from 1 to ${configuredLimit}`);
      }
      const readArtifact = dependencies.readManifest ?? readTaskArtifact;
      const savedSelectionInput = await readArtifact(selectionPath);
      let savedSelection: import('../types/jobs.ts').TaskSelection | null = null;
      if (savedSelectionInput) { validateTaskSelection(savedSelectionInput, run, options.mode, options.limit); savedSelection = savedSelectionInput; }
      const parseManifestInput = await readArtifact(parseManifestPath);
      let parseManifest: TaskParseManifest | null = null;
      if (parseManifestInput) { assertParseManifest(parseManifestInput, run.id); parseManifest = parseManifestInput; }
      if (parseManifest) {
        validateTaskArtifact(parseManifest, run);
        if (!Array.isArray(parseManifest.jobs)) throw new Error('invalid parse manifest');
        if (savedSelection && (!parseManifest.jobs.length || parseManifest.jobs.some(job =>
          !savedSelection.selected.some(item => item.paper.baseId === job.baseId
            && Number(item.paper.version) === Number(job.version))))) {
          throw new Error('parse manifest does not match the saved selection');
        }
      }
      let selected: TaskDecision[];
      let fallbackCandidates: TaskDecision[] = [];
      let selectionCheckpoint: Record<string, unknown> | null = null;
      let fallbackDiscoveryAttempted = false;
      const persistSelectionCheckpoint = async () => {
        if (!selectionCheckpoint) return;
        await dependencies.writeManifest(selectionPath, {
          ...selectionCheckpoint,
          selected,
          fallbacks: fallbackCandidates,
        });
      };
      const replenishFallbackCandidates = async () => {
        if (fallbackDiscoveryAttempted || fallbackCandidates.length || !dependencies.store.listHarvestObservations) return;
        fallbackDiscoveryAttempted = true;
        const used = new Set(selected.map(item => item.paper.baseId));
        const candidates: TaskDecision[] = [];
        for (const observation of dependencies.store.listHarvestObservations(run.id)) {
          const discovered = observation.paper;
          const baseId = discovered.baseId ?? discovered.arxivId?.replace(/v\d+$/, '');
          if (!baseId || used.has(baseId)) continue;
          const paper = { ...discovered, baseId } as TaskPaper;
          const existing = dependencies.store.findByBaseId?.(baseId);
          if (existing?.status === 'excluded' && Number(existing.version) >= Number(paper.version ?? 1)) continue;
          if (await hasStoredPaperPdf(paper, { findByBaseId: id => dependencies.store.findByBaseId?.(id) })) continue;
          const decision = dependencies.policy.evaluate(paper);
          if (!decision.accepted) continue;
          candidates.push(decision);
          used.add(baseId);
        }
        const replenishment = selectTaskDecisions(candidates, dependencies.config, options.mode,
          Math.max(requestedLimit, candidates.length));
        fallbackCandidates = replenishment;
      };
      let selectionFinishedAt;
      if (savedSelection || parseManifest) {
        // Resuming work is not a new selection: its own partial downloads must
        // remain in the batch. Older runs can resume directly from MinerU jobs.
        selected = savedSelection?.selected as TaskDecision[] ?? parseManifest!.jobs.map(paper => ({
          accepted: true, primaryTrack: paper.primaryTrack, paper,
        }));
        fallbackCandidates = (savedSelection?.fallbacks ?? []) as TaskDecision[];
        selectionCheckpoint = savedSelection;
        if (selected.length > requestedLimit) {
          throw new Error(`本批次固定清单有 ${selected.length} 篇，超过配置上限 ${configuredLimit} 篇（本次上限 ${requestedLimit} 篇）。已停止，未改写清单；如需完整恢复，请核对 config/${dependencies.config.libraryId ?? 'fsd'}/library.yaml 的对应任务上限。`);
        }
        onProgress({ type: 'selection-resume', phase: 'selection', selectedCount: selected.length,
          fallbackCount: fallbackCandidates.length, parseReady: Boolean(parseManifest), totalElapsedMs: clock() - taskStartedAt });
      } else {
        activePhase = 'discovery';
        const discovered = await dependencies.discovery.harvest({ window, run });
        const discoveryFinishedAt = clock();
        onProgress({
          type: 'discovery-complete', phase: 'discovery', discoveredCount: discovered.length,
          elapsedMs: discoveryFinishedAt - taskStartedAt, totalElapsedMs: discoveryFinishedAt - taskStartedAt,
        });
        for (const paper of discovered) dependencies.store.upsertDiscovered({ ...paper, status: 'discovered' });
        activePhase = 'selection';
        const evaluated = discovered.map((paper) => dependencies.policy.evaluate(paper));
        const candidates = [];
        let existingCount = 0;
        for (const decision of evaluated) {
          const existing = dependencies.store.findByBaseId?.(decision.paper.baseId);
          if (existing?.status === 'excluded' && Number(existing.version) >= Number(decision.paper.version ?? 1)) continue;
          if (await hasStoredPaperPdf(decision.paper, { findByBaseId: id => dependencies.store.findByBaseId?.(id) })) {
            if (decision.accepted) existingCount += 1;
            continue;
          }
          if (decision.accepted) candidates.push(decision);
          else dependencies.store.markExcluded(decision.paper.baseId, JSON.stringify(decision.reasons), decision.paper.version ?? 1);
        }
        const selectionPool = selectTaskDecisions(candidates, dependencies.config, options.mode,
          Math.max(requestedLimit, candidates.length));
        selected = selectionPool.slice(0, requestedLimit);
        fallbackCandidates = selectionPool.slice(requestedLimit);
        // Persist before any download. A crash must not cause the next invocation
        // to replace partially downloaded members with a new set of candidates.
        selectionCheckpoint = {
          schemaVersion: 1, runId: run.id, mode: options.mode, window, requestedLimit, selected,
          fallbacks: fallbackCandidates,
          evaluatedCount: evaluated.length, acceptedCount: evaluated.filter(item => item.accepted === true).length,
          existingCount, newCandidateCount: candidates.length,
        };
        if (selected.length) await persistSelectionCheckpoint();
        selectionFinishedAt = clock();
        onProgress({
          type: 'selection-complete', phase: 'selection', evaluatedCount: evaluated.length,
          acceptedCount: evaluated.filter(item => item.accepted === true).length,
          existingCount, newCandidateCount: candidates.length,
          quotaCount: selected.filter(item => item.selectionReason === 'quota').length,
          spilloverCount: selected.filter(item => item.selectionReason === 'spillover').length,
          selectedByTrack: Object.fromEntries(Object.keys(dependencies.config.currentTask.trackLimits)
            .map(track => [track, selected.filter(item => item.primaryTrack === track).length])),
          selectedCount: selected.length, elapsedMs: selectionFinishedAt - discoveryFinishedAt,
          totalElapsedMs: selectionFinishedAt - taskStartedAt,
        });
      }
      if (selected.length === 0) {
        const completed = dependencies.store.completeEmptyRun(run.id, window.to);
        const result: TaskResult = { status: 'completed', mode: options.mode, runId: run.id, window, selected: [], paperCount: 0, ...completed };
        notifyProgressObserver(onProgress, {
          type: 'task-complete', phase: 'task', status: result.status,
          paperCount: 0, totalElapsedMs: (selectionFinishedAt ?? clock()) - taskStartedAt,
        });
        return result;
      }
      if (!parseManifest) {
        const stored = [];
        activePhase = 'download';
        for (let index = 0; index < selected.length; index += 1) {
          const decision = selected[index];
          const downloadStartedAt = clock();
          const progressBase = {
            phase: 'download', current: index + 1, total: selected.length,
            baseId: decision.paper.baseId, arxivId: decision.paper.arxivId,
          };
          onProgress({ type: 'download-start', ...progressBase, totalElapsedMs: downloadStartedAt - taskStartedAt });
          let result;
          try {
            result = await dependencies.pdfStore.download(decision);
          } catch (error) {
            if (isPermanentPdfUnavailable(error)) {
              await replenishFallbackCandidates();
              const replacementIndex = fallbackCandidates.findIndex(candidate => candidate.primaryTrack === decision.primaryTrack);
              const replacement = fallbackCandidates.splice(replacementIndex < 0 ? 0 : replacementIndex, 1)[0];
              dependencies.store.markExcluded(decision.paper.baseId, `pdf-unavailable:${error.status}`, decision.paper.version ?? 1);
              if (replacement) selected[index] = replacement;
              else selected.splice(index, 1);
              await persistSelectionCheckpoint();
              onProgress({
                type: 'download-skipped', phase: 'download', current: index + 1, total: selected.length,
                baseId: decision.paper.baseId, arxivId: decision.paper.arxivId, status: 'unavailable',
                error: `PDF 不可用（HTTP ${error.status}）`, replacementArxivId: replacement?.paper.arxivId,
                elapsedMs: clock() - downloadStartedAt, totalElapsedMs: clock() - taskStartedAt,
              });
              index -= 1;
              continue;
            }
            const failedAt = clock();
            onProgress({
              type: 'download-failed', ...progressBase, error: redactErrorMessage(error),
              elapsedMs: failedAt - downloadStartedAt,
              totalElapsedMs: failedAt - taskStartedAt,
            });
            throw error;
          }
          if (!result?.pdfPath) throw new Error(`download failed: ${decision.paper.baseId}`);
          if (!result.duplicateOf) {
            if (!('baseId' in result)) throw new Error('download result missing paper identity');
            stored.push(result);
          }
          const downloadFinishedAt = clock();
          onProgress({
            type: 'download-complete', ...progressBase,
            status: result.duplicateOf ? 'duplicate' : result.skipped ? (savedSelection ? 'resumed' : 'reused') : 'downloaded',
            bytes: Number.isFinite('bytes' in result ? result.bytes : undefined) ? ('bytes' in result ? result.bytes : undefined) : null,
            elapsedMs: downloadFinishedAt - downloadStartedAt,
            totalElapsedMs: downloadFinishedAt - taskStartedAt,
          });
        }
        if (stored.length === 0) {
          const completed = dependencies.store.completeEmptyRun(run.id, window.to);
          const result: TaskResult = { status: 'completed', mode: options.mode, runId: run.id, window, selected: [], paperCount: 0, ...completed };
          notifyProgressObserver(onProgress, { type: 'task-complete', phase: 'task', status: result.status, paperCount: 0, totalElapsedMs: clock() - taskStartedAt });
          return result;
        }
        parseManifest = await dependencies.buildManifest(run.id, stored, run);
        await dependencies.writeManifest(parseManifestPath, parseManifest);
      }
      if (parseManifest) {
        activePhase = 'parse';
        await runParseManifest(run.id, parseManifest, {
          parseOne: dependencies.parseOne,
          markParsed: dependencies.store.markParsedStatus ? (baseId) => dependencies.store.markParsedStatus!(baseId) : undefined,
          onProgress,
          clock,
        });
      }
      const archiveCompletedAt = clock();
      onProgress({ type: 'archive-complete', phase: 'archive', sourceCount: parseManifest.jobs.length, totalElapsedMs: archiveCompletedAt - taskStartedAt });
      activePhase = 'publish';
      notifyProgressObserver(onProgress, { type: 'evidence-publish-start', phase: 'publish', sourceCount: parseManifest.jobs.length, totalElapsedMs: clock() - taskStartedAt });
      const publication = await dependencies.publishEvidence(run.id, parseManifest);
      const result: TaskResult = {
        status: 'completed',
        mode: options.mode,
        runId: run.id,
        window,
        selected,
        paperCount: publication.sourceCount,
      };
      const taskFinishedAt = clock();
      notifyProgressObserver(onProgress, { type: 'evidence-publish-complete', phase: 'publish', publicationId: publication.publicationId, sourceCount: publication.sourceCount, replayed: publication.replayed, totalElapsedMs: taskFinishedAt - taskStartedAt });
      notifyProgressObserver(onProgress, {
        type: 'task-complete', phase: 'task', status: result.status,
        paperCount: result.paperCount, totalElapsedMs: taskFinishedAt - taskStartedAt,
      });
      return result;
    } catch (error) {
      onProgress({
        type: 'task-failed', phase: 'task', failedPhase: activePhase,
        error: redactErrorMessage(error), totalElapsedMs: clock() - taskStartedAt,
      });
      const persistedRun = dependencies.store.getRun?.(run.id);
      if (!isRecord(persistedRun) || persistedRun.status !== 'completed') {
        dependencies.store.failRun(run.id, redactErrorMessage(error));
      }
      throw error;
    }
  }, { jobId: options.jobId });
}
