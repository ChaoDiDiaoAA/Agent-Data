# 压平方向库的活跃数据布局

FSD 方向运行区使用 `D:/agent-data/data/paper-libraries/fsd`，其下直接放置 `library.sqlite`、`archive/`、`runs/`、`operations/` 和 `work/`。移除没有表达额外边界的 `state/` 包装层，将 `extracted/` 改为表达权威事实包语义的 `archive/`，将可回收临时内容统一归入 `work/`。备份不放在活跃方向运行区内，避免扫描、迁移和清理时把恢复副本误当成当前状态。
