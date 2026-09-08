# Current-state evidence

## Production chain

当前调用链为 Bun CLI/worker → `executeOperation()` → `runConfiguredTask()` → OpenCLI arXiv adapter → 确定性筛选 → PDF 下载 → 固定 MinerU job manifest → `MineruApiSession.run()` → 原子 Archive → Archive 验证 → `01-Evidence` Obsidian 发布 → publication receipt。

关键证据：

- `src/cli.ts:124-178` 组装发现、下载、解析、Archive 验证与 Evidence 发布依赖。
- `src/opencli-runner.ts:168-171` 使用项目固定 OpenCLI 包与适配器。
- `opencli/arxiv/harvest.ts:124-199` 由适配器直接查询 arXiv Atom API。
- `src/pipeline.ts:203-301` 冻结选篇和解析清单，并在全部解析后发布。
- `src/mineru-local-jobs.ts:296-338` 预留 attempt、运行 MinerU、验证并原子发布 Archive。
- `src/evidence/render-paper.ts:144-166` 将完整 Markdown、资源、分页与结构化内容渲染到论文目录。

## Confirmed gaps

- `faccbcd` 的菜单级会话仍存在真实 readline EOF/信号无法可靠解除 pending read 的复审缺陷；新决策取消菜单所有权，以任务级所有权为准。
- `src/workflow.ts:179-180` 在业务成功但 dispose 失败后仍可能调用原始成功结果回调，使 CLI 同时输出成功 DTO 与失败状态。
- `MINERU_VIRTUAL_VRAM_SIZE` 当前只出现在每篇客户端环境中，而实际推理已移到 FastAPI 服务端；Batch Ratio 1 必须在服务端配置并通过真实日志验收。
- 三论文 A/B/C 中断恢复仅存在计划门槛，尚无完整验收证据。
- 真实双请求 MinerU smoke 尚未完成。

## Existing behavior to preserve

- Archive 中已有 `normalized/full.md`、`content_list.json`、分页文本、资源和哈希清单。
- 当前 Evidence 渲染将完整 Markdown 发布为每篇论文版本目录下的 `document.md`，并重写资源链接；该行为需要转为明确产品契约与端到端验收。
- OpenCLI 是执行框架和项目适配器边界；实际来源后端是 arXiv，不应描述成通用 OpenCLI 搜索后端。
