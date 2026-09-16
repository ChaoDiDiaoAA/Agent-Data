import type { ProgressEvent, ProgressReporter } from '../types/jobs.ts';
import { arxivCooldownHint } from '../shared/arxiv-cooldown.ts';
function duration(milliseconds: number | undefined) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function paperId(event: ProgressEvent) {
  return event.arxivId ?? event.baseId ?? 'unknown';
}

export function formatProgressEvent(event: ProgressEvent): string | null {
  switch (event?.type) {
    case 'task-start':
      return `[任务] ${event.mode} / ${String(event.window?.from).slice(0, 10)} → ${String(event.window?.to).slice(0, 10)} 开始`
        + `\n[配置] ${event.configPath}；配置上限 ${event.configuredLimit} 篇，本次上限 ${event.requestedLimit} 篇`
        + '\n[说明] 发现阶段统计候选，候选数量不等于下载数量；筛选后才按任务上限下载与解析。';
    case 'task-resume':
      return `[任务] 恢复 run ${String(event.runId).slice(0, 8)}...，已完成 ${event.completedShards}/${event.totalShards} 个分片`;
    case 'evidence-history-preflight-start':
      return '[预检] 正在校验历史 Evidence、Archive 与 renderer，请稍候';
    case 'evidence-history-preflight-complete':
      return '[预检] 历史 Evidence 校验通过';
    case 'discovery-shard-skipped':
      return `[发现 ${event.current}/${event.total}] 已有检查点，跳过`;
    case 'discovery-shard-start':
      return `[发现 ${event.current}/${event.total}] ${event.track} / ${event.dateMode} / ${(event.categories ?? []).join(',')} 开始（累计 ${duration(event.totalElapsedMs)}）`;
    case 'discovery-retry': {
      const reason = event.httpStatus === 429 ? 'arXiv 限流' : 'arXiv 请求失败';
      return `[发现 ${event.current}/${event.total}] ${reason}，第 ${event.attempt}/${event.maxAttempts} 次重试，等待 ${Number(event.waitMs) / 1000} 秒`;
    }
    case 'discovery-deferred': {
      const reason = event.rateLimitKind === 'request-rate' ? 'arXiv 请求限流' : 'arXiv 系统容量受限';
      return `[发现 ${event.current}/${event.total}] ${reason}；已保存检查点，${arxivCooldownHint(event.retryNotBefore, event.waitMs === 0)}`;
    }
    case 'discovery-transport-failed':
      return `[发现 ${event.current}/${event.total}] arXiv 传输不可用（${event.transportCode ?? 'unknown'}）`;
    case 'discovery-scan-truncated':
      return `[发现 ${event.current}/${event.total}] ${event.track} / ${event.dateMode} 达到扫描上限 ${event.scannedEntries} 条，已保留窗口内候选并继续`;
    case 'discovery-shard-complete':
      return `[发现 ${event.current}/${event.total}] 完成：本分片 ${event.shardPaperCount} 篇，累计去重 ${event.discoveredCount} 篇，耗时 ${duration(event.elapsedMs)}`;
    case 'discovery-shard-failed':
      return `[发现 ${event.current}/${event.total}] ${event.track} / ${event.dateMode} 失败：${event.error}，耗时 ${duration(event.elapsedMs)}`;
    case 'discovery-complete':
      return `[发现] 全部分片完成：累计去重 ${event.discoveredCount} 篇，总耗时 ${duration(event.totalElapsedMs)}`;
    case 'selection-complete': {
      const acceptance = event.acceptedCount == null ? '' : `，自动筛选通过 ${event.acceptedCount} 篇`;
      const deduplication = event.existingCount == null ? ''
        : `，库内已有跳过 ${event.existingCount} 篇，剩余合格候选 ${event.newCandidateCount} 篇`;
      const allocation = event.quotaCount == null ? '' : `（配额 ${event.quotaCount}，补位 ${event.spilloverCount}）`;
      const categories = event.selectedByTrack
        ? `，分类 ${Object.entries(event.selectedByTrack).map(([track, count]) => `${track}=${count}`).join(' / ')}` : '';
      return `[筛选] 已评估 ${event.evaluatedCount} 篇${acceptance}${deduplication}，入选 ${event.selectedCount} 篇${allocation}${categories}，耗时 ${duration(event.elapsedMs)}`;
    }
    case 'selection-resume':
      return `[筛选] 恢复已固定的 ${event.selectedCount} 篇${event.fallbackCount ? `，备用候选 ${event.fallbackCount} 篇` : ''}，不重新选篇${event.parseReady ? '，直接继续解析' : '，继续本批次下载'}`;
    case 'download-start':
      return `[下载 ${event.current}/${event.total}] ${paperId(event)} 开始（累计 ${duration(event.totalElapsedMs)}）`;
    case 'download-complete': {
      const status = event.status === 'duplicate' ? '内容重复，跳过入库与解析'
        : event.status === 'resumed' ? '恢复本批次已下载 PDF'
        : event.status === 'reused' ? '复用已有 PDF' : '下载完成';
      const size = typeof event.bytes === 'number' && Number.isFinite(event.bytes) ? `，${(event.bytes / 1024 / 1024).toFixed(1)} MB` : '';
      return `[下载 ${event.current}/${event.total}] ${paperId(event)} ${status}${size}，耗时 ${duration(event.elapsedMs)}`;
    }
    case 'download-failed':
      return `[下载 ${event.current}/${event.total}] ${paperId(event)} 失败：${event.error}，耗时 ${duration(event.elapsedMs)}`;
    case 'download-skipped':
      return `[下载 ${event.current}/${event.total}] ${paperId(event)} 已跳过：${event.error}${event.replacementArxivId ? `，已由 ${event.replacementArxivId} 补位` : ''}`;
    case 'parse-start':
      return `[MinerU ${event.current}/${event.total}] ${event.baseId} / ${event.model} 开始（累计 ${duration(event.totalElapsedMs)}）`;
    case 'parse-complete': {
      const status = event.status === 'succeeded' ? '成功' : event.status === 'skipped' ? '跳过' : `失败（${event.status}）`;
      const cause = event.error ? `\n原因 [${event.errorClass ?? 'process_error'}]：${event.error}\n解析记录：${event.attemptId ?? 'unknown'}` : '';
      return `[MinerU ${event.current}/${event.total}] ${event.baseId} / ${event.model} ${status}，单篇耗时 ${duration(event.elapsedMs)}，累计耗时 ${duration(event.totalElapsedMs)}${cause}`;
    }
    case 'parse-failed':
      return `[MinerU ${event.current}/${event.total}] ${event.baseId} / ${event.model} 失败：${event.error}，单篇耗时 ${duration(event.elapsedMs)}`;
    case 'archive-complete':
      return `[Archive] 已生成 ${event.sourceCount ?? 0} 个来源，累计耗时 ${duration(event.totalElapsedMs)}`;
    case 'evidence-publish-start':
      return `[Evidence] 发布 ${event.sourceCount ?? 0} 个来源开始（累计 ${duration(event.totalElapsedMs)}）`;
    case 'evidence-publish-complete':
      return `[Evidence] 发布 ${event.publicationId ?? 'unknown'} ${event.replayed ? '重放完成' : '完成'}：${event.sourceCount ?? 0} 个来源，累计耗时 ${duration(event.totalElapsedMs)}`;
    case 'task-complete':
      return `[任务] ${event.status}，论文 ${event.paperCount ?? 0} 篇，总耗时 ${duration(event.totalElapsedMs)}`;
    case 'task-failed':
      return `[任务] ${event.failedPhase} 阶段失败：${event.error}，总耗时 ${duration(event.totalElapsedMs)}`;
    default:
      return null;
  }
}

export function createTerminalProgressReporter({ write = (text) => process.stderr.write(text) }: { write?: (text: string) => unknown } = {}): ProgressReporter {
  return (event) => {
    const line = formatProgressEvent(event);
    if (line) write(`${line}\n`);
  };
}
