import { test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dir, '../src');
const slash = (path: string) => path.replaceAll('\\', '/');
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [join(directory, entry.name)] : []);
const sources = new Map(files(root).map(file => [slash(relative(root, file)), readFileSync(file, 'utf8')]));
const scanner = new Bun.Transpiler({ loader: 'ts' });
const edges = [...sources].flatMap(([from, source]) => scanner.scanImports(source).filter(item => item.path.startsWith('.')).map(item => ({
  from, to: slash(relative(root, resolve(root, dirname(from), item.path))),
})));
// Type imports are erased by the runtime scanner but must not leak presentation contracts.
const allEdges = [...sources].flatMap(([from, source]) => [...source.matchAll(/\b(?:from\s*|import\s*\()\s*['"](\.{1,2}\/[^'"\r\n]+)['"]/g)].map(match => ({
  from, to: slash(relative(root, resolve(root, dirname(from), match[1]!))),
})));
const oldRootModules = [
  'cli-menu', 'opencli-install', 'opencli-runner', 'harvest-plan', 'harvest-checkpoint',
  'mineru-api-session', 'mineru-cli-runner', 'mineru-local-config', 'mineru-local-result', 'mineru-workspace', 'mineru-local-jobs', 'mineru-quality',
  'workflow', 'pipeline', 'worker', 'task-selection', 'paper-policy', 'metadata-verifier',
  'pdf-store', 'pdf-text', 'local-pdf-files', 'local-pdf-import', 'import-preview',
  'operation-contracts', 'operation-service', 'operation-store', 'job-bridge',
  'run-window', 'schedule-config', 'scheduler', 'state-store', 'task-artifacts', 'reconciliation',
];

test('capability moves remove the old root modules instead of leaving forwarding shims', () => {
  expect(oldRootModules.filter(name => existsSync(join(root, `${name}.ts`)))).toEqual([]);
  for (const path of ['cli/menu.ts', 'cli/routes.ts', 'discovery/checkpoint.ts', 'mineru/mineru-api-session.ts',
    'library/workflow.ts', 'library/pipeline.ts', 'library/worker.ts', 'library/selection/task-selection.ts',
    'library/sources/pdf-store.ts', 'library/operations/job-bridge.ts', 'library/schedule/scheduler.ts',
    'library/state/state-store.ts', 'maintenance/reconciliation.ts']) expect(existsSync(join(root, path))).toBe(true);
});

test('feature modules cannot import CLI presentation, even via dynamic imports', () => {
  expect(allEdges.filter(({ from, to }) => from !== 'cli.ts' && !from.startsWith('cli/') && (to === 'cli.ts' || to.startsWith('cli/')))).toEqual([]);
});

test('no static, type, export or dynamic import resolves to an old root module', () => {
  expect(allEdges.filter(({ to }) => oldRootModules.some(name => to === `${name}.ts` || to === name))).toEqual([]);
});

test('discovery, MinerU, Evidence and runtime do not import library orchestration', () => {
  expect(edges.filter(({ from, to }) => /^(discovery|mineru|evidence|runtime)\//.test(from) && to.startsWith('library/'))).toEqual([]);
});

test('all internal runtime imports resolve after moves', () => {
  expect(edges.filter(({ to }) => !existsSync(join(root, to)))).toEqual([]);
});

test('the runtime dependency graph has no static or dynamic import cycles', () => {
  const visited = new Set<string>();
  const active: string[] = [];
  const cycles: string[] = [];
  const visit = (file: string) => {
    if (active.includes(file)) { cycles.push([...active.slice(active.indexOf(file)), file].join(' -> ')); return; }
    if (visited.has(file)) return;
    active.push(file);
    for (const edge of edges.filter(edge => edge.from === file && sources.has(edge.to))) visit(edge.to);
    active.pop(); visited.add(file);
  };
  for (const file of sources.keys()) visit(file);
  expect(cycles).toEqual([]);
});

test('only cli.ts may read process argv or control the process exit lifecycle', () => {
  const entries = [...sources].filter(([file, source]) => file !== 'cli.ts' &&
    /import\.meta\.main|process\s*(?:\.\s*(?:argv|exitCode|exit)\b|\[\s*['"](?:argv|exitCode|exit)['"]\s*\])/.test(source)).map(([file]) => file);
  expect(entries).toEqual([]);
});

test('every non-entry source module imports silently without starting a command; supervisor is callable', async () => {
  const modules = [...sources.keys()].filter(file => file !== 'cli.ts');
  const urls = modules.map(file => pathToFileURL(join(root, file)).href);
  const script = `
    const urls = ${JSON.stringify(urls)};
    const effects = [];
    const savedArgv = process.argv;
    const argvDescriptor = Object.getOwnPropertyDescriptor(process, 'argv');
    const savedExitCode = process.exitCode;
    Object.defineProperty(process, 'argv', {
      configurable: true,
      get() { effects.push('read argv'); return savedArgv; },
      set() { effects.push('write argv'); },
    });
    let supervisor;
    for (const url of urls) {
      const imported = await import(url);
      if (url.endsWith('/runtime/process-supervisor.ts')) supervisor = typeof imported.runProcessSupervisor;
      if (process.exitCode !== savedExitCode) effects.push(url + ': exitCode=' + process.exitCode);
    }
    Object.defineProperty(process, 'argv', argvDescriptor);
    console.log(JSON.stringify({ imported: urls.length, supervisor, effects }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: resolve(root, '..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout: stdout.trim(), stderr, code }).toEqual({
      stdout: JSON.stringify({ imported: modules.length, supervisor: 'function', effects: [] }), stderr: '', code: 0,
    });
  } finally { clearTimeout(timeout); child.kill(); }
}, 20_000);
