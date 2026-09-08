# arXiv OpenCLI adapter

本目录保存 FSD 自有 TypeScript adapter 和重试逻辑。在 FSD 项目根运行 `bun run opencli:prepare`，通过 Bun.build 生成 JavaScript discovery 文件；不要将 TS 复制到用户 `.opencli`。

生成目录从 paths 配置的 `temp_root` 派生：`opencli-home/.opencli/clis/arxiv/`。本包精确依赖 `@jackwener/opencli@1.8.6`；运行由 Bun 启动解析出的真实入口，不查全局 OpenCLI 或 Node。准备命令为 `bun run opencli:prepare`。

安装不执行网络采集。运行时仅给 OpenCLI 子进程设置隔离 HOME/USERPROFILE 与 CI=1；MinerU 不接收此 profile。锁、指纹和恢复限制见 [arxiv/README.md](arxiv/README.md)。正式安装已独立验证；全局 OpenCLI 不作为回退入口。
