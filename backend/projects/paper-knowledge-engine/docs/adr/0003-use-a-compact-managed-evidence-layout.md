# 使用紧凑的 Evidence 托管布局

每个方向库 Vault 使用无编号的 `Evidence` 托管根，论文版本压平为 `papers/<id>-vN`，每篇只发布合并后的 `paper.md`、页级 `pages.md`、`source.pdf` 与必要资源，作者、分类、Track 和年份各汇总为一个索引文件。机器 JSON 与逐篇 manifest 继续保留在权威解析 Archive 和运行状态中，但不再复制进 Obsidian，以缩短路径、减少文件数量并保持人工区与机器区的清晰边界。
