import { test, expect } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../src/cli.ts';
import { writeLayeredConfigFixture } from './fixtures/layered-config.ts';
import { parseLibrarySelection } from '../src/shared/engine-context.ts';

test('missing CLI library remains unselected and noninteractive tasks fail before writes', async () => {
  expect(parseLibrarySelection(['run-task']).libraryId).toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), 'library-required-'));
  try {
    await expect(main(['run-task', '--mode', 'current'], { root, interactive: false })).rejects.toThrow(/LIBRARY_ID_REQUIRED/);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('even a single library requires a choice; blank and unknown inputs never select it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-picker-'));
  try {
    await writeLayeredConfigFixture({ root });
    const prompts: string[] = [], lines: string[] = [], choices = ['', '99', '0'];
    await main([], { root, writeLine: line => { lines.push(line); }, readLine: async prompt => {
      prompts.push(prompt); return choices.shift() ?? '0';
    } });
    expect(prompts).toEqual(['请选择方向库', '请选择方向库', '请选择方向库']);
    expect(lines).toContain('1. FSD 论文知识库');
    expect(await readdir(root)).toEqual(['config']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an empty library list exits without prompting or creating state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-empty-'));
  try {
    const lines: string[] = [];
    await main([], { root, writeLine: line => { lines.push(line); }, readLine: async () => {
      throw new Error('must not prompt without libraries');
    } });
    expect(lines.some(line => line.includes('未找到方向库'))).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [choice, libraryId] of [
  ['1', 'fsd'],
  ['2', 'agent-engineering'],
  ['3', 'multi-agent-engineering'],
]) test(`library picker choice ${choice} opens ${libraryId} with the requested menu order`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-picker-order-'));
  try {
    await writeLayeredConfigFixture({ root, additionalLibraryIds: ['multi-agent-engineering', 'agent-engineering'] });
    const lines: string[] = [], choices = [choice!, '0'];
    await main([], { root, writeLine: line => { lines.push(line); }, readLine: async () => choices.shift() ?? '0' });
    expect(lines.slice(0, 6)).toEqual([
      '论文知识引擎（Bun CLI）',
      '请选择方向库：',
      '1. FSD 论文知识库',
      '2. Agent Engineering',
      '3. Multi-Agent Engineering',
      '0. 退出',
    ]);
    expect(lines[7]).toBe(`当前方向库：FSD 论文知识库（${libraryId}）`);
    expect(await readdir(root)).toEqual(['config']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('library picker keeps additional configured libraries selectable after the preferred directions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-picker-custom-'));
  try {
    await writeLayeredConfigFixture({ root, additionalLibraryIds: ['z-custom', 'a-custom', 'agent-engineering', 'multi-agent-engineering'] });
    const lines: string[] = [], choices = ['4', '0'];
    await main([], { root, writeLine: line => { lines.push(line); }, readLine: async () => choices.shift() ?? '0' });
    expect(lines.slice(5, 8)).toEqual(['4. FSD 论文知识库（a-custom）', '5. FSD 论文知识库（z-custom）', '0. 退出']);
    expect(lines[9]).toBe('当前方向库：FSD 论文知识库（a-custom）');
    expect(await readdir(root)).toEqual(['config']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('switching discovered libraries routes operations to distinct selected state directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-switch-'));
  try {
    await writeLayeredConfigFixture({ root, additionalLibraryIds: ['other'] });
    const prompts: string[] = [], choices = ['1', '2', '11', '2', '2', '0'];
    const executed: string[] = [];
    await main([], { root, output: () => {}, writeLine: () => {}, readLine: async prompt => {
      prompts.push(prompt); return choices.shift() ?? '0';
    }, execute: async ({ jobId }, deps) => {
      const job = JSON.parse(await readFile(join(deps!.operationsRoot!, `${jobId}.json`), 'utf8'));
      executed.push(job.libraryId);
      expect(deps!.operationsRoot).toBe(join(root, 'data-libraries', job.libraryId, 'operations'));
      return { ...job, status: 'completed' };
    } });
    expect(executed).toEqual(['fsd', 'other']);
    expect(prompts).toEqual(['请选择方向库', '请选择操作', '请选择操作', '请选择方向库', '请选择操作', '请选择操作']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
