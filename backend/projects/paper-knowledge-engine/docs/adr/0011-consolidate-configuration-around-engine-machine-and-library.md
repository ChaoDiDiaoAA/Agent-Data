# 按引擎、机器与方向库合并配置

2026-09-05 更新：活动配置分为 `config/engine.yaml`、`config/machine.local.yaml` 和 `config/<libraryId>/`。方向目录内 `library.yaml` 管身份、日期、限额与调度，`query-matrix.yaml` 管检索，`paper-policy.yaml` 管筛选，`categories.yaml` 管 PDF 分类。共享运行行为属于引擎配置，本机绝对路径和 MinerU 安装位置属于机器配置。旧配置移至测试夹具，不保留多套活动配置来源；操作策略快照绑定全部六个活动文件。
