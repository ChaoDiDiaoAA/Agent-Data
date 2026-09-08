# FSD scripts

FSD 的业务入口只有 `bun src/cli.ts`。运行时、网络传输、进程回收、任务计划和 OpenCLI adapter 均由 Bun/TypeScript 负责；本目录不再放置脚本外壳。

可用的 TypeScript 维护脚本：

- `build-opencli-adapter.ts`：在项目临时目录构建并校验 arXiv adapter。

进程安全记录位于 `state/locks/processes/active.json`。不要删除整个 `state/locks`；先执行：

```bun
bun src/runtime/process-supervisor.ts --inspect '<state_root>\\locks\\processes\\active.json'
bun src/runtime/process-supervisor.ts --resolve '<state_root>\\locks\\processes\\active.json'
```

只有 owner 已退出且检查结果为 `cleanupConfirmed: true` 时才允许 Resolve 单条记录。`tmp` 是临时工作区，但执行 MinerU 或 Evidence 恢复时不得清理。
