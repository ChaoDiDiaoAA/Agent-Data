# 保留精简且可重建的 Archive

Archive v2 将每篇论文版本压平为 `archive/<id>-vN`（2026-09-05 去掉无额外职责的 `papers/` 层），长期保存 `manifest.json`、`source.json`、`source.pdf`、`document.md`、`pages.json`、`content-list.json` 与 `assets/`。成功验收后不保留重复的 `origin.pdf`、可视化 `layout.pdf`/`span.pdf`、重复图片、MinerU 中间 JSON、`page-marked.txt` 或原始工作目录。失败诊断暂存 `work/diagnostics/` 并按生命周期清理；权威 PDF 与固定解析配置支持重新解析。Vault 的 `Evidence/papers/` 布局不随此调整改变。
