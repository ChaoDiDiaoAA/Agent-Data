/** Render only a validated timestamp; upstream diagnostics must never reach this message. */
export function validArxivRetryTime(retryNotBefore: unknown): retryNotBefore is string {
  return typeof retryNotBefore === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(retryNotBefore)
    && Number.isFinite(Date.parse(retryNotBefore))
    && new Date(retryNotBefore).toISOString() === retryNotBefore;
}

export function arxivCooldownHint(retryNotBefore: unknown, noCooldown = false): string {
  if (noCooldown) return '未设置本地冷却，可手动重新执行同一方向、同一模式的任务，将恢复原 run 并跳过已完成分片；上游仍可能返回 429，请勿连续重试或删除检查点。';
  const time = validArxivRetryTime(retryNotBefore)
    ? new Date(Date.parse(retryNotBefore) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' 北京时间'
    : undefined;
  return (time ? `冷却至 ${time} 后可尝试恢复` : '冷却截止时间不可用，请稍后重试')
    + '；重新执行同一方向、同一模式的任务（当前任务选 2，周任务选 3），保持配置与限额不变，将恢复原 run 并跳过已完成分片。冷却结束不保证上游恢复，请勿连续重试或删除检查点。';
}
