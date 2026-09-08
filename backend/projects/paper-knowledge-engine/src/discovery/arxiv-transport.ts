import type { OpenCliProxyMode } from '../types/config.ts';

export const defaultArxivApiBase = 'https://export.arxiv.org/api/query';
const knownArxivApiBases = new Set([
  'https://arxiv.org/api/query',
  defaultArxivApiBase,
]);
const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const;
const protocolProxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY'] as const;
const noProxyValue = 'localhost,127.0.0.1,::1';

export function resolveArxivApiBase(value?: string): string {
  const candidate = value ?? defaultArxivApiBase;
  if (!knownArxivApiBases.has(candidate)) throw new Error('must be a known arXiv API base');
  return candidate;
}
export function resolveOpenCliProxyMode(value: unknown, hasConfiguredProxy: boolean): OpenCliProxyMode {
  if (value === undefined) return hasConfiguredProxy ? 'configured' : 'inherit';
  if (value === 'configured' || value === 'direct' || value === 'inherit') return value;
  throw new Error('must be configured, direct, or inherit');
}

function normalizedEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) env[platform === 'win32' ? key.toUpperCase() : key] = value;
  }
  return env;
}

function environmentKey(key: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? key.toUpperCase() : key;
}

function clearProxyEnvironment(env: Record<string, string>, platform: NodeJS.Platform): void {
  for (const key of proxyKeys) delete env[environmentKey(key, platform)];
}

function setProxyEnvironment(env: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void {
  env[environmentKey(key, platform)] = value;
  if (platform !== 'win32' && (key === 'HTTP_PROXY' || key === 'HTTPS_PROXY' || key === 'NO_PROXY')) {
    env[key.toLowerCase()] = value;
  }
}

export function buildOpenCliEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  options: { mode: OpenCliProxyMode; httpProxy?: string; platform?: NodeJS.Platform },
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const env = normalizedEnvironment(inherited, platform);
  if (options.mode === 'inherit') return env;
  clearProxyEnvironment(env, platform);
  if (options.mode === 'direct') {
    setProxyEnvironment(env, 'NO_PROXY', '*', platform);
    return env;
  }
  if (!options.httpProxy) throw new Error('configured OpenCLI route requires network.http_proxy');
  for (const key of protocolProxyKeys) setProxyEnvironment(env, key, options.httpProxy, platform);
  setProxyEnvironment(env, 'NO_PROXY', noProxyValue, platform);
  return env;
}
