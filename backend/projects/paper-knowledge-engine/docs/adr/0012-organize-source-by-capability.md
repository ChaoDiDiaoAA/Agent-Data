# 按业务能力组织引擎源码

源码使用 `cli/`、`discovery/`、`library/`、`mineru/`、`evidence/`、`runtime/`、`maintenance/` 和 `shared/` 等能力目录。`src/cli.ts` 仅负责 Bun 入口和命令分派，知识库主线由 `library/` 编排；路径、Evidence 布局、配置和状态协议各自只有一个权威实现。避免为当前规模引入空洞的多层架构，也不继续把领域模块平铺在 `src/` 根目录。
