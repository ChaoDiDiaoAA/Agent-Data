import type { LocalPdfConfig, MinerUCliConfig } from '../../types/config.ts';
import type { LocalPaper } from '../../types/papers.ts';
import type { ProgressReporter } from '../../types/jobs.ts';
import type { StateStore } from '../state/state-store.ts';
import type { ProcessContext } from '../../runtime/process.ts';
import type { ParseDependencies, ParseReport } from '../../mineru/mineru-local-jobs.ts';
import type { MineruApiSession } from '../../mineru/mineru-api-session.ts';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectLocalPdfs, verifyConfirmedPdfFiles, type LocalPdfIdentity } from './local-pdf-files.ts';
import { buildLocalParseJob, buildLocalParseManifest, localParserConfigKey, runLocalParse, writeLocalParseManifest } from '../../mineru/mineru-local-jobs.ts';
import { redactErrorMessage } from '../../shared/redaction.ts';
import { validateLocalArchiveSource } from '../../evidence/contracts.ts';
import { readVerifiedRunSources } from '../../evidence/archive-reader.ts';
import { publishRunEvidence } from '../../evidence/publication-service.ts';
import { notifyProgressObserver } from '../../shared/progress.ts';
import type { LibraryPaths } from '../../shared/paths.ts';
import { verifyArchiveV2 } from '../../shared/archive-v2.ts';

interface ResumeJob { baseId: string; previousAttemptId?: string | null; forceReparse?: boolean }
interface ImportPlan { paper: LocalPaper; row: ReturnType<StateStore['findBySha256']>; previousAttemptId?: string | null; forceReparse?: boolean }
export interface LocalImportOptions { config: LocalPdfConfig; paths: LibraryPaths; store: StateStore; reparse?: boolean; resumeRunId?: string; runner?: ParseDependencies['runner']; mineruSession?: MineruApiSession; processContext?: ProcessContext; signal?: AbortSignal; onProgress?: ProgressReporter; publishRunEvidence?: typeof publishRunEvidence }
function errorField(error: unknown, key: string): unknown { return error && typeof error === 'object' ? Reflect.get(error, key) : undefined; }
function object(input: unknown): Record<string, unknown> { if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid local import manifest'); return input as Record<string, unknown>; }
function resumeManifest(input: unknown, runId: string): { jobs: ResumeJob[] } {
  const m=object(input); if(m.runId !== runId || !Array.isArray(m.jobs)) throw new Error('invalid resume manifest identity');
  return { jobs: m.jobs.map(value => {
    const j = object(value);
    if (typeof j.baseId !== 'string' || !j.baseId || (j.previousAttemptId !== undefined && j.previousAttemptId !== null && typeof j.previousAttemptId !== 'string') || (j.forceReparse !== undefined && typeof j.forceReparse !== 'boolean')) throw new Error('invalid resume job');
    return { baseId: j.baseId, previousAttemptId: j.previousAttemptId, forceReparse: j.forceReparse };
  }) };
}

const digest = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
function sessionRunner(session?: MineruApiSession): ParseDependencies['runner'] {
  return async (job) => {
    if (!session) throw Object.assign(new Error('MinerU session is required'), { code: 'MINERU_API_UNAVAILABLE' });
    return session.run({
      ...job,
      fileSource: typeof job.fileSource === 'string' && job.fileSource ? job.fileSource : (() => { throw new Error('fileSource is required'); })(),
      outputDir: typeof job.outputDir === 'string' && job.outputDir ? job.outputDir : (() => { throw new Error('outputDir is required'); })(),
    });
  };
}

async function matchesParserConfig(attempt: ReturnType<StateStore['findSuccessfulParse']>, key: string) {
  if (!attempt?.outputDir) return false;
  try {
    if (await Bun.file(join(attempt.outputDir, 'manifest.json')).exists()) {
      const { source, manifest } = await verifyArchiveV2(attempt.outputDir);
      if (manifest.sourceKind !== 'local_pdf' || manifest.baseId !== attempt.baseId || manifest.version !== attempt.version ||
        manifest.pdfSha256 !== attempt.sha256 || manifest.parser.model !== attempt.model || manifest.parser.method !== attempt.method) throw new Error('local parse source identity mismatch');
      return source.parserConfigKey === key;
    }
    const source: unknown = JSON.parse(await readFile(join(attempt.outputDir, 'source.json'), 'utf8'));
    if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
    const record = source as Record<string, unknown>;
    if (record.sourceKind !== 'local_pdf') return false;
    const local = validateLocalArchiveSource(record);
    if (local.baseId !== attempt.baseId || local.version !== attempt.version || local.pdfSha256 !== attempt.sha256
      || local.model !== attempt.model || local.method !== attempt.method) throw new Error('local parse source identity mismatch');
    return local.parserConfigKey === key;
  }
  catch (error) { if (errorField(error, 'code') === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}

async function cachedParse(store: StateStore, paper: LocalPaper, config: LocalPdfConfig, parserConfigKey: string) {
  const identity = { ...paper, model: config.model, method: config.pipelineMethod };
  const candidates = [
    store.findSuccessfulParse(paper.baseId, config.model),
    store.findSuccessfulParse(identity),
    config.pipelineMethod === 'auto' ? store.findSuccessfulParse({ ...identity, method: 'ocr' }) : undefined,
  ].filter((attempt) => attempt && attempt.version === paper.version && attempt.sha256 === paper.sha256
    && (attempt.method === config.pipelineMethod || (config.pipelineMethod === 'auto' && attempt.method === 'ocr')));
  // Prefer the newest compatible output, including a fallback completed in this batch.
  for (const attempt of candidates) if (await matchesParserConfig(attempt, parserConfigKey)) return attempt;
  return candidates[0];
}

export async function importLocalPdfs(scan: { files: string[]; expectedFiles?: LocalPdfIdentity[] }, { config, paths, store, reparse = false, resumeRunId, runner, mineruSession, processContext, signal, onProgress = () => {}, publishRunEvidence: publish = publishRunEvidence }: LocalImportOptions) {
  config = { ...config, libraryPaths: paths };
  // Validate the entire selection before registering files or starting GPU work.
  const documents = await inspectLocalPdfs(scan.files, config, scan.expectedFiles);
  const unique = [...new Map(documents.map((doc) => [doc.sha256, doc])).values()];
  const selectedRun = resumeRunId ? store.getRun(resumeRunId) : undefined;
  if (resumeRunId && (!selectedRun || selectedRun.kind !== 'local_import'
    || !['running', 'failed', 'awaiting_local_parse', 'completed'].includes(selectedRun.status))) {
    throw Object.assign(new Error('INPUT_CHANGED'), { code: 'INPUT_CHANGED' });
  }
  const rows = store.exportManifest();
  let papers: LocalPaper[] = []; let plans: ImportPlan[] = [];
  const parserConfigKey = localParserConfigKey(config);
  let skippedCount = documents.length - unique.length;
  for (const doc of unique) {
    const row = store.findBySha256(doc.sha256);
    const previous = rows.find((item) => item.pdf_path && resolve(item.pdf_path).toLowerCase() === resolve(doc.path).toLowerCase());
    if (previous && previous.sha256 !== doc.sha256) throw new Error(`已登记 PDF 内容被替换：${doc.path}；请恢复原文件，并用新文件名导入修改版`);
    if (row && Number(row.downloaded_version) !== Number(row.version)) throw new Error(`PDF 下载版本未核实或已过期：${row.base_id}；请先更新下载`);
    const baseId = row?.base_id ?? `local-${doc.sha256.slice(0, 20)}`;
    if (!row && store.findByBaseId(baseId)) throw new Error(`本地文件编号冲突：${baseId}`);
    const version = row?.version ?? 1;
    let pdfPath = row?.pdf_path ?? doc.path;
    if (row) {
      try {
        if (digest(await readFile(pdfPath)) !== doc.sha256) throw new Error('hash mismatch');
      } catch (error) {
        if (errorField(error, 'code') && errorField(error, 'code') !== 'ENOENT') throw error;
        pdfPath = doc.path;
      }
    }
    const paper = {
      baseId, arxivId: `${baseId}v${version}`, version, sha256: doc.sha256,
      title: row?.title || doc.title, pdfPath, pageCount: doc.pageCount,
      primaryTrack: row?.primary_track ?? config.localImport.defaultTrack,
      matchedTracks: [row?.primary_track ?? config.localImport.defaultTrack],
      sourceType: 'local_pdf',
    };
    papers.push(paper); plans.push({ paper, row });
  }
  const key = digest(JSON.stringify({ papers: papers.map((p) => [p.baseId, p.version, p.sha256]).sort(), parserConfigKey }));
  const previous = store.findLocalImportRun(key);
  if (resumeRunId && previous?.run_id !== resumeRunId) throw Object.assign(new Error('INPUT_CHANGED'), { code: 'INPUT_CHANGED' });
  if (selectedRun && selectedRun.status === 'completed') {
    // The current PDFs and parser configuration resolved the original stored key.
    // Replay before synthesized/pending filtering or startRun can mutate anything.
    await verifyConfirmedPdfFiles(scan.expectedFiles);
    onProgress({ type: 'task-start', phase: 'task', mode: 'local_import', runId: selectedRun.run_id, inputFingerprint: key });
    return { status: selectedRun.status, runId: selectedRun.run_id, replayed: true,
      fileCount: documents.length, duplicateCount: documents.length - unique.length,
      paperCount: papers.length, skippedCount: skippedCount + papers.length, successCount: 0, failureCount: 0 };
  }
  const resuming = previous && ['failed', 'running', 'awaiting_local_parse'].includes(previous.status);
  let previousManifest: { jobs: ResumeJob[] } | undefined;
  if (resuming) {
    try { previousManifest = resumeManifest(JSON.parse(await readFile(join(paths.runsRoot, previous.run_id, 'mineru-jobs.json'), 'utf8')), previous.run_id); }
    catch (error) { if (errorField(error, 'code') !== 'ENOENT') throw error; }
  }
  const selectedPlans: ImportPlan[] = [];
  for (const plan of plans) {
    const { paper, row } = plan;
    const cached = await cachedParse(store, paper, config, parserConfigKey);
    const matching = await matchesParserConfig(cached, parserConfigKey);
    const earlierJob = previousManifest?.jobs.find((job) => job.baseId === paper.baseId);
    if ((previousManifest && !earlierJob) || (!resuming && !reparse && row?.status === 'synthesized' && matching)) { skippedCount++; continue; }
    selectedPlans.push({
      ...plan,
      previousAttemptId: earlierJob ? earlierJob.previousAttemptId : (cached?.attemptId ?? null),
      forceReparse: earlierJob ? earlierJob.forceReparse : Boolean(reparse || (cached && !matching)),
    });
  }
  plans = selectedPlans; papers = plans.map((plan) => plan.paper);
  const summary = { fileCount: documents.length, duplicateCount: documents.length - unique.length, skippedCount };
  // Planning awaits may outlive the initial inspection. No registration may
  // adopt a newly observed hash in place of the content the user confirmed.
  await verifyConfirmedPdfFiles(scan.expectedFiles);
  if (papers.length === 0) {
    return { ...summary, status: 'already_processed', paperCount: 0, successCount: 0, failureCount: 0 };
  }
  const run = store.startLocalImportRun(key, { force: reparse && !resuming });
  if (resumeRunId && run.id !== resumeRunId) throw Object.assign(new Error('RUN_ID_MISMATCH'), { code: 'RUN_ID_MISMATCH' });
  onProgress({ type: 'task-start', phase: 'task', mode: 'local_import', runId: run.id, inputFingerprint: key });
  const runRoot = join(paths.runsRoot, run.id);
  if (run.status === 'completed') {
    return { ...summary, skippedCount: skippedCount + papers.length, status: run.status, runId: run.id, paperCount: papers.length, successCount: 0, failureCount: 0, replayed: true };
  }
  try {
    await verifyConfirmedPdfFiles(scan.expectedFiles);
    for (const { paper, row } of plans) {
      if (!row) {
        store.upsertDiscovered(paper);
        store.markDownloaded(paper.baseId, paper.pdfPath, paper.primaryTrack ?? null, paper.sha256, paper.version);
      } else if (row.pdf_path !== paper.pdfPath) store.updatePdfPath(paper.baseId, paper.pdfPath);
    }
    const manifest = buildLocalParseManifest(run.id, papers, config, run);
    manifest.jobs.forEach((job, index) => Object.assign(job, {
      parserConfigKey, previousAttemptId: plans[index].previousAttemptId, forceReparse: plans[index].forceReparse,
    }));
    await writeLocalParseManifest(join(runRoot, 'mineru-jobs.json'), manifest);
    store.recordLocalParseManifest(run.id, manifest);
    const failures = []; let successCount = 0;
    const started = Date.now();
    for (let index = 0; index < papers.length; index++) {
      const paper = papers[index]; const start = Date.now();
      const progress = { phase: 'parse', current: index + 1, total: papers.length, baseId: paper.baseId, arxivId: paper.arxivId, model: config.model };
      onProgress({ type: 'parse-start', ...progress, totalElapsedMs: start - started });
      let result: ParseReport;
      try {
        const cached = await cachedParse(store, paper, config, parserConfigKey);
        const freshRequired = plans[index].forceReparse && cached?.attemptId === plans[index].previousAttemptId;
        // A generic parsed/synthesized row is not proof for this model/method.
        // Bypass that legacy shortcut unless an exact, config-matching cache exists.
        const force = Boolean(!cached || !(await matchesParserConfig(cached, parserConfigKey)) || freshRequired);
        const job = { ...buildLocalParseJob(paper, config, { reparse: force, method: force ? config.pipelineMethod : cached?.method }), parserConfigKey };
        await verifyConfirmedPdfFiles(scan.expectedFiles);
        result = await runLocalParse(job, { config, store, runner: runner ?? sessionRunner(mineruSession), processContext, signal });
      }
      catch (error) {
        if (errorField(error, 'code') === 'PREVIEW_CHANGED') throw error;
        const uncertain = errorField(error, 'code') === 'PROCESS_CLEANUP_UNCONFIRMED' || errorField(error, 'cleanupConfirmed') === false;
        const errorClass = errorField(error, 'errorClass');
        result = { baseId: paper.baseId, version: paper.version, model: config.model, method: config.pipelineMethod ?? 'auto', status: 'failed', errorMessage: redactErrorMessage(error), ...(uncertain ? { errorCode: 'PROCESS_CLEANUP_UNCONFIRMED', cleanupConfirmed: false, errorClass: 'process_cleanup_unconfirmed' } : { errorClass: typeof errorClass === 'string' ? errorClass : undefined }) };
      }
      await verifyConfirmedPdfFiles(scan.expectedFiles);
      const ok = result.status === 'succeeded';
      if (ok) successCount++;
      else failures.push({ baseId: paper.baseId, path: paper.pdfPath, error: result.errorMessage ?? '解析记录未完成，请稍后重试' });
      onProgress({ type: 'parse-complete', ...progress, status: result.status, errorClass: result.errorClass ?? undefined, error: ok ? undefined : redactErrorMessage(result.errorMessage ?? '解析未完成'), attemptId: result.attemptId, elapsedMs: Date.now() - start, totalElapsedMs: Date.now() - started });
      if (result.cleanupConfirmed === false || result.errorCode === 'PROCESS_CLEANUP_UNCONFIRMED' || result.errorClass === 'process_cleanup_unconfirmed') break;
    }
    if (failures.length) {
      store.failRun(run.id, failures.map((f) => `${f.baseId}: ${f.error}`).join('\n'));
      return { ...summary, status: 'failed', runId: run.id, paperCount: papers.length, successCount, failureCount: failures.length, failures };
    }
    await verifyConfirmedPdfFiles(scan.expectedFiles);
    const sources = await readVerifiedRunSources({ runId: run.id, stateRoot: paths.dataRoot, store });
    onProgress({ type: 'archive-complete', phase: 'archive', runId: run.id, sourceCount: sources.length });
    notifyProgressObserver(onProgress, { type: 'evidence-publish-start', phase: 'evidence-publish', runId: run.id, sourceCount: sources.length });
    const publication = await publish({ runId: run.id, stateRoot: paths.dataRoot, tempRoot: paths.workRoot, vaultRoot: paths.vaultRoot, store,
      lastSuccess: run.to, eligibility: 'normal' });
    notifyProgressObserver(onProgress, { type: 'evidence-publish-complete', phase: 'evidence-publish', runId: run.id, sourceCount: publication.sourceCount,
      publicationId: publication.publicationId, replayed: publication.applyReplayed });
    return { ...summary, status: 'completed', runId: run.id, paperCount: papers.length, successCount, failureCount: 0,
      publicationId: publication.publicationId, replayed: publication.applyReplayed };
  } catch (error) {
    if (store.getRun(run.id)?.status !== 'completed') store.failRun(run.id, redactErrorMessage(error));
    throw error;
  }
}
