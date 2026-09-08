import type { ExecFileOptions } from 'node:child_process';
import type { ArxivConfig, MachineConfig } from '../types/config.ts';
import type { ProcessContext } from '../runtime/process.ts';
import { runHarvestShards } from './opencli-runner.ts';
import { resolveArxivApiBase, resolveOpenCliProxyMode } from './arxiv-transport.ts';

type HarvestRunnerOptions = NonNullable<Parameters<typeof runHarvestShards>[2]>;

export type ArxivProbeStatus = 'reachable' | 'rate-limited' | 'unreachable';
export interface ArxivProbeResult {
  apiBase: string;
  proxyMode: NonNullable<MachineConfig['network']>['openCliProxyMode'];
  status: ArxivProbeStatus;
  httpStatus?: number;
  errorCode?: string;
}
export interface ArxivProbeOptions {
  arxiv: ArxivConfig;
  network?: MachineConfig['network'];
  projectRoot: string;
  tempRoot: string;
  processContext?: ProcessContext;
  signal?: AbortSignal;
  execFile?: HarvestRunnerOptions['execFile'];
  managedProcess?: HarvestRunnerOptions['managedProcess'];
  runHarvest?: typeof runHarvestShards;
}

function field(error: unknown, name: string): unknown {
  return error && typeof error === 'object' ? Reflect.get(error, name) : undefined;
}

export async function runArxivProbe(options: ArxivProbeOptions): Promise<ArxivProbeResult> {
  const apiBase = resolveArxivApiBase(options.network?.arxivApiBase);
  const proxyMode = resolveOpenCliProxyMode(options.network?.openCliProxyMode, options.network?.httpProxy !== undefined);
  const harvest = options.runHarvest ?? runHarvestShards;
  try {
    await harvest([
      { track: '__probe__', dateMode: 'submitted', query: 'all:electron', categories: ['cs.SE'], maxResults: 1 },
    ], { from: '2000-01-01', to: '2099-12-31' }, {
      // A probe is a read-only reachability check, not a harvest. Keep it
      // bounded while using the same child route and API-base selection.
      arxiv: {
        ...options.arxiv,
        maxAttempts: 1,
        maxBackoffMs: Math.max(options.arxiv.requestIntervalMs, Math.min(options.arxiv.maxBackoffMs, options.arxiv.requestIntervalMs)),
        requestTimeoutMs: Math.min(options.arxiv.requestTimeoutMs, 10_000),
      },
      network: options.network,
      projectRoot: options.projectRoot,
      tempRoot: options.tempRoot,
      processContext: options.processContext,
      signal: options.signal,
      ...(options.execFile === undefined ? {} : { execFile: options.execFile }),
      ...(options.managedProcess === undefined ? {} : { managedProcess: options.managedProcess }),
    });
    return { apiBase, proxyMode, status: 'reachable' };
  } catch (error) {
    const code = field(error, 'code');
    const httpStatus = field(error, 'httpStatus');
    if (code === 'ARXIV_CAPACITY_LIMITED' || httpStatus === 429) {
      return {
        apiBase, proxyMode, status: 'rate-limited', httpStatus: 429,
        errorCode: 'ARXIV_CAPACITY_LIMITED',
      };
    }
    return {
      apiBase, proxyMode, status: 'unreachable',
      ...(code === 'ARXIV_TRANSPORT_UNAVAILABLE' ? { errorCode: code } : {}),
      ...(typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
    };
  }
}
