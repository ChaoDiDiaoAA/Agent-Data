import { extname, join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadPaths, loadSourceConfig, loadWorkbenchConfig, resolveOwnedPath } from './config.ts';
import type { SourceTransport } from './sources/dataset-records.ts';
import { acquireVoxel51Selection, probeVoxel51 } from './sources/voxel51.ts';
import { mapVoxel51Selection } from './labels/voxel51.ts';
import { publishStructuredSnapshot } from './structured-snapshot.ts';
import { parseSelection } from './process-samples.ts';
import { canonicalJson, hashCanonical, realTree, verifyNormalizedOutput, withRunLock, type ParseDependencies } from './engine-bridge.ts';
import { acquirePublicFiles, parsePublicKnowledge } from './sources/public-files.ts';
import { rebuildCatalog } from './catalog.ts';
import { buildRelease, loadReleaseRecords, loadReleaseSourceConfig, verifyRelease } from './release.ts';
import { createBackup, restoreBackup, verifyBackup, verifyRestoredBackup } from './backup.ts';
import { verifyStructuredSnapshot } from './structured-snapshot.ts';
import { sha256File } from './file-store.ts';

export const usage = 'Usage: flowmate-data [menu] | [--paths <path>] [--config <path>] <command>';

const defaultPathsPath = join(import.meta.dir, '../config/paths.local.json');
const defaultWorkbenchPath = join(import.meta.dir, '../config/workbench.local.json');

type MenuOutput = Pick<NodeJS.WritableStream, 'write'>;

export interface MenuOptions {
  pathsPath?: string;
  configPath?: string;
  input?: NodeJS.ReadableStream;
  output?: MenuOutput;
  ask?: (prompt: string) => Promise<string>;
  execute?: typeof runCli;
  transport?: SourceTransport;
  parseDependencies?: ParseDependencies;
}

function sourceConfigPath(sourceId: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceId)) throw new Error('SOURCE_CONFIG_INVALID_ID');
  return join(import.meta.dir, `../config/sources/${sourceId}.json`);
}

function resolveReleaseVersion(paths: ReturnType<typeof loadPaths>, version: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(version)) throw new Error('RELEASE_INVALID_ID');
  return resolveOwnedPath(paths.dataRoot, `releases/${version}`);
}

async function verifyHash(path: string, expected: string, code: string): Promise<void> {
  if (await sha256File(path) !== expected) throw new Error(code);
}

async function verifySelectedData(paths: ReturnType<typeof loadPaths>, records: Awaited<ReturnType<typeof loadReleaseRecords>>['records']): Promise<{ parsedImage: boolean }> {
  let parsedImage = false;
  for (const record of records) {
    const recordPath = resolveOwnedPath(paths.dataRoot, `datasets/${record.dataset_id}/samples/${record.sample_id}/record.json`);
    const recordBytes = await readFile(recordPath);
    if (recordBytes.toString('utf8') !== canonicalJson(record) || hashCanonical(record) !== await sha256File(recordPath)) throw new Error('VERIFY_RECORD_HASH_INVALID');
    const originalPath = resolveOwnedPath(paths.originalRoot, record.original_ref.path);
    await verifyHash(originalPath, record.original_sha256, 'VERIFY_ORIGINAL_HASH_INVALID');
    if (!record.annotation_ref || !record.annotation_sha256) throw new Error('VERIFY_ANNOTATION_MISSING');
    await verifyHash(resolveOwnedPath(paths.originalRoot, record.annotation_ref.path), record.annotation_sha256, 'VERIFY_ANNOTATION_HASH_INVALID');
    if (record.label_kind === 'none' || !record.label_ref || !record.label_sha256) throw new Error('VERIFY_LABEL_MISSING');
    await verifyHash(resolveOwnedPath(paths.dataRoot, record.label_ref.path), record.label_sha256, 'VERIFY_LABEL_HASH_INVALID');
    const snapshotPath = resolveOwnedPath(paths.originalRoot, `datasets/${record.dataset_id}/samples/${record.sample_id}/structured`);
    const snapshot = await verifyStructuredSnapshot(snapshotPath);
    if (snapshot.record_sha256 !== hashCanonical(record)) throw new Error('VERIFY_SNAPSHOT_RECORD_MISMATCH');
    if (record.derived_ref && record.content_sha256) {
      const normalized = await verifyNormalizedOutput(resolveOwnedPath(paths.dataRoot, record.derived_ref.path));
      if (normalized.contentHash !== record.content_sha256 || snapshot.content_sha256 !== record.content_sha256) throw new Error('VERIFY_PARSED_HASH_INVALID');
      if (['.jpg', '.jpeg', '.png'].includes(extname(record.original_ref.path).toLowerCase())) parsedImage = true;
    }
  }
  return { parsedImage };
}

function writeMenu(output: MenuOutput, value: string): void {
  output.write(`${value}\n`);
}

function menuConfigSummary(pathsPath: string, configPath: string, workbench: ReturnType<typeof loadWorkbenchConfig>, source: ReturnType<typeof loadSourceConfig>): string {
  const total = source.record_count === undefined ? '未配置' : String(source.record_count);
  const annotated = source.annotated_record_count === undefined ? '未配置' : String(source.annotated_record_count);
  const taskLimit = String(workbench.sample.acquire_limit);
  const limitWarning = source.annotated_record_count !== undefined && workbench.sample.acquire_limit > source.annotated_record_count
    ? '警告：workbench.sample.acquire_limit 超过可标注数量，采集会被拒绝。'
    : '';
  return [
    'FlowmateData（Bun CLI）',
    `路径配置：${pathsPath}`,
    `运行配置：${configPath}`,
    `当前来源：${source.source_id}`,
    `当前数据集：${source.dataset_id ?? '未配置'}`,
    `数据集发票总量：${total}`,
    `可采集的带标注发票：${annotated}`,
    `当前任务数量（获取与解析）：${taskLimit} 条`,
    `执行当前任务会获取并解析同一批 ${taskLimit} 条发票。`,
    '任务完成后会继续构建 Obsidian、Release、校验结果并创建备份。',
    ...(limitWarning ? [limitWarning] : []),
  ].join('\n');
}

function menuCommand(args: string[], pathsPath: string, configPath: string): string[] {
  return [...args, '--paths', pathsPath, '--config', configPath];
}

function menuLabel(workbench: ReturnType<typeof loadWorkbenchConfig>): string {
  const taskLimit = String(workbench.sample.acquire_limit);
  return [
    '=========================',
    `当前任务数量（获取与解析）：${taskLimit} 条`,
    '1. 查看来源和任务配置',
    `2. 执行当前任务（获取并解析 ${taskLimit} 条）`,
    '3. 校验当前任务',
    `4. 创建备份（verify=${workbench.backup.verify}, restore_smoke=${workbench.backup.restore_smoke}）`,
    '0. 退出',
  ].join('\n');
}

interface MenuStep {
  label: string;
  commands: string[][];
}

function menuTaskSteps(pathsPath: string, configPath: string, workbench: ReturnType<typeof loadWorkbenchConfig>, source: ReturnType<typeof loadSourceConfig>): MenuStep[] {
  const common = (args: string[]) => menuCommand(args, pathsPath, configPath);
  const taskLimit = workbench.sample.acquire_limit;
  return [
    { label: '探测公开来源', commands: [common(['source', 'probe', source.source_id])] },
    { label: `获取并固定 ${taskLimit} 条发票`, commands: [common(['acquire', source.source_id])] },
    { label: `映射 ${taskLimit} 条标签并发布结构化镜像`, commands: [common(['labels', 'map', workbench.sample.dataset_id])] },
    { label: `MinerU 解析同一批 ${taskLimit} 条发票`, commands: [common(['parse'])] },
    { label: '构建 Obsidian 目录', commands: [common(['catalog', 'build'])] },
    { label: `构建 Release（${workbench.release.version}）`, commands: [common(['release', 'build', workbench.release.version])] },
    { label: '校验 Release 和当前任务', commands: [common(['release', 'verify', workbench.release.version]), common(['verify'])] },
    { label: '创建备份', commands: [common(['backup', 'create'])] },
  ];
}

/** Run the interactive Flowmate menu. The menu never asks for a quantity; it reads the local config. */
export async function runMenu(options: MenuOptions = {}): Promise<number> {
  const pathsPath = options.pathsPath ?? defaultPathsPath;
  const configPath = options.configPath ?? defaultWorkbenchPath;
  loadPaths(pathsPath);
  const workbench = loadWorkbenchConfig(configPath);
  const source = loadSourceConfig(sourceConfigPath(workbench.sample.source_id));
  if (source.source_id !== workbench.sample.source_id || source.dataset_id !== workbench.sample.dataset_id) throw new Error('WORKBENCH_SAMPLE_SOURCE_MISMATCH');

  const output = options.output ?? stdout;
  const execute = options.execute ?? runCli;
  let reader: ReturnType<typeof createInterface> | undefined;
  const ask = options.ask ?? (async (prompt: string) => {
    reader ??= createInterface({ input: options.input ?? stdin, output: output as NodeJS.WritableStream });
    return reader.question(prompt);
  });
  const invoke = async (args: string[]): Promise<number> => execute(args, {
    transport: options.transport,
    parseDependencies: options.parseDependencies,
    print: value => writeMenu(output, typeof value === 'string' ? value : JSON.stringify(value, null, 2)),
  });

  try {
    for (;;) {
      writeMenu(output, menuLabel(workbench));
      const choice = (await ask('请输入编号：')).trim().toLowerCase();
      if (choice === '0') return 0;
      if (choice === '1') {
        writeMenu(output, menuConfigSummary(pathsPath, configPath, workbench, source));
        continue;
      }
      if (!['2', '3', '4'].includes(choice)) {
        writeMenu(output, '无效选项，请重新选择。');
        continue;
      }

      const steps = menuTaskSteps(pathsPath, configPath, workbench, source);
      const stepsByChoice: Record<string, MenuStep[]> = {
        '2': steps,
        '3': [steps[6]!],
        '4': [steps[7]!],
      };
      let failed = false;
      for (const step of stepsByChoice[choice]!) {
        writeMenu(output, `\n${step.label}`);
        for (const command of step.commands) {
          let code: number;
          try {
            code = await invoke(command);
          } catch (error) {
            writeMenu(output, `操作失败：${error instanceof Error ? error.message : 'VOXEL51_FAILED'}。`);
            failed = true;
            break;
          }
          if (code !== 0) {
            writeMenu(output, `操作失败，退出码：${code}。`);
            failed = true;
            break;
          }
        }
        if (failed) break;
      }
      if (!failed) writeMenu(output, '操作完成。');
    }
  } finally {
    reader?.close();
  }
}

export async function runCli(arguments_: string[], options: { transport?: SourceTransport; print?: (value: unknown) => void; parseDependencies?: ParseDependencies } = {}): Promise<number> {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let publishSnapshotFlag = false;
  let includeOriginalsFlag = false;
  let backupVerifyFlag = false;
  let restoreSmokeFlag = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]!;
    if (!value.startsWith('--')) { positional.push(value); continue; }
    if (value === '--publish-snapshot') {
      if (publishSnapshotFlag) return 2;
      publishSnapshotFlag = true;
      continue;
    }
    if (value === '--include-originals') {
      if (includeOriginalsFlag) return 2;
      includeOriginalsFlag = true;
      continue;
    }
    if (value === '--verify') {
      if (backupVerifyFlag) return 2;
      backupVerifyFlag = true;
      continue;
    }
    if (value === '--restore-smoke') {
      if (restoreSmokeFlag) return 2;
      restoreSmokeFlag = true;
      continue;
    }
    if (!['--paths', '--config', '--selection', '--limit', '--release'].includes(value) || flags.has(value) || !arguments_[index + 1] || arguments_[index + 1]!.startsWith('--')) return 2;
    flags.set(value, arguments_[++index]!);
  }
  const probe = positional.join(' ') === 'source probe voxel51-invoice-ocr';
  const acquire = positional.join(' ') === 'acquire voxel51-invoice-ocr';
  const mapLabels = positional.join(' ') === 'labels map voxel51-hq-invoice-ocr';
  const parse = positional.join(' ') === 'parse';
  const catalogBuild = positional.join(' ') === 'catalog build';
  const releaseBuild = positional[0] === 'release' && positional[1] === 'build' && (positional.length === 2 || positional.length === 3);
  const releaseVerify = positional[0] === 'release' && positional[1] === 'verify' && (positional.length === 2 || positional.length === 3);
  const backupCreate = positional.join(' ') === 'backup create';
  const verifyAction = positional.join(' ') === 'verify';
  const knowledgeAction = positional[0] === 'knowledge' && (positional[1] === 'acquire' || positional[1] === 'parse') && positional.length >= 2 ? positional[1] : undefined;
  if ((!probe && !acquire && !mapLabels && !parse && !catalogBuild && !knowledgeAction && !releaseBuild && !releaseVerify && !backupCreate && !verifyAction) || !flags.has('--paths')) return 2;
  if (probe && (flags.has('--selection') || flags.has('--limit') || publishSnapshotFlag)) return 2;
  const limitText = flags.get('--limit');
  const validLimitFlag = limitText === undefined || /^\d+$/.test(limitText) && Number.isSafeInteger(Number(limitText)) && Number(limitText) > 0;
  if ((acquire || parse) && !validLimitFlag) return 2;
  if (mapLabels && flags.has('--limit')) return 2;
  if (knowledgeAction && (flags.has('--selection') || flags.has('--limit') || publishSnapshotFlag)) return 2;
  if (releaseBuild && (flags.has('--limit') || publishSnapshotFlag)) return 2;
  if (releaseBuild && flags.has('--release')) return 2;
  if (releaseVerify && (flags.has('--selection') || flags.has('--limit') || publishSnapshotFlag || includeOriginalsFlag)) return 2;
  if (!verifyAction && !releaseBuild && flags.has('--release')) return 2;
  if (!releaseBuild && includeOriginalsFlag) return 2;
  if (!backupCreate && (backupVerifyFlag || restoreSmokeFlag)) return 2;
  if (backupCreate && (flags.has('--selection') || flags.has('--limit') || publishSnapshotFlag || includeOriginalsFlag)) return 2;
  if (verifyAction && (flags.has('--limit') || publishSnapshotFlag || includeOriginalsFlag || backupVerifyFlag || restoreSmokeFlag)) return 2;
  const paths = loadPaths(flags.get('--paths')!);
  const workbench = loadWorkbenchConfig(flags.get('--config') ?? defaultWorkbenchPath);
  const sampleSourceConfig = loadSourceConfig(sourceConfigPath(workbench.sample.source_id));
  if (sampleSourceConfig.source_id !== workbench.sample.source_id || sampleSourceConfig.dataset_id !== workbench.sample.dataset_id) throw new Error('WORKBENCH_SAMPLE_SOURCE_MISMATCH');
  const selectionId = flags.get('--selection') ?? workbench.sample.selection_id;
  const acquireLimit = limitText === undefined ? workbench.sample.acquire_limit : Number(limitText);
  const parseLimit = limitText === undefined ? workbench.sample.acquire_limit : Number(limitText);
  const releaseVersion = positional[2] ?? workbench.release.version;
  const knowledgeSourceIds = knowledgeAction
    ? (positional.length > 2 ? positional.slice(2) : knowledgeAction === 'parse' ? workbench.knowledge.parse_source_ids : workbench.knowledge.source_ids)
    : [];
  if (knowledgeAction) {
    const allowed = knowledgeAction === 'parse' ? workbench.knowledge.parse_source_ids : workbench.knowledge.source_ids;
    if (knowledgeSourceIds.some(sourceId => !allowed.includes(sourceId))) throw new Error('KNOWLEDGE_SOURCE_NOT_CONFIGURED');
  }
  const publishSnapshot = publishSnapshotFlag || workbench.sample.publish_snapshot;
  const includeOriginals = includeOriginalsFlag || workbench.release.include_originals;
  const backupVerify = backupVerifyFlag || workbench.backup.verify;
  const restoreSmoke = restoreSmokeFlag || workbench.backup.restore_smoke;
  if (catalogBuild) {
    const plan = await rebuildCatalog(paths);
    (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))({ files: plan.files.length });
    return 0;
  }
  if (releaseBuild) {
    const selected = await loadReleaseRecords(paths, selectionId);
    const result = await buildRelease({ paths, version: releaseVersion, records: selected.records, selectionId, selectionHash: selected.selectionHash, includeOriginals, sourceConfig: await loadReleaseSourceConfig() });
    (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))({ version: result.manifest.version, path: result.path, entries: result.manifest.entries.length, omitted_originals: result.manifest.omitted_originals.length });
    return 0;
  }
  if (verifyAction) {
    return withRunLock(resolveOwnedPath(paths.dataRoot, 'work/run.lock'), async () => {
      const selected = await loadReleaseRecords(paths, selectionId);
      const release = await verifyRelease(resolveReleaseVersion(paths, flags.get('--release') ?? releaseVersion));
      const selectedEntries = selected.records.map(record => ({ dataset_id: record.dataset_id, sample_id: record.sample_id, source_record_id: record.source_record_id, dataset_revision: record.dataset_revision }))
        .sort((left, right) => `${left.dataset_id}/${left.sample_id}/${left.source_record_id}`.localeCompare(`${right.dataset_id}/${right.sample_id}/${right.source_record_id}`));
      const releaseEntries = release.manifest.entries.map(entry => ({ dataset_id: entry.dataset_id, sample_id: entry.sample_id, source_record_id: entry.source_record_id, dataset_revision: entry.dataset_revision }))
        .sort((left, right) => `${left.dataset_id}/${left.sample_id}/${left.source_record_id}`.localeCompare(`${right.dataset_id}/${right.sample_id}/${right.source_record_id}`));
      if (release.manifest.selection_id !== selectionId || release.manifest.selection_hash !== selected.selectionHash
        || releaseEntries.length !== selectedEntries.length || JSON.stringify(releaseEntries) !== JSON.stringify(selectedEntries)) throw new Error('VERIFY_SELECTION_MISMATCH');
      if (!flags.has('--selection') && selected.records.length !== workbench.sample.acquire_limit) throw new Error('VERIFY_CONFIGURED_SAMPLE_COUNT_MISMATCH');
      const selectedData = await verifySelectedData(paths, selected.records);
      if (!selectedData.parsedImage) throw new Error('VERIFY_IMAGE_PARSE_MISSING');
      const catalogPlan = await rebuildCatalog(paths, { lockHeld: true });
      (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))({ selection: selectionId, records: selected.records.length, release: release.manifest.version, release_files: release.files.length, cards: catalogPlan.files.length,
        projection_valid: true, acceptance_complete: false, pending: ['duplicate_acquisition', 'fsd_unchanged'] });
      return 0;
    }, { jobId: 'flowmate-verify' });
  }
  if (releaseVerify) {
    const releasePath = resolveReleaseVersion(paths, releaseVersion);
    const result = await verifyRelease(releasePath);
    (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))({ version: result.manifest.version, files: result.files.length });
    return 0;
  }
  if (backupCreate) {
    const backupId = `public-invoice-p0-${crypto.randomUUID()}`;
    const result = await createBackup(paths, backupId);
    if (backupVerify) await verifyBackup(result.path);
    let restored = false;
    if (restoreSmoke) {
      const smokeRoot = resolveOwnedPath(paths.backupRoot, `.restore-smoke-${crypto.randomUUID()}`);
      const destinationRoots = { originalRoot: resolveOwnedPath(smokeRoot, 'original'), dataRoot: resolveOwnedPath(smokeRoot, 'data'), vaultRoot: resolveOwnedPath(smokeRoot, 'vault') };
      try {
        const restoredPaths = { ...paths, ...destinationRoots };
        await restoreBackup({ backup: result.path, destinationRoots, currentRoots: { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot } });
        await verifyRestoredBackup({ backup: result.path, destinationRoots, currentRoots: { originalRoot: paths.originalRoot, dataRoot: paths.dataRoot, vaultRoot: paths.vaultRoot } });
        let snapshotNames: string[] = [];
        try { snapshotNames = await realTree(destinationRoots.originalRoot); }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        for (const name of snapshotNames.filter(value => value.startsWith('datasets/') && value.endsWith('/structured/snapshot.json'))) {
          await verifyStructuredSnapshot(resolveOwnedPath(destinationRoots.originalRoot, name.slice(0, -'/snapshot.json'.length)));
        }
        const plan = await rebuildCatalog(restoredPaths);
        if (!(await Bun.file(resolveOwnedPath(destinationRoots.vaultRoot, '01_Index/Samples.md')).exists())) throw new Error('BACKUP_RESTORE_CATALOG_MISSING');
        restored = true;
      } finally {
        await rm(smokeRoot, { recursive: true, force: true });
      }
    }
    (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))({ path: result.path, backup_id: result.manifest.backup_id, verified: backupVerify, restore_smoke: restored });
    return 0;
  }
  if (parse) {
    const result = await parseSelection({ paths, selectionId, limit: parseLimit }, options.parseDependencies);
    (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return 0;
  }
  if (knowledgeAction) {
    const results = [];
    for (const sourceId of knowledgeSourceIds) {
      const config = loadSourceConfig(sourceConfigPath(sourceId));
      if (config.source_id !== sourceId) throw new Error('KNOWLEDGE_SOURCE_IDENTITY_MISMATCH');
      if (knowledgeAction === 'acquire') {
        const acquired = await acquirePublicFiles({ paths, config, transport: options.transport });
        results.push({ source_id: sourceId, acquired: acquired.records.length, records: acquired.records.map(record => ({ file_id: record.file_id, parse_status: record.parse_status, version: record.version })) });
      } else {
        const parsed = await parsePublicKnowledge({ paths, config }, options.parseDependencies);
        results.push({ source_id: sourceId, parsed: parsed.parsed, records: parsed.records.map(record => ({ file_id: record.file_id, parse_status: record.parse_status, version: record.version })) });
      }
    }
    const result = knowledgeAction === 'acquire'
      ? { acquired: results.reduce((total, item) => total + (item.acquired ?? 0), 0), sources: results }
      : { parsed: results.reduce((total, item) => total + (item.parsed ?? 0), 0), sources: results };
    (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
    return 0;
  }
  const config = sampleSourceConfig;
  const result = probe ? await probeVoxel51(config, { transport: options.transport })
    : acquire ? await acquireVoxel51Selection({ paths, config, selectionId, limit: acquireLimit, transport: options.transport })
    : await withRunLock(resolveOwnedPath(paths.dataRoot, 'work/run.lock'), async () => {
      const mapping = await mapVoxel51Selection({ paths, datasetId: workbench.sample.dataset_id, selectionId, lockHeld: true });
      const snapshots = publishSnapshot ? await Promise.all(mapping.sample_ids.map(sampleId => publishStructuredSnapshot({ paths, datasetId: workbench.sample.dataset_id, sampleId, lockHeld: true }))) : [];
      const { sample_ids: _sampleIds, ...summary } = mapping;
      return { ...summary, snapshots: snapshots.length };
    }, { jobId: `flowmate-labels-${selectionId}` });
  (options.print ?? (value => console.log(JSON.stringify(value, null, 2))))(result);
  return 0;
}

if (import.meta.main) {
  try {
    const cliArguments = process.argv.slice(2);
    const exitCode = cliArguments.length === 0 || (cliArguments.length === 1 && cliArguments[0] === 'menu')
      ? await runMenu()
      : await runCli(cliArguments);
    if (exitCode !== 0) console.error(usage);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'VOXEL51_FAILED');
    process.exitCode = 1;
  }
}
