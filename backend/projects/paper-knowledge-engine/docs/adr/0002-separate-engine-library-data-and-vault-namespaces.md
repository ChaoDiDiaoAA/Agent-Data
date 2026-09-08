# 分离引擎、方向数据与 Vault 命名空间

共享代码项目使用稳定名称 `paper-knowledge-engine`，方向运行数据使用 `paper-libraries/<方向>`，Obsidian Vault 直接使用方向标识；当前方向标识为 `fsd`。这样引擎实现、方向状态和用户知识库可以独立演化，新增方向时无需复制或再次改名共享代码。
