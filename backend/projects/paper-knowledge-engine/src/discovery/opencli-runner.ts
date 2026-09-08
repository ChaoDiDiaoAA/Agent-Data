import { ArgumentError } from '@jackwener/opencli/errors';
import { fileURLToPath } from 'node:url';
import { loadProjectPaths } from '../shared/config.ts';
import { createProcessContext, runManagedProcess } from '../runtime/process.ts';
import { resolveOpenCliPackage, withOpenCliRuntime } from '../runtime/opencli.ts';
import { ensureOpenCliPrepared } from './opencli-install.ts';
import { arxivProgressPrefix, isArxivTransportCode } from '../../opencli/arxiv/retry.ts';
import { mergeShardResults } from './merge-results.ts';
import { assertHarvestedSourceMetadata } from '../types/papers.ts';
import type { ArxivConfig, MachineConfig } from '../types/config.ts';
import type { HarvestShard, PaperMetadata } from '../types/papers.ts';
import type { ProgressEvent, ProgressReporter, RunWindow } from '../types/jobs.ts';
import type { ProcessContext } from '../runtime/process.ts';
import type { ExecFileOptions } from 'node:child_process';
import { buildOpenCliEnvironment, resolveArxivApiBase, resolveOpenCliProxyMode } from './arxiv-transport.ts';

type Shard = Omit<HarvestShard, 'key' | 'maxResults'> & { key?: string; maxResults?: number };
type CheckpointShard = Shard & { key: string };
interface HarvestOptions extends Partial<ArxivConfig> {
  network?: MachineConfig['network'];
  arxiv?: Partial<ArxivConfig>; projectRoot?: string; processContext?: ProcessContext; signal?: AbortSignal;
  /** Required for an injected managed process; otherwise defaults to the project's configured work root. */
  tempRoot?: string;
  sleep?: (ms: number) => Promise<unknown>; clock?: () => number; onProgress?: ProgressReporter;
  managedProcess?: typeof runManagedProcess;
  execFile?: (file: string, args: string[], options: ExecFileOptions & { onStderr?: (chunk: string) => void }) => Promise<{ stdout: string; stderr?: string }>;
  checkpoint?: { completedKeys: Set<string>; start(shard: CheckpointShard, index: number): unknown; complete(shard: CheckpointShard, index: number, papers: PaperMetadata[]): unknown; fail(shard: CheckpointShard, index: number, error: unknown): unknown; loadMergedPapers(): PaperMetadata[] };
}

function createRetryProgressChannel(onProgress: ProgressReporter, progressBase: Omit<ProgressEvent, 'type'>) {
  let buffer = '';
  let deferred: {
    retryNotBefore: string; diagnostic?: string; waitMs?: number; httpStatus?: number;
    retryAfterMs?: number; rateLimitKind: 'request-rate' | 'system-capacity';
  } | undefined;
  let transport: { transportCode: string } | undefined;
  const consume = (line: string) => {
    if (!line.startsWith(arxivProgressPrefix)) return;
    try {
      const input: unknown = JSON.parse(line.slice(arxivProgressPrefix.length));
      if (!input || typeof input !== 'object' || Array.isArray(input)) return;
      const event = input as Record<string, unknown>;
       if (event.type !== 'discovery-retry' && event.type !== 'discovery-deferred' && event.type !== 'discovery-transport-failed' && event.type !== 'discovery-scan-truncated') return;
       if (event.type === 'discovery-scan-truncated') {
         if (event.dateMode !== 'updated' || typeof event.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(event.from)
           || !Number.isSafeInteger(event.scannedEntries) || Number(event.scannedEntries) < 1) return;
         onProgress({ ...event, ...progressBase, type: event.type });
         return;
       }
       for (const key of ['attempt', 'maxAttempts', 'waitMs', 'httpStatus', 'retryAfterMs']) {
        if (event[key] !== undefined && (typeof event[key] !== 'number' || !Number.isFinite(event[key]) || event[key] < 0)) return;
      }
      if (event.type === 'discovery-deferred') {
        if ((event.rateLimitKind !== 'system-capacity' && event.rateLimitKind !== 'request-rate')
          || typeof event.retryNotBefore !== 'string' || !Number.isFinite(Date.parse(event.retryNotBefore))
          || (event.diagnostic !== undefined && typeof event.diagnostic !== 'string')) return;
        deferred = {
          retryNotBefore: event.retryNotBefore,
          diagnostic: typeof event.diagnostic === 'string' ? event.diagnostic.slice(0, 1024) : undefined,
          waitMs: typeof event.waitMs === 'number' ? event.waitMs : undefined,
          httpStatus: typeof event.httpStatus === 'number' ? event.httpStatus : undefined,
          retryAfterMs: typeof event.retryAfterMs === 'number' ? event.retryAfterMs : undefined,
          rateLimitKind: event.rateLimitKind,
        };
      }
      if (event.type === 'discovery-transport-failed') {
        if (!isArxivTransportCode(event.transportCode)) return;
        transport = { transportCode: event.transportCode };
      }
      onProgress({ ...event, ...progressBase, type: event.type });
    } catch {}
  };
  return {
    write(chunk: string) {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consume(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer) consume(buffer.replace(/\r$/, ''));
      buffer = '';
    },
    deferred: () => deferred,
    transport: () => transport,
  };
}

function arxivDeferredError(event: NonNullable<ReturnType<ReturnType<typeof createRetryProgressChannel>['deferred']>>) {
  const reason = event.rateLimitKind === 'system-capacity' ? 'system capacity is temporarily unavailable' : 'request rate is temporarily limited';
  return Object.assign(
    new Error(`ARXIV_CAPACITY_LIMITED: arXiv ${reason}; retry after ${event.retryNotBefore}`),
    {
      code: 'ARXIV_CAPACITY_LIMITED', retryNotBefore: event.retryNotBefore,
      diagnostic: event.diagnostic, httpStatus: event.httpStatus,
      retryAfterMs: event.retryAfterMs, rateLimitKind: event.rateLimitKind,
    },
  );
}

function arxivTransportError(
  event: NonNullable<ReturnType<ReturnType<typeof createRetryProgressChannel>['transport']>>,
  proxyMode: string,
  apiBase: string,
) {
  const apiHost = new URL(apiBase).hostname;
  return Object.assign(
    new Error(`ARXIV_TRANSPORT_UNAVAILABLE: arXiv transport unavailable via ${proxyMode} route to ${apiHost}; verify API host reachability`),
    { code: 'ARXIV_TRANSPORT_UNAVAILABLE', transportCode: event.transportCode, proxyMode, apiHost },
  );
}

function isCleanInjectedChildExit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  return Number.isSafeInteger(code) && code !== 0;
}

function parseJsonOutput(stdout: string): unknown {
  const text = String(stdout ?? '').trim().replace(/\r?\n\s*Update available:[\s\S]*$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const starts = [...text].map((char, index) => ({ char, index })).filter(({ char }) => char === '{' || char === '[').map(({ index }) => index);
  for (const start of starts) {
    for (let end = text.length; end > start; end -= 1) {
      try { return JSON.parse(text.slice(start, end)); } catch {}
    }
  }
  throw new Error('OpenCLI harvest returned invalid JSON');
}

function decodeHarvest(stdout: string, shard: Shard): PaperMetadata[] {
  const parsed = parseJsonOutput(stdout);
  if (Array.isArray(parsed)) return parsed.map(readHarvestPaper);
  if (!parsed || typeof parsed !== 'object') throw new Error(`invalid OpenCLI harvest output for ${shard.track}/${shard.dateMode}`);
  const record = parsed as Record<string, unknown>;
  if (record.ok === false) {
    const error = record.error;
    const message: unknown = error && typeof error === 'object' ? Reflect.get(error, 'message') : undefined;
    throw new Error(typeof message === 'string' ? message : `OpenCLI harvest failed for ${shard.track}`);
  }
  if (record.schemaVersion === 1 && record.dateMode && record.dateMode !== shard.dateMode) throw new Error(`OpenCLI harvest date mode mismatch for ${shard.track}`);
  if (!Array.isArray(record.papers)) throw new Error(`invalid OpenCLI harvest output for ${shard.track}/${shard.dateMode}`);
  return record.papers.map(readHarvestPaper);
}

function readHarvestPaper(input: unknown): PaperMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid OpenCLI paper metadata');
  const p = input as Record<string, unknown>;
  for (const key of ['baseId', 'arxivId', 'id', 'title', 'summary', 'published', 'updated', 'submittedAt', 'updatedAt', 'status', 'pdfUrl']) {
    if (p[key] !== undefined && typeof p[key] !== 'string') throw new Error('invalid OpenCLI paper metadata');
  }
  for (const key of ['matchedTracks', 'eligibleTracks', 'dateModes', 'categories', 'authors']) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || !p[key].every(value => typeof value === 'string'))) throw new Error('invalid OpenCLI paper metadata');
  }
  if (p.version !== undefined && (typeof p.version !== 'number' || !Number.isSafeInteger(p.version) || p.version < 1)) throw new Error('invalid OpenCLI paper identity');
  const id = p.arxivId ?? p.id;
  if (!(typeof p.baseId === 'string' && p.baseId) && !(typeof id === 'string' && id)) throw new Error('invalid OpenCLI paper identity');
  if (typeof id === 'string' && typeof p.baseId === 'string' && id.replace(/v\d+$/, '') !== p.baseId) throw new Error('invalid OpenCLI paper identity');
  if (typeof id === 'string' && /v\d+$/.test(id) && p.version !== undefined && Number(id.match(/v(\d+)$/)?.[1]) !== p.version) throw new Error('invalid OpenCLI paper identity');
  for (const key of ['sha256', 'primaryTrack']) if (p[key] !== undefined && p[key] !== null && typeof p[key] !== 'string') throw new Error('invalid OpenCLI paper metadata');
  if (p.hasImportant2026Version !== undefined && typeof p.hasImportant2026Version !== 'boolean') throw new Error('invalid OpenCLI paper metadata');
  return p;
}

function buildArgs(shard: Shard, window: RunWindow, arxiv: Partial<ArxivConfig>, apiBase?: string) {
  return [
    'arxiv', 'harvest',
    ...(apiBase === undefined ? [] : ['--api-base', apiBase]),
    '--from', String(window.from).slice(0, 10),
    '--to', String(window.to).slice(0, 10),
    '--date-mode', shard.dateMode,
    '--track', shard.track,
    '--query', shard.query,
    '--categories', shard.categories.join(','),
    '--max-results', String(shard.maxResults),
    '--page-size', String(arxiv.pageSize),
    '--request-interval-ms', String(arxiv.requestIntervalMs),
    '--max-attempts', String(arxiv.maxAttempts),
    '--max-backoff-ms', String(arxiv.maxBackoffMs),
    '--request-timeout-ms', String(arxiv.requestTimeoutMs),
    '--retry-jitter-ms', String(arxiv.retryJitterMs),
    '--capacity-cooldown-ms', String(arxiv.capacityCooldownMs),
    '--start', '0',
    '--output', '-',
    '-f', 'json',
  ];
}

export async function runHarvestShards(shards: Shard[], window: RunWindow, options: HarvestOptions = {}) {
  if (options.checkpoint && shards.some(shard => !shard.key)) throw new Error('checkpoint shard key is required');
  const arxiv = options.arxiv ?? options;
  const requestIntervalMs = Number(arxiv.requestIntervalMs);
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 3000) throw new ArgumentError('request-interval-ms must be an integer of at least 3000');
  const projectRoot = options.projectRoot ?? fileURLToPath(new URL('../..', import.meta.url));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  const onProgress = options.onProgress ?? (() => undefined);
  const proxyMode = resolveOpenCliProxyMode(options.network?.openCliProxyMode, options.network?.httpProxy !== undefined);
  const selectedApiBase = options.network?.arxivApiBase === undefined
    ? undefined
    : resolveArxivApiBase(options.network.arxivApiBase);
  const explicitEnvironment = options.network?.openCliProxyMode !== undefined || options.network?.httpProxy !== undefined;
  const startedAt = clock();
  const results = [];
  for (let index = 0; index < shards.length; index += 1) {
    const shard = shards[index];
    const shardStartedAt = clock();
    const progressBase = {
      phase: 'discovery',
      current: index + 1,
      total: shards.length,
      track: shard.track,
      dateMode: shard.dateMode,
      categories: shard.categories,
    };
    if (shard.key !== undefined && options.checkpoint?.completedKeys.has(shard.key)) {
      onProgress({ type: 'discovery-shard-skipped', ...progressBase });
      continue;
    }
    options.checkpoint?.start({ ...shard, key: shard.key ?? '' }, index);
    onProgress({ type: 'discovery-shard-start', ...progressBase, totalElapsedMs: shardStartedAt - startedAt });
    const args = buildArgs(shard, window, { ...arxiv, requestIntervalMs }, selectedApiBase);
    const retryProgress = createRetryProgressChannel(onProgress, progressBase);
    let papers;
    let deferredPromotionAllowed = false;
    try {
      let stdout;
      if (options.execFile && !options.managedProcess) {
        // Preserve the explicit injected transport seam used by existing callers/tests.
        // The production default below never discovers a global executable.
        const context = options.processContext ?? createProcessContext(projectRoot);
        try {
          ({ stdout } = await options.execFile(process.execPath, [resolveOpenCliPackage(projectRoot).entrypoint, ...args], {
            windowsHide: true, maxBuffer: context.policy.maxOutputBytes,
            ...(explicitEnvironment ? { env: buildOpenCliEnvironment(process.env, { mode: proxyMode, httpProxy: options.network?.httpProxy }) } : {}),
            onStderr: (chunk) => retryProgress.write(chunk),
          }));
        } catch (error) {
          deferredPromotionAllowed = isCleanInjectedChildExit(error);
          throw error;
        }
      } else {
        if (options.managedProcess && !options.tempRoot) throw new ArgumentError('tempRoot is required with managedProcess');
        const processContext = options.processContext ?? createProcessContext(projectRoot);
        const tempRoot = options.tempRoot ?? loadProjectPaths({ root: projectRoot }).tempRoot;
        await ensureOpenCliPrepared({ projectRoot, tempRoot });
        const result = await withOpenCliRuntime({ projectRoot, tempRoot }, runtime => (options.managedProcess ?? runManagedProcess)({
          ...processContext, executable: runtime.executable, args: [...runtime.prefixArgs, ...args],
          cwd: runtime.cwd, env: {
            ...buildOpenCliEnvironment(runtime.env, { mode: proxyMode, httpProxy: options.network?.httpProxy }),
            FSD_PROCESS_MAX_OUTPUT_BYTES: String(processContext.policy.maxOutputBytes),
          }, timeoutMs: null,
        }, { signal: options.signal, onStderr: (chunk) => retryProgress.write(chunk) }));
        if (!result.cleanupConfirmed) throw Object.assign(new Error('PROCESS_CLEANUP_UNCONFIRMED: OpenCLI process cleanup was not confirmed'), { code: 'PROCESS_CLEANUP_UNCONFIRMED', cleanupConfirmed: false });
        if (result.reason !== 'exit' || result.exitCode !== 0) {
          deferredPromotionAllowed = result.reason === 'exit' && typeof result.exitCode === 'number' && result.exitCode !== 0;
          throw Object.assign(new Error(`OpenCLI harvest ${result.reason}: ${result.stderr || `exit ${result.exitCode}`}`), { code: `PROCESS_${result.reason.toUpperCase().replaceAll('-', '_')}` });
        }
        stdout = result.stdout;
      }
      retryProgress.flush();
      papers = decodeHarvest(stdout, shard);
      if (options.checkpoint) assertHarvestedSourceMetadata(papers);
      options.checkpoint?.complete({ ...shard, key: shard.key ?? '' }, index, papers);
    } catch (caught) {
      retryProgress.flush();
      const deferred = retryProgress.deferred();
      const transport = retryProgress.transport();
      const error = deferred && deferredPromotionAllowed
        ? arxivDeferredError(deferred)
        : transport && deferredPromotionAllowed
          ? arxivTransportError(transport, proxyMode, selectedApiBase ?? resolveArxivApiBase())
          : caught;
      options.checkpoint?.fail({ ...shard, key: shard.key ?? '' }, index, error);
      const failedAt = clock();
      onProgress({
        type: 'discovery-shard-failed',
        ...progressBase,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: failedAt - shardStartedAt,
        totalElapsedMs: failedAt - startedAt,
      });
      throw error;
    }
    results.push({ shard, papers });
    const finishedAt = clock();
    onProgress({
      type: 'discovery-shard-complete',
      ...progressBase,
      shardPaperCount: papers.length,
      discoveredCount: options.checkpoint
        ? options.checkpoint.loadMergedPapers().length
        : mergeShardResults(results).length,
      elapsedMs: finishedAt - shardStartedAt,
      totalElapsedMs: finishedAt - startedAt,
    });
    if (index < shards.length - 1) await sleep(requestIntervalMs);
  }
  return options.checkpoint?.loadMergedPapers() ?? mergeShardResults(results);
}
