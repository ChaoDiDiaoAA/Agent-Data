import test from 'node:test';
import assert from 'node:assert/strict';

async function loadProgressModule() { return import('../src/cli/progress.ts'); }

test('formats Chinese progress with counters, counts, and elapsed time', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.equal(typeof formatProgressEvent, 'function');
  const line = formatProgressEvent({
    type: 'discovery-shard-complete', phase: 'discovery', current: 4, total: 132,
    track: 'Agent-Skill', dateMode: 'updated', categories: ['cs.CR', 'cs.DB'],
    shardPaperCount: 3, discoveredCount: 11, elapsedMs: 42000, totalElapsedMs: 125000,
  });
  assert.ok(line);
  assert.match(line, /\[发现 4\/132\]/);
  assert.ok(line);
  assert.match(line, /本分片 3 篇/);
  assert.ok(line);
  assert.match(line, /累计去重 11 篇/);
  assert.ok(line);
  assert.match(line, /耗时 00:42/);
});

test('formats arXiv rate-limit retry progress with attempts and fractional seconds', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  const line = formatProgressEvent({
    type: 'discovery-retry', phase: 'discovery', current: 13, total: 16,
    httpStatus: 429, attempt: 1, maxAttempts: 6, waitMs: 30500,
  });
  assert.equal(line, '[发现 13/16] arXiv 限流，第 1/6 次重试，等待 30.5 秒');
});

test('formats a bounded updated-scan warning without marking the shard failed', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.equal(formatProgressEvent({
    type: 'discovery-scan-truncated', phase: 'discovery', current: 13, total: 16,
    track: 'harness-control-loop', dateMode: 'updated', scannedEntries: 200,
  }), '[发现 13/16] harness-control-loop / updated 达到扫描上限 200 条，已保留窗口内候选并继续');
});

test('formats an arXiv system-capacity cooldown without calling it a retry', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  const line = formatProgressEvent({
    type: 'discovery-deferred', phase: 'discovery', current: 2, total: 16,
    httpStatus: 429, waitMs: 900000, rateLimitKind: 'system-capacity', retryNotBefore: '2026-09-04T00:15:00.000Z',
  });
  assert.match(line!, /2026-09-04 08:15:00 北京时间/);
  assert.match(line!, /系统容量受限/);
  assert.match(line!, /重新执行同一方向.*跳过已完成分片/);
});

test('formats a generic arXiv request-rate cooldown distinctly from system capacity', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  const line = formatProgressEvent({
    type: 'discovery-deferred', phase: 'discovery', current: 2, total: 16,
    httpStatus: 429, waitMs: 900000, rateLimitKind: 'request-rate', retryNotBefore: '2026-09-04T00:15:00.000Z',
  });
  assert.match(line!, /2026-09-04 08:15:00 北京时间/);
  assert.match(line!, /请求限流/);
  assert.doesNotMatch(line!, /系统容量/);
});

test('terminal reporter writes progress to its sink with a newline', async () => {
  const { createTerminalProgressReporter } = await loadProgressModule();
  assert.equal(typeof createTerminalProgressReporter, 'function');
  const output: string[] = [];
  const report = createTerminalProgressReporter({ write: (text) => output.push(text) });
  report({
    type: 'parse-complete', phase: 'parse', current: 1, total: 8,
    baseId: '2608.23146', arxivId: '2608.23146v1', model: 'pipeline',
    status: 'succeeded', elapsedMs: 198000, totalElapsedMs: 247000,
  });
  assert.equal(output.length, 1);
  assert.match(output[0], /\[MinerU 1\/8\]/);
  assert.match(output[0], /2608\.23146/);
  assert.match(output[0], /成功/);
  assert.match(output[0], /03:18/);
  assert.match(output[0], /\n$/);
});

test('formats failed stage, paper identity, and elapsed time', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  const line = formatProgressEvent({
    type: 'download-failed', phase: 'download', current: 2, total: 8,
    baseId: '2608.23146', arxivId: '2608.23146v1', error: 'HTTP 503',
    elapsedMs: 9000, totalElapsedMs: 69000,
  });
  assert.ok(line);
  assert.match(line, /\[下载 2\/8\]/);
  assert.ok(line);
  assert.match(line, /2608\.23146v1/);
  assert.ok(line);
  assert.match(line, /失败/);
  assert.ok(line);
  assert.match(line, /HTTP 503/);
  assert.ok(line);
  assert.match(line, /00:09/);
});

test('formats resumed run checkpoint progress', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.equal(formatProgressEvent({
    type: 'task-resume', phase: 'task', runId: '496cc573-abcd-1234',
    completedShards: 12, totalShards: 16,
  }), '[任务] 恢复 run 496cc573...，已完成 12/16 个分片');
});

test('task start shows the config path and effective paper limit separately from candidates', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  const line = formatProgressEvent({ type: 'task-start', mode: 'current',
    configPath: 'D:/fixture/config/pipeline.yaml', configuredLimit: 7, requestedLimit: 2,
    window: { from: '2026-01-01', to: '2026-08-30' } });
  assert.ok(line);
  assert.match(line, /D:\/fixture\/config\/pipeline.yaml/);
  assert.ok(line);
  assert.match(line, /配置上限 7 篇/);
  assert.ok(line);
  assert.match(line, /本次上限 2 篇/);
  assert.ok(line);
  assert.match(line, /候选数量不等于下载数量/);
});

test('selection output distinguishes hard-filter acceptance from allocation and spillover', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.equal(formatProgressEvent({ type: 'selection-complete', evaluatedCount: 292,
    acceptedCount: 200, selectedCount: 60, quotaCount: 41, spilloverCount: 19,
    selectedByTrack: { A: 60, B: 0 }, elapsedMs: 1200,
  }), '[筛选] 已评估 292 篇，自动筛选通过 200 篇，入选 60 篇（配额 41，补位 19），分类 A=60 / B=0，耗时 00:01');
});

test('selection output explains existing-library skips before allocating new candidates', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  const line = formatProgressEvent({ type: 'selection-complete', evaluatedCount: 304,
    acceptedCount: 211, existingCount: 20, newCandidateCount: 191, selectedCount: 60, elapsedMs: 1200 });
  assert.ok(line);
  assert.match(line, /库内已有跳过 20 篇/);
  assert.ok(line);
  assert.match(line, /剩余合格候选 191 篇/);
  assert.ok(line);
  assert.match(line, /入选 60 篇/);
});

test('recovery output distinguishes a fixed batch from a new selection', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.match(formatProgressEvent({ type: 'selection-resume', selectedCount: 2, parseReady: false })!, /恢复已固定的 2 篇.*不重新选篇/);
  assert.match(formatProgressEvent({ type: 'selection-resume', selectedCount: 2, parseReady: true })!, /直接继续解析/);
  assert.match(formatProgressEvent({ type: 'download-complete', status: 'resumed', arxivId: '2608.10001v1' })!, /恢复本批次已下载 PDF/);
});

test('formats a skipped discovery shard checkpoint', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.equal(formatProgressEvent({
    type: 'discovery-shard-skipped', phase: 'discovery', current: 1, total: 16,
    track: 'AI-FSD', dateMode: 'submitted',
  }), '[发现 1/16] 已有检查点，跳过');
});

test('formats deterministic Archive and Evidence publication progress', async () => {
  const { formatProgressEvent } = await loadProgressModule();
  assert.equal(formatProgressEvent({ type: 'archive-complete', phase: 'archive', sourceCount: 2, totalElapsedMs: 1200 }), '[Archive] 已生成 2 个来源，累计耗时 00:01');
  assert.equal(formatProgressEvent({ type: 'evidence-publish-start', phase: 'publish', sourceCount: 2, totalElapsedMs: 1300 }), '[Evidence] 发布 2 个来源开始（累计 00:01）');
  assert.equal(formatProgressEvent({ type: 'evidence-publish-complete', phase: 'publish', publicationId: 'evidence-run-1', sourceCount: 2, replayed: false, totalElapsedMs: 1400 }), '[Evidence] 发布 evidence-run-1 完成：2 个来源，累计耗时 00:01');
});
