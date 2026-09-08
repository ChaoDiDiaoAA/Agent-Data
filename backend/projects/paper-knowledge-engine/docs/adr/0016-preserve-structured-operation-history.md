# 保留完整的结构化任务历史

迁移保留 SQLite 中全部业务记录、`runs/`、`operations/` 和 Evidence publication receipts，包括成功、失败与可恢复任务。所有活动协议改用 `libraryId: fsd` 并重写新路径，不保留活动的 `projectId: fsd-code2doc` 字段。临时输出、重复 staging 和测试沙箱不属于历史记录，可在核验后删除。
