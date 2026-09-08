# 使用方向库标识而不是代码项目标识

任务、持久化 operation 和外部协议使用 `libraryId` 表示处理目标，当前值为 `fsd`；共享代码仓库名不再充当业务身份。迁移会重写旧 operation、run manifest 和 SQLite 路径，而不是在活动协议中永久保留 `fsd-code2doc` 兼容名称。
