# LLM Post-Training 首期真实试运行验收

## 结论

Task 5 **未完成，不满足进入下一阶段的条件**。

2026-09-08 的真实 current 试运行完成了 5 篇论文的发现、选择、下载、MinerU 解析、Archive v2 和 Evidence v3 发布；固定抽样的人工相关性审查为 31/36（86.1%），达到至少 20 篇且不低于 85% 的候选门槛。发布重放保持 265 个托管文件的集合与内容哈希不变。

阻塞项来自发布后的只读 `reconcile`：`2609.04336v1`（MedProb）的解析正文把提示模板中的 `[System]:` / `[User]:` 解释成 Markdown reference definitions，导致 `pages.md` 和 `paper.md` 各 2 个伪链接，共 4 个 broken links，`evidence.valid=false`。此外，5 篇试运行本身包含 1 篇明显词法误收的 MedProb。按本阶段约束，没有手工改写托管 Evidence，也没有修改生产 TypeScript/YAML 来掩盖该问题。

## 环境、版本与写入边界

- 记录时间：2026-09-08 11:50:48 +08:00；时区 `China Standard Time`（Asia/Shanghai）。
- OS：Microsoft Windows 10.0.26200；PowerShell 7.6.5；Bun 1.4.0；Node v24.19.0。
- `Get-CimInstance Win32_OperatingSystem` 在受管环境中返回“拒绝访问”；上面的 OS 版本由 .NET RuntimeInformation 只读取得。
- 引擎 commit：`e51a042bd2e8c1c86acf60464d440da4cd3223d2`（`docs: correct local import preview behavior`）。工作分支为 `codex/public-invoice-workbench`。
- 试运行前工作区已有无关修改：`../flowmate-data/README.md` 已修改，`../flowmate-data/docs/`、`.trellis/tasks/09-08-llm-post-training/`、`.trellis/workspace/--help/`、`.trellis/workspace/codex/` 未跟踪。本任务未修改或 stage 这些内容。
- 试运行前 `llm-post-training` 的 data、PDF、Vault 根都不存在；三个已有方向的对应根存在。试运行后检查各已有方向的递归最新写入时间：FSD data 11:52:49（早于本 run 11:53:14 开始），Agent Engineering 最晚为前一日 23:40，Multi-Agent Engineering 最晚为当日 10:58；三者 PDF/Vault 的最新时间也都早于本 run。未发现 cross-library write。
- 未创建任何 backup 根，没有注册 scheduler，没有训练模型、下载训练集/权重、执行论文仓库代码或调用 LLM。

路径派生如下；每个方向都使用稳定 ID 作为独立末级目录：

| 方向 | data | PDF | Vault | backup |
| --- | --- | --- | --- | --- |
| `fsd` | `D:\agent-data\data\paper-libraries\fsd` | `D:\paper\paper-knowledge-engine\fsd` | `D:\obsidian\data\paper-knowledge-engine\fsd` | `D:\agent-data\backups\paper-libraries\fsd` |
| `agent-engineering` | `D:\agent-data\data\paper-libraries\agent-engineering` | `D:\paper\paper-knowledge-engine\agent-engineering` | `D:\obsidian\data\paper-knowledge-engine\agent-engineering` | `D:\agent-data\backups\paper-libraries\agent-engineering` |
| `multi-agent-engineering` | `D:\agent-data\data\paper-libraries\multi-agent-engineering` | `D:\paper\paper-knowledge-engine\multi-agent-engineering` | `D:\obsidian\data\paper-knowledge-engine\multi-agent-engineering` | `D:\agent-data\backups\paper-libraries\multi-agent-engineering` |
| `llm-post-training` | `D:\agent-data\data\paper-libraries\llm-post-training` | `D:\paper\paper-knowledge-engine\llm-post-training` | `D:\obsidian\data\paper-knowledge-engine\llm-post-training` | `D:\agent-data\backups\paper-libraries\llm-post-training` |

新库 data 根内的长期隔离路径为 `library.sqlite`、`archive/`、`runs/`、`operations/`、`work/`；MinerU 模型锁为 `runs/mineru-model-lock.json`。本次没有活跃 `library.sqlite-wal` 或 `library.sqlite-shm` 后才开始只读抽样，未删除或绕过 WAL/SHM。

## 配置指纹与预检

试运行前与只读抽样时取得的四份 SHA-256 完全一致：

| 配置 | SHA-256 |
| --- | --- |
| `config/llm-post-training/library.yaml` | `2ec11244c33fcf18050b1961320aa265ebe33b66a8b4108ab69f7981b7436051` |
| `config/llm-post-training/query-matrix.yaml` | `8ce42d17fc4fb4d3a94ef52c062e09e5fffe68df2f6397cb1d0adc975270d015` |
| `config/llm-post-training/paper-policy.yaml` | `a898c87dd66f4bffdc1e97278b686a029ed2388c9c3889fa73e294ab0633273d` |
| `config/llm-post-training/categories.yaml` | `09826255be14b7df7b7fb70b19b3bd87f8d9adc2036cac8d9ae29be9e7e8aed0` |

`mineru-config --format json` 退出码 0：MinerU 3.4.5，预期 commit `4fe4bde114a23ee5dd637eae99b767f4669bf58c`，Python 3.12，模型 `pipeline`，method `auto`，`maxConcurrency=1`，`processingWindowSize=1`，公式与表格解析均启用，输出根是本库 `archive/`。本任务没有改全局并发、模型、代理或调度。

`harvest-plan --mode current --format json` 退出码 0：18 Track、36 分片（18 submitted + 18 updated）、最大 observation 7,200、Current 上限 180。

首次受限沙箱内执行 `arxiv-check --format json` 退出码 0，但结构化结果为 `status=unreachable, errorCode=ARXIV_TRANSPORT_UNAVAILABLE`。使用同一 `https://export.arxiv.org/api/query`、同一 `proxyMode=configured` 和机器配置中的 `http://127.0.0.1:7897` 获得联网权限后只重试一次，退出码 0 且 `status=reachable`。未切换主机或代理，也未发生 429。

## 真实 current 试运行

执行的命令只有：

```powershell
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
```

命令退出码 0，未使用不同 limit 恢复，也没有第二次 run。真实结果：

| 字段 | 结果 |
| --- | --- |
| runId | `1547fc18-a3e0-4808-9b9b-f7525cfffde2` |
| 状态 | `completed` |
| 窗口 | `2026-01-01T00:00:00.000Z` 至 `2026-09-08T03:53:14.623Z` |
| 开始/完成 | `2026-09-08T03:53:14.634Z` / `2026-09-08T04:14:58.576Z` |
| candidates | 2,766 个唯一候选（6,140 条 observations） |
| accepted | 2,498 个唯一候选 |
| newVersions | 5 |
| archived | 5 |
| published | 5 |
| selection | 5（配额 5，补位 0） |

36/36 分片都完成，没有 429、持久冷却、网络中断或 MinerU 失败。`selection-manifest.json` 存在并冻结 5 篇选择，SHA-256 为 `b336f72bc125588410700da5c0eb64aa684750bcc7bbbefee6ff9a979b555ce2`。首轮 selection 按 Track 为 foundations、SFT、data-curation、synthetic-data、reward-modeling 各 1；其余 13 Track 在 5 篇上限内没有入选，这只是小批量选择分布，不代表候选召回缺失。

## 候选抽样与人工相关性审查

完成 run 且本库停止写入后，用 Appendix B 逻辑通过 `openReadOnlyStateStore` 读取本 run 的 6,140 条 observations，按 baseId 合并最新版本与 Track，并以当前 policy 重算。脚本和输出都位于 `D:\agent-data\data\paper-libraries\llm-post-training\work\acceptance\`；执行前确认输出不存在，脚本以 `wx` 拒绝覆盖并拒绝非 completed run。

- 抽样脚本 SHA-256：`1787ec3e02cdeb8c3e15ab1900c4c4c33d45fa61a2df3319c6312c1a48061a61`。
- 原始抽样 JSON SHA-256：`fe8b00f1b73d967f5ce4a0326d8d634b8e487969739567219c47f33277da42d1`。
- 唯一 observed 2,766，规则通过 2,498，固定 `runId:baseId` 哈希排序后按 Track 轮询得到 36 个唯一样本。
- 人工结论：31 relevant、4 irrelevant、1 uncertain。`uncertain` 计入分母、不计入分子，相关率 `31/36 = 86.1%`；达到至少 20 篇且不低于 85% 的门槛。
- 36 个样本覆盖全部 18 Track；没有缺失 Track。该结论只衡量此固定样本的相关率，不声称检索召回率或主题完整覆盖。

每条判断都基于本 run 保存的真实 arXiv ID、source URL、题名和摘要；“主/交叉 Track”是语义审查结论，可能指出规则未标出的交叉主题。

| # | arXiv / source | 判断 | 主 / 交叉 Track | 理由与误收原因 |
| --- | --- | --- | --- | --- |
| 1 | [2606.11167v2](https://arxiv.org/abs/2606.11167v2) | relevant | foundations | 直接以 RL 对全双工语音模型做 post-training alignment。 |
| 2 | [2605.11632v3](https://arxiv.org/abs/2605.11632v3) | relevant | preference-optimization / SFT, stability | 用 DPO 构造并优化多语种反事实解释偏好，且与 SFT 对比。 |
| 3 | [2606.04284v1](https://arxiv.org/abs/2606.04284v1) | relevant | reward-modeling / data-curation, safety-alignment | 从二元偏好数据训练稀疏 MoE reward model，用于个性化 RLHF。 |
| 4 | [2605.13149v1](https://arxiv.org/abs/2605.13149v1) | relevant | synthetic-data / reward-modeling | 训练语言模型生成高价值合成训练数据，acquisition function 作为 reward。 |
| 5 | [2509.21842v2](https://arxiv.org/abs/2509.21842v2) | relevant | tool-agent / reward-modeling | 对工具型旅行 Agent 做端到端 RL，并设计层次化 verifier/reward。 |
| 6 | [2603.19294v6](https://arxiv.org/abs/2603.19294v6) | relevant | preference-optimization / foundations, stability | MIPO 构造正负偏好对并用 DPO 做无额外数据的 LLM 自提升。 |
| 7 | [2606.11119v2](https://arxiv.org/abs/2606.11119v2) | relevant | tool-agent / policy-optimization, verifiable-rewards | TRACE 为多轮 agentic RLVR 分配 rollout 预算，直接改善策略优化信号。 |
| 8 | [2607.02757v1](https://arxiv.org/abs/2607.02757v1) | relevant | multimodal / policy-optimization, verifiable-rewards, efficient-tuning | 对 audio-language model 使用 GRPO/RLVR 做 code-switched ASR 适配。 |
| 9 | [2511.07372v3](https://arxiv.org/abs/2511.07372v3) | relevant | reasoning | 研究 LLM reasoning curriculum post-training 的样本复杂度和 RL fine-tuning。 |
| 10 | [2608.00533v1](https://arxiv.org/abs/2608.00533v1) | relevant | distillation / foundations, policy-optimization | OSCD 在训练 rollout 中做跨语种 reasoning trajectory distillation。 |
| 11 | [2608.30952v1](https://arxiv.org/abs/2608.30952v1) | relevant | tool-agent | 监督 warm-up 后以可编程 outcome reward 训练化学工具调用策略。 |
| 12 | [2608.05949v1](https://arxiv.org/abs/2608.05949v1) | irrelevant | 无 / 规则命中 multimodal | 研究用现成 VLM 标注游戏帧奖励信号，没有对 VLM/LLM 做后训练；属于应用侧标注误收。 |
| 13 | [2505.18672v2](https://arxiv.org/abs/2505.18672v2) | relevant | safety-alignment | COCA 重构安全训练数据并验证 harmful concept intervention 的 jailbreak 鲁棒性。 |
| 14 | [2603.09892v1](https://arxiv.org/abs/2603.09892v1) | relevant | adaptation / stability | MSSR 为 continual LLM fine-tuning 自适应调度 replay，直接处理遗忘。 |
| 15 | [2606.29130v1](https://arxiv.org/abs/2606.29130v1) | relevant | efficient-tuning / distillation, SFT | QLoRA/SFT 教师生成轨迹，再做 response-level distillation；规则只标 efficient-tuning。 |
| 16 | [2510.09733v2](https://arxiv.org/abs/2510.09733v2) | relevant | training-systems / multimodal, policy-optimization | RS-GRPO 对视觉 RAG 的感知与推理阶段分配 reward，直接训练 VLM。 |
| 17 | [2603.02229v2](https://arxiv.org/abs/2603.02229v2) | relevant | safety-alignment / preference-optimization, stability | 用 DPO 比较 Agent safety/helpfulness 训练顺序及持久性。 |
| 18 | [2601.17480v1](https://arxiv.org/abs/2601.17480v1) | relevant | evaluation / safety-alignment | 系统评估 fine-tuned LLM 的 PII 记忆，并比较 DP、unlearning、regularization、preference alignment。 |
| 19 | [2609.00049v1](https://arxiv.org/abs/2609.00049v1) | irrelevant | 无 / 规则命中 foundations | `post-training quantization` 是部署量化，不是本库所指模型后训练；属于短语同名误收。 |
| 20 | [2608.03573v2](https://arxiv.org/abs/2608.03573v2) | relevant | policy-optimization / SFT | 直接比较多任务 SFT 与 RL 更新冲突，并提出 Parallel-RL。 |
| 21 | [2502.19312v2](https://arxiv.org/abs/2502.19312v2) | relevant | synthetic-data / data-curation, reward-modeling | 构造百万级合成个性化偏好并优化 few-shot reward modeling。 |
| 22 | [2507.12399v3](https://arxiv.org/abs/2507.12399v3) | irrelevant | 无 / 规则命中 synthetic-data | 仅研究 inference-time Best-of-N/rejection sampling 与 verifier ROC，不涉及模型后训练。 |
| 23 | [2603.08091v2](https://arxiv.org/abs/2603.08091v2) | relevant | reward-modeling / evaluation | JudgeBiasBench 评估 LLM judge 偏差，并以 RL/contrastive learning 做 bias-aware training。 |
| 24 | [2607.01239v1](https://arxiv.org/abs/2607.01239v1) | relevant | safety-alignment / preference-optimization, SFT | 系统测试 tokenization 安全缺口，并实际比较 DPO/SFT 修复。 |
| 25 | [2608.27046v1](https://arxiv.org/abs/2608.27046v1) | relevant | training-systems / policy-optimization, verifiable-rewards, distillation | 系统分析 RL-for-LLM 的并行/分布式训练架构和 PPO/GRPO。 |
| 26 | [2608.25358v1](https://arxiv.org/abs/2608.25358v1) | relevant | verifiable-rewards / evaluation, policy-optimization | 把结构/内容分解指标变为可验证 reward，并用 GRPO 训练 structured output。 |
| 27 | [2605.07660v1](https://arxiv.org/abs/2605.07660v1) | relevant | reasoning / stability | 研究 RL reasoning 的 token-level 学习信号并提出 entropy-aware 重加权。 |
| 28 | [2608.02689v1](https://arxiv.org/abs/2608.02689v1) | relevant | distillation / SFT, preference-optimization | 用 KL distillation、定向 SFT 与 on-policy DPO 修复线性注意力转换后的接口损伤。 |
| 29 | [2601.07376v2](https://arxiv.org/abs/2601.07376v2) | relevant | tool-agent / training-systems, efficient-tuning | OpenTinker 管理 Agent SFT/RL、LoRA 策略版本、rollout 与 checkpoint 生命周期。 |
| 30 | [2606.17246v1](https://arxiv.org/abs/2606.17246v1) | relevant | multimodal / tool-agent, SFT, policy-optimization | 对遥感多 Agent 进行 failure-aware SFT 和 contract-grounded RL。 |
| 31 | [2606.11082v1](https://arxiv.org/abs/2606.11082v1) | irrelevant | 无 / 规则命中 safety-alignment | 论文做跨语言行为审计；摘要仅在解释中提到 multilingual RLHF，没有提出或评估后训练方法。 |
| 32 | [2607.07719v1](https://arxiv.org/abs/2607.07719v1) | relevant | adaptation / efficient-tuning | ReCoLoRA 为 continual LLM fine-tuning 递归合并并重建低秩适配器。 |
| 33 | [2608.09834v1](https://arxiv.org/abs/2608.09834v1) | uncertain | efficient-tuning | 确实用 LoRA 适配 FinBERT，但对象是 encoder-only 金融情感分类器，是否属于本库“LLM 后训练”边界不够明确；按未决计入分母。 |
| 34 | [2606.21090v1](https://arxiv.org/abs/2606.21090v1) | relevant | stability / training-systems, policy-optimization | 实证研究 REINFORCE/GRPO 自训练中的 rise-and-collapse，并比较控制环和 early stop。 |
| 35 | [2608.02867v1](https://arxiv.org/abs/2608.02867v1) | relevant | stability / verifiable-rewards, reasoning | 研究 RLVR 后策略 entropy collapse 与语义分支收缩。 |
| 36 | [2601.15120v2](https://arxiv.org/abs/2601.15120v2) | relevant | tool-agent / evaluation, synthetic-data | 从真实工具调用生成虚拟正负轨迹，并两阶段 fine-tune Agent 做 intent alignment。 |

各 Track 的 observed / accepted 计数如下，均大于 0：

| Track | observed | accepted | Track | observed | accepted |
| --- | ---: | ---: | --- | ---: | ---: |
| pt-foundations | 274 | 269 | pt-sft | 296 | 250 |
| pt-data-curation | 204 | 203 | pt-synthetic-data | 115 | 106 |
| pt-reward-modeling | 267 | 263 | pt-preference-optimization | 258 | 257 |
| pt-policy-optimization | 272 | 271 | pt-verifiable-rewards | 242 | 239 |
| pt-reasoning | 97 | 83 | pt-distillation | 269 | 211 |
| pt-tool-agent | 238 | 227 | pt-multimodal | 255 | 244 |
| pt-safety-alignment | 272 | 248 | pt-adaptation | 25 | 23 |
| pt-efficient-tuning | 247 | 243 | pt-training-systems | 280 | 280 |
| pt-stability | 266 | 242 | pt-evaluation | 92 | 30 |

这些高规则通过率不能代替召回率测量；多个分片触及 200 条扫描上限，adaptation 只有 25 个唯一 observed，evaluation 只有 92 个，后续查询校准仍需保留真实分片差异。

## 5 篇阅读质量核对

每篇都逐项核对了 arXiv ID/version、PDF 目录、Archive `source.json` / `manifest.json`、正文、Evidence frontmatter 与四类 indexes。五份工作 PDF、Archive `source.pdf` 与 Vault Evidence `source.pdf` 的 SHA-256 对应一致，page count 也与 `pages.json` 一致。Track/year/category/author 索引均指向对应 `Evidence/papers/<baseId>-v1/paper`；没有重复论文目录。

| arXiv | selection / 人工相关性 | 页数 | PDF SHA-256 | 解析与链接结果 |
| --- | --- | ---: | --- | --- |
| `2609.05295v1` RISE | foundations / relevant | 28 | `d9ce6bd6239f73c13453d6f6df5ab9e6d066049f24f79f2ba35a7d069511d777` | 正文、22 组 display math、13 个 HTML table、40 个 image refs；索引存在。 |
| `2609.05189v1` FlexPension-LLM | SFT / relevant | 16 | `5ff685da4b1d3ae182d11ca7bc158715c4777f02ee25c64243f8ee1f11e82ec7` | 正文、8 组 display math、16 个 HTML table、12 个 image refs；索引存在。 |
| `2609.05043v1` EuroAlpaca | data-curation / relevant | 28 | `69e01d3118c891e2412fb24261647eef62e050d9cdc0d4dd32e694a7f0ddf1ab` | 正文、33 个 HTML table、6 个 image refs；索引存在。 |
| `2609.04336v1` MedProb | synthetic-data / **irrelevant** | 39 | `113a95c498e385aa584422fa1d452a7dfdc5d751262ff4e253d653cfa86106e1` | 正文、26 个 HTML table、28 个 image refs；规则因摘要末尾 `rejection sampling` 误收；托管正文产生 4 个 broken links。 |
| `2609.05401v1` ROBORMBENCH | reward-modeling / relevant | 20 | `8ce8c11c72980c0a260e6a42f637b5a034a23248ef31c4db9754eb9df56f4ead` | 正文、4 组 display math、13 个 HTML table、25 个 image refs；索引存在。 |

页级结构检查以源 PDF 为准，不能只看 Markdown 是否存在：

- **图片**：RISE 源 PDF 第 2 页 Figure 1 的 extrapolation geometry 和训练循环完整、清晰；截图 `work/acceptance/render/2609.05295-p02.png`，SHA-256 `a13c31cbaafde5735020adf012c5b7220b8767da69605f120815e7a87ba4e730`。MinerU 正文保留 Figure 1 caption 和图片引用。
- **公式**：RISE 源 PDF 第 5 页 Eq. (4)–(8) 字形、上下标和编号清晰；截图 `work/acceptance/render/2609.05295-p05.png`，SHA-256 `6edfa8c36973901348c32b740469f1a88d6dd82f95548f26117e09cc97d2a061`。MinerU 保留了 LaTeX 块和编号，但存在大量字符间插空，`π_future` 在一处变成类似 `f u u r r e`，范数/条件竖线也有转写不稳；语义尚可读，不能判为高保真公式复现。
- **表格与图**：RISE 源 PDF 第 9 页 Table 1 和 Figure 2 行列、加粗/下划线、曲线与图例清晰；截图 `work/acceptance/render/2609.05295-p09.png`，SHA-256 `1f0bd93e93ac51353ce336e58db94221fc853c95c5b87c26554854386a604f51`。MinerU 生成对应 HTML table 与图片引用，主要数值可读。
- 五篇首页均渲染并人工核对题名、作者、日期/版本标识；Poppler 对每份源 PDF 都报告 `Mismatch between font type and embedded font file` 语法警告，但 120 dpi 首页与上述 140 dpi 结构页未见裁切、黑块或不可读字形。

## Evidence 发布重放与只读一致性

首次发布：publicationId `evidence-3525848a894310b47102e389377c0585`，5 个来源。run 内 `publication.json` SHA-256 为 `58be1666ab75570ee78e3670544c56a077ff27214e3c325cce49bc5896c3311d`，`evidence/manifest.json` SHA-256 为 `4351cec3c643168a2ac6b1e9a20092831fc05c94b8d9ab047ffef27e4704ad4b`。

完成 runId 后执行：

```powershell
bun src/cli.ts --library llm-post-training evidence-publish --run-id 1547fc18-a3e0-4808-9b9b-f7525cfffde2 --format json
```

退出码 0，返回同一 publicationId、`sourceCount=5`、`replayed=true`。重放前后 Vault 托管文件均为 265 个，集合+相对路径+内容哈希+字节数的聚合 SHA-256 均为 `e358ae106bcb4a16d4d17358f8aaa54b854196466078ae780bada13def0aa953`；paper 目录恰为 5 个唯一 `baseId-v1`，没有重复或非预期覆盖，且没有创建/覆盖人工 `Knowledge/`。

随后执行只读：

```powershell
bun src/cli.ts --library llm-post-training reconcile --format json
```

命令退出码 0，但质量结果不是通过：`evidence.valid=false`、paperCount 5/expected 5、indexCount 4、missingAssets 0、archiveIssues 0、brokenLinks 4。四个问题都在 MedProb：

- `Evidence/papers/2609.04336-v1/pages.md`：target `You`（missing local destination）、target `Question:`（unsafe local destination）。
- `Evidence/papers/2609.04336-v1/paper.md`：同样两个 target。

来源是论文补充材料中的提示模板，例如 `paper.md` 第 585 行 `[System]: You will ...` 和第 591 行 `[User]:`；CommonMark 会把这种形状解释成 reference definition，而非普通角色标签。重放稳定地保留了该缺陷，因此幂等性通过不能抵消 Evidence 链接有效性失败。

`reconcile` 另将 5 篇全部列入 `rebuildNote`。本计划禁止调用 LLM 生成知识内容，Task 5 也不创建人工 Knowledge，因此本次没有执行 repair/rebuild，也没有把该列表伪装成已处理。

## 下一阶段条件

- 候选人工相关性门槛：**通过**（31/36，86.1%，全部 18 Track 有样本）。
- 真实 5 篇下载、版本、PDF/Archive/Vault 哈希链：**通过**。
- 公式/表格/图片页级覆盖：**完成**；公式 OCR 存在需保留的非阻塞缺陷。
- Evidence 重放幂等性：**通过**（265 文件集合和聚合哈希不变）。
- Evidence 可核查链接：**失败**（4 broken links，`evidence.valid=false`）。
- 5 篇 selection 主题纯度：**不足**（MedProb 是 rejection-sampling 相关-work/推理阶段词法误收，4/5 语义相关）。
- 对已有三个方向影响：**未发现写入**；所有实际新增/更新都位于 `llm-post-training` 隔离根。

因此 Task 5 保持未完成。下一轮应回到 Task 2/生产缺陷修复流程：为 `post-training quantization`、纯 test-time rejection sampling、应用侧 VLM 标注和仅讨论 RLHF 的审计论文增加回归样本并校准词表/查询；同时修复 Evidence 发布/链接校验对提示角色标签的误判。任何查询变化都必须产生新的真实查询批次，不能删除本次失败样本或覆盖本审查记录。

---

## Task 5 retry（2026-09-08，run `7e922ec5-b1ab-462d-ad70-d113b1089a86`）

本节追加于原试运行记录之后；上文旧 run `1547fc18-a3e0-4808-9b9b-f7525cfffde2` 的结论、失败样本和 Evidence 缺陷均保持原文。retry 的 36 篇抽样中 30 篇 relevant、5 篇 irrelevant、1 篇 uncertain，相关率为 **83.3%**，未达到 `>=85%` 的量化条件。新 run 的 5 篇均完成 PDF 下载、MinerU 解析、Archive 和 Evidence 发布；但只读 `reconcile` 发现 8 个图片断链，且边界论文 `2608.05949`（VLM annotation）仍被查询接纳。因此量化相关性、查询边界和 Evidence 三项分别构成阻塞，**Task 5 仍未通过，不进入 Task 6**。

### 写入前基线、配置与旧证据边界

基线记录时间为 `2026-09-08 14:26:17 +08:00`。系统为 Windows `10.0.26200`、PowerShell `7.6.5`、Bun `1.4.0`、Node `v24.19.0`。engine HEAD 为 `f564120b7f65a57161e82960323cbb66abe17aa2`（`feat(mineru): support standalone runtime paths`），分支 `codex/public-invoice-workbench`。写入前已有的并发工作区变化为 `../flowmate-data/src/engine-bridge.ts`、`src/runtime/process.ts`、`tests/config.test.ts` 以及 Flowmate/Trellis 未跟踪文件；本次均未修改、清理或纳入提交。

四个有效配置文件的写入前 SHA-256：

| 配置 | SHA-256 |
|---|---|
| `config/llm-post-training/library.yaml` | `2ec11244c33fcf18050b1961320aa265ebe33b66a8b4108ab69f7981b7436051` |
| `config/llm-post-training/query-matrix.yaml` | `6cce751ee5e11e4f3c17e24531b99ac8ba16a127bddbbc084a53921076db09af` |
| `config/llm-post-training/paper-policy.yaml` | `d38ab557b740baf6ef10ab744159597da59705dbc9505a3b46940f2bc191dfa1` |
| `config/llm-post-training/categories.yaml` | `09826255be14b7df7b7fb70b19b3bd87f8d9adc2036cac8d9ae29be9e7e8aed0` |

四库根目录均按 `config/machine.local.yaml` 解析：state 为 `D:\agent-data\data\paper-libraries\<library>`，PDF 为 `D:\paper\paper-knowledge-engine\<library>`，Vault 为 `D:\obsidian\data\paper-knowledge-engine\<library>`，backup 为 `D:\agent-data\backups\paper-libraries\<library>`；`fsd`、`agent-engineering`、`multi-agent-engineering`、`llm-post-training` 的前三类根存在，四个 backup 根均不存在。本次没有改动全局并发、代理、主机或 scheduler。

`mineru-config --format json` 退出码 0：MinerU `3.4.5`、commit `4fe4bde114a23ee5dd637eae99b767f4669bf58c`、Python `3.12`、pipeline backend、method `auto`、`maxConcurrency=1`、`processingWindowSize=1`、公式与表格开启、API `127.0.0.1:17860`。`harvest-plan --mode current --format json` 退出码 0，给出 18 Track、36 shards、最多 7200 observations/180 papers。配置态 `arxiv-check --format json` 首次即退出 0，`https://export.arxiv.org/api/query` reachable、proxyMode `configured`，未做许可重试，也没有 429。

旧 run 的 SQLite、manifest、PDF、Archive、Vault、receipt 与上文 acceptance 未覆盖或删除。旧 selection manifest SHA-256 为 `b336f72bc125588410700da5c0eb64aa684750bcc7bbbefee6ff9a979b555ce2`，Evidence manifest 为 `4351cec3c643168a2ac6b1e9a20092831fc05c94b8d9ab047ffef27e4704ad4b`，receipt 为 `58be1666ab75570ee78e3670544c56a077ff27214e3c325cce49bc5896c3311d`，publication ID 为 `evidence-3525848a894310b47102e389377c0585`。旧 5 篇 paper subtree 在 retry 发布前后均为 261 个文件，聚合 SHA-256 均为 `f0dcd791570c15239a163bd1cb9fa7effdc7a34b20f57ec3ece26908497877b7`。

### 唯一新批次及同 run 恢复

执行的真实命令为：

```powershell
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
```

首次调用创建唯一新 run `7e922ec5-b1ab-462d-ad70-d113b1089a86`，完成 36/36 discovery 后因沙箱内从 `.part` rename 到 `D:\paper` 报 `EPERM`；按 checkpoint 的 `canResume=true` 和批准的恢复方案，以完全相同命令恢复同一 run，没有创建第二个 run 或换 limit。首次扩展恢复下载 5/5 后，MinerU `17860` 被并发的 `multi-agent-engineering` job `9101fbd3-...` 占用，两次 parse attempt 留下失败记录。没有杀进程或更改端口；该外部 job 自行以 `invalid_artifact` 结束、PID 61812 退出且端口释放后，再以同一命令恢复同一 run，最终退出码 0。失败批次、checkpoint、manifest 与 `.part` 均未删除。

最终 run 状态为 `completed`，36/36 shards、5979 observations。固定 selection 的显式计数为 `requestedLimit=5`、`evaluatedCount=2751`（全局去重 candidates）、`acceptedCount=2481`、`selectedCount=5`；这四个值绑定于 selection manifest SHA-256 `4fe902f51ae7c4286e5e2631029a073d01f8d9392c7a71158f89a80ce1bcc2b9`。5 篇均为 new versions，5 PDF downloaded、5 parsed、5 archived、5 published。选择为：

| arXiv | 主 Track | 交叉 Track | 结果 |
|---|---|---|---|
| `2609.02849v2` | pt-foundations | pt-sft | new/downloaded/parsed/archived/published |
| `2609.04598v1` | pt-sft | — | new/downloaded/parsed/archived/published |
| `2606.07678v4` | pt-data-curation | pt-preference-optimization、pt-safety-alignment | new/downloaded/parsed/archived/published |
| `2607.27366v2` | pt-synthetic-data | pt-data-curation、pt-preference-optimization、pt-stability | new/downloaded/parsed/archived/published |
| `2609.04194v1` | pt-reward-modeling | — | new/downloaded/parsed/archived/published |

最终成功 parse attempt 依次为 `188770e2-ac2b-4b94-9f70-5a4d819ff2db`、`022863f9-560c-42e5-8a60-95b3c6ae0cd5`、`1e1171e1-d6c3-4bab-84f1-0998743013d2`、`c410f5f3-86b7-44e1-ac5a-19365a5f2244`、`fd6aa6bb-9887-4ac1-95ef-3d230fd7079e`。run 完成后 WAL/SHM 自然不存在；没有手工删除。

### Appendix B 抽样与逐项人工判断

使用 retry brief Appendix B 的只读 sampler（脚本 SHA-256 `1787ec3e02cdeb8c3e15ab1900c4c4c33d45fa61a2df3319c6312c1a48061a61`），输出到此前不存在且位于本库 work/acceptance 的 `review-7e922ec5-b1ab-462d-ad70-d113b1089a86.json`。命令退出 0；输出 SHA-256 为 `a86b73ecb2e4d996fcde15026d8964e8d3edf6ce09e2c920251d46404581ef94`。sampler 内嵌的四个配置 SHA-256 与本节写入前基线逐项完全相等：library `2ec11244c33fcf18050b1961320aa265ebe33b66a8b4108ab69f7981b7436051`、query-matrix `6cce751ee5e11e4f3c17e24531b99ac8ba16a127bddbbc084a53921076db09af`、paper-policy `d38ab557b740baf6ef10ab744159597da59705dbc9505a3b46940f2bc191dfa1`、categories `09826255be14b7df7b7fb70b19b3bd87f8d9adc2036cac8d9ae29be9e7e8aed0`。样本合并最新 version/Track，以固定 `runId:baseId` hash 和 Track 轮询生成，36 个 baseId 全局去重，覆盖全部 18 Track。primary Track 是该轮抽样所在桶；cross Track 是同一 observation 合并后的其它已批准 Track ID。人工判断读取保存的真实 arXiv metadata、abstract 与 source URL；uncertain 留在分母。

| # | arXiv / 标题 | primary Track | cross Track | 判断与理由 |
|---:|---|---|---|---|
| 1 | [2607.26515v1 HiFloat4](https://arxiv.org/abs/2607.26515v1) | pt-foundations | — | relevant：FP4 rollout 与训练端均参与 RL post-training，属于后训练量化边界内。 |
| 2 | [2607.25091v1 Robust RL for Small-Scale Agents](https://arxiv.org/abs/2607.25091v1) | pt-sft | pt-reward-modeling、pt-policy-optimization、pt-efficient-tuning | relevant：小模型 agent 的 PPO 对齐与稳定性。 |
| 3 | [2602.12180v1 How Sampling Shapes LLM Alignment](https://arxiv.org/abs/2602.12180v1) | pt-data-curation | — | relevant：分析 preference optimization 的采样与迭代训练动态。 |
| 4 | [2604.24544v1 STELLAR-E](https://arxiv.org/abs/2604.24544v1) | pt-synthetic-data | — | **irrelevant**：合成的是 LLM 应用评测数据，未训练或对齐模型；误收来自 synthetic/evaluator 词法。 |
| 5 | [2608.19802v1 Stopping and Routing LLM Judge Panels](https://arxiv.org/abs/2608.19802v1) | pt-reward-modeling | — | relevant：直接审计 judge/reward/verifier 组件的路由与停止。 |
| 6 | [2606.32032v1 RLMF](https://arxiv.org/abs/2606.32032v1) | pt-preference-optimization | pt-stability | relevant：以 metacognitive feedback 做 RL 对齐。 |
| 7 | [2505.15062v6 SAKE](https://arxiv.org/abs/2505.15062v6) | pt-policy-optimization | pt-training-systems | relevant：agent reasoning 的强化学习训练。 |
| 8 | [2607.28460v1 Cybersecurity Detection](https://arxiv.org/abs/2607.28460v1) | pt-verifiable-rewards | — | relevant：CoT classifier 的自训练与 RLVR。 |
| 9 | [2512.20908v2 Provenance in Reasoning Distillation](https://arxiv.org/abs/2512.20908v2) | pt-reasoning | — | relevant：以 teacher reasoning paths 训练 student。 |
| 10 | [2607.22720v2 CausalGate](https://arxiv.org/abs/2607.22720v2) | pt-distillation | — | **irrelevant**：摘要描述 adaptive inference/module pruning，只将结构重要性压缩进 scalar gates 以降低推理延迟；不转移 teacher response、trajectory 或 policy，也没有直接后训练贡献。 |
| 11 | [2606.10684v1 Divide and Cooperate](https://arxiv.org/abs/2606.10684v1) | pt-tool-agent | — | relevant：LoRA 与 cross-agent signals 的多 agent 训练。 |
| 12 | [2606.08708v1 PRPO](https://arxiv.org/abs/2606.08708v1) | pt-multimodal | — | relevant：LVLM 的 RLVR policy optimization。 |
| 13 | [2607.04645v1 RetroCoT](https://arxiv.org/abs/2607.04645v1) | pt-safety-alignment | — | relevant：直接审计 safety alignment 的跨代稳定性。 |
| 14 | [2607.01690v1 Epistemic Goggles](https://arxiv.org/abs/2607.01690v1) | pt-adaptation | pt-efficient-tuning | relevant：fine-tuning 期间以 gradient editing 修改 LoRA。 |
| 15 | [2607.28263v1 Understanding Is Done Early](https://arxiv.org/abs/2607.28263v1) | pt-efficient-tuning | pt-distillation | relevant：self-distillation LoRA 用于长上下文记忆。 |
| 16 | [2608.10812v2 Reference-Free Post-Training](https://arxiv.org/abs/2608.10812v2) | pt-training-systems | pt-foundations、pt-sft、pt-policy-optimization、pt-distillation | relevant：明确执行 SFT、RL 和 distillation 后训练。 |
| 17 | [2606.10860v1 Gravity-Weighted DPO](https://arxiv.org/abs/2606.10860v1) | pt-stability | pt-preference-optimization | relevant：用 GW-DPO 训练 instruction hierarchy。 |
| 18 | [2603.10473v1 Searcher Preferences](https://arxiv.org/abs/2603.10473v1) | pt-evaluation | — | relevant：SearchLLM 训练包含 reward system 与 GRPO。 |
| 19 | [2605.20555v1 Logit Averaging](https://arxiv.org/abs/2605.20555v1) | pt-foundations | — | relevant：将 GRPO 与 SFT logit averaging 结合。 |
| 20 | [2512.12066v3 Instability of Safety](https://arxiv.org/abs/2512.12066v3) | pt-sft | pt-safety-alignment | relevant：直接评测 post-trained refusal 的随机性与稳定性。 |
| 21 | [2505.23114v3 Alignment Data Map](https://arxiv.org/abs/2505.23114v3) | pt-data-curation | — | relevant：为 alignment training 选择 preference data。 |
| 22 | [2607.08034v1 PLURAL](https://arxiv.org/abs/2607.08034v1) | pt-synthetic-data | — | relevant：生成并使用 synthetic preference dataset 做 value alignment。 |
| 23 | [2606.16511v2 Tail-Shape Estimation](https://arxiv.org/abs/2606.16511v2) | pt-reward-modeling | — | relevant：直接审计 reward-model error 的评测协议。 |
| 24 | [2509.23982v2 Residual Model Steering](https://arxiv.org/abs/2509.23982v2) | pt-preference-optimization | pt-stability | **irrelevant**：training-free inference-time residual steering；误收来自 preference/alignment 词法。 |
| 25 | [2608.00782v1 Distill Where You Fail](https://arxiv.org/abs/2608.00782v1) | pt-policy-optimization | pt-sft、pt-verifiable-rewards、pt-distillation、pt-training-systems | relevant：RLVR negative groups 与 adaptive teacher distillation。 |
| 26 | [2601.22448v2 HeaPA](https://arxiv.org/abs/2601.22448v2) | pt-verifiable-rewards | — | relevant：RLVR prompt-pool sampling 与 on-policy augmentation。 |
| 27 | [2601.07036v2 Mid-Think](https://arxiv.org/abs/2601.07036v2) | pt-reasoning | — | relevant：虽以 training-free trigger 为主，也将机制用于 SFT 后 RL 并报告训练增益。 |
| 28 | [2608.30258v1 Stratified Consistency Distillation](https://arxiv.org/abs/2608.30258v1) | pt-distillation | — | relevant：以 teacher pseudo-labels fine-tune student。 |
| 29 | [2605.28699v1 TRACER](https://arxiv.org/abs/2605.28699v1) | pt-tool-agent | — | relevant：cooperative multi-LLM 的 turn-level RL。 |
| 30 | [2605.26761v2 Once-For-All](https://arxiv.org/abs/2605.26761v2) | pt-multimodal | — | relevant：multimodal instruction-tuning 数据选择。 |
| 31 | [2509.19212v2 SafeCoDe](https://arxiv.org/abs/2509.19212v2) | pt-safety-alignment | — | **irrelevant**：仅 inference-time contrastive decoding，不做模型后训练；误收来自 safety/steering。 |
| 32 | [2603.12658v2 Beyond Static Models](https://arxiv.org/abs/2603.12658v2) | pt-adaptation | — | relevant：continual fine-tuning/alignment 综述。 |
| 33 | [2607.17952v2 Source Shift](https://arxiv.org/abs/2607.17952v2) | pt-efficient-tuning | — | relevant：跨 source 比较并评测多种 LLM adaptation 策略（含 LoRA），直接研究后训练适配在 source shift 下的迁移行为，而非仅做单一应用微调。 |
| 34 | [2609.00367v1 Neurosymbolics for Data Engineering](https://arxiv.org/abs/2609.00367v1) | pt-training-systems | — | **irrelevant**：明确为 finetuning-free inference layer；误收来自 token reduction/system 词法。 |
| 35 | [2606.26387v1 Staying VIGILant](https://arxiv.org/abs/2606.26387v1) | pt-stability | pt-data-curation、pt-preference-optimization | relevant：VLM 的 preference/RL post-training。 |
| 36 | [2608.12831v2 Fast A/B/n Testing](https://arxiv.org/abs/2608.12831v2) | pt-evaluation | pt-reward-modeling | **uncertain**：通用 bandit 多策略比较方法，LLM/reward evaluation 只是应用之一；计入分母。 |

边界专项查询结果：MedProb `2609.04336`、test-time rejection `2507.12399`、部署量化 REAL-Q `2609.00049`、仅讨论 RLHF 的 Shibboleth `2606.11082` 在新 observations 中均不存在；VLM annotation `2608.05949` 仍出现 2 次并被接纳，是未修复的语义边界；RA-FinBERT `2608.09834` 也出现 2 次并被接纳，保留为应用侧高风险边界。失败样本没有从分母或 SQLite 中删除。

### 5 篇 source/PDF/Archive/Vault 质量核验

逐篇核对 selection source/version、工作 PDF、Archive manifest/document/assets、Evidence body/frontmatter 和四个索引。三个位置的 PDF 内容哈希均与 manifest 一致：

| arXiv | PDF bytes / pages / SHA-256 | Archive 文档信号 | frontmatter 与 index |
|---|---|---|---|
| `2609.02849v2` | 696014 / 21 / `928e37df7f1dec171eb73aa42a15a22c5fda8928bb0c2dabefa7f1ac07a199e3` | 59606 bytes；6 display math、6 tables、11 images | base/version/hash 一致；author/category/track/year 均命中 |
| `2609.04598v1` | 4695496 / 28 / `98dd224db08d66ff22521b34e6bc37fd49887fa452bb1461a62807c0cec71c12` | 108550；12/17/17 | 同上 |
| `2606.07678v4` | 1961567 / 19 / `aa6ca5f34b7f08603803cf0143c1c2c83b66b375c0e7c9a1a5a3e6fb3e8affae` | 83076；36/11/10 | 同上 |
| `2607.27366v2` | 4005298 / 26 / `0b49cf84b900b2d4e39d9d92de17ea74dbf3ecd52d00cfa270da9cceb452e7a3` | 92132；12/13/19 | 同上 |
| `2609.04194v1` | 1189722 / 44 / `02c6f745f27b832a81cf42822c30e24e568e46b16f1044757bf0c010d160c22c` | 124380；36/1/42 | 同上 |

对 DOG-DPO `2606.07678v4` 做源 PDF 页级人工检查：第 3 页公式 Eq. 3–9 在源 PDF 清晰，MinerU 保留公式但将若干运算符 OCR 为分隔字符（如 `m a x`、`d e t`）；第 5 页 Figure 1 清晰且图片/图注存在，图注出现 `sdataset-specific` 与 `anchor` 过度分字；第 7 页 Table 1/2 在源 PDF 清晰，MinerU HTML 大部分数值存在，但 Tier/method 行错位（KMeans 落入 T1、SDPO 行标签缺失、`SDPO Whole` 合并），LLaMA 表头前多出 `8`。这些是明确 MinerU 缺陷，不能用 Markdown 存在替代质量证明；源 PDF 本身可读并被保留。

### Evidence receipt、重放与只读 reconcile

首次发布得到 publication ID `evidence-2e9775d5e9a046900e3dbb068c7163c1`，input SHA-256 `0383c875fbabb5a4805c1b59f5aac73c47fd2049ee5f0391a7a334ca5f291cba`，receipt SHA-256 `514270ec01f26f7e5787d80676232e3f5c7f567ef320f2685f3c3f21b46ec71b`，receipt 累计列出新旧 10 个 sources。随后以同一 runId 执行：

```powershell
bun src/cli.ts --library llm-post-training evidence-publish --run-id 7e922ec5-b1ab-462d-ad70-d113b1089a86 --format json
```

退出码 0，返回同一 publication ID、`sourceCount=10`、`replayed=true`。重放前后 managed set 均为 478 files/10 个唯一 paper dirs，按相对路径、bytes 与逐文件 SHA-256 聚合的 SHA-256 均为 `4dfb7def5dbf5c3689d8d5dce8982961403306104d3cdb85a3082eb9598f763d`；旧 5 篇 subtree 哈希也保持不变。没有 `Knowledge/`，也没有跨库写入。

只读 `bun src/cli.ts --library llm-post-training reconcile --format json` 退出码 0，但结果为 `evidence.valid=false`、paperCount 10/expected 10、indexCount 4、missingAssets 0、archiveIssues 0、duplicatePdfs 0、missingPdf 0、retryParse 0、retryWiki 0、brokenLinks **8**。全部断链来自 `Evidence/papers/2607.27366-v2/paper.md` 第 146–197 行：正文写成 `images/<sha>.jpg`，实际对应文件存在于 `assets/images/<sha>.jpg`。进一步只读定位表明 BridgeAlign Archive `document.md` 的未转义反引号使 Markdown 资源扫描将后续大片内容误判为 code span，因而漏做这些 `images/*` 的资产路径重写；这是后续独立生产修复项。`rebuildNote` 列出 10 篇。本计划禁止 LLM repair/rebuild、手改 Evidence 或临时修改生产解析器，因此保留该失败证据。

### retry gate

- 人工相关性：30/36 = 83.3%，量化门槛失败；CausalGate 属于推理期模块剪枝，VLM annotation 边界也仍误收。
- 5 篇 source/version/PDF/Archive/body/frontmatter/index：逐篇核对完成；PDF 哈希链通过，MinerU 表格/OCR 缺陷已记录。
- Evidence replay：文件集合与哈希完全稳定，幂等性通过。
- Evidence reconcile：`evidence.valid=false`，8 broken links，失败。
- 隔离性：old managed set 未变，没有 Knowledge 或其它三库写入。

focused 验证命令 `bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/evidence-publisher.test.ts tests/evidence-layout-v3.test.ts tests/vault-validator.test.ts tests/archive-v2.test.ts` 退出码 0（186 pass、0 fail）；`bun run typecheck` 退出码 0；`git diff --check` 退出码 0。diff 仅在旧 acceptance 原文之后追加本 retry 节；提交范围仅为本文件。并发出现的 Flowmate/Trellis 变化未纳入。

因此 Task 5 retry 仍为 **未通过**。进入 Task 6 的前提是：修正并回归 VLM annotation/应用侧调优边界；修复发布正文图片相对路径并在新的只读 reconcile 中得到 `evidence.valid=true`、0 broken/missing/archive issues；保持本次失败 run、样本与 acceptance 可追溯。

---

## Task 5 fresh trial（2026-09-08，run `64dc5e84-3b88-4b17-a611-6a57ad441692`）

本节记录 Remediation C/D 之后唯一一次新的真实试运行。前两个失败批次、selection、publication receipt 和 acceptance 原文均保留；本节没有覆盖旧段落。当前策略已经包含 `video game` / `videogame` 窄排除，Evidence 代码已经包含 escaped-backtick 与 `assets/<raw>` 修复。

### 写入前基线、配置与隔离

写入前 engine HEAD 为 `9950d7968bf5eebf26513c3a61b597944247e0bb`，Bun `1.4.0`。工作区已有并发 `../flowmate-data/src/backup.ts` 修改以及 `.trellis/tasks/09-08-llm-post-training/`、`.trellis/workspace/--help/`、`.trellis/workspace/codex/` 未跟踪项；均未修改、清理或纳入本提交。四份当前配置 SHA-256 为：

| 配置 | SHA-256 |
|---|---|
| `config/llm-post-training/library.yaml` | `2ec11244c33fcf18050b1961320aa265ebe33b66a8b4108ab69f7981b7436051` |
| `config/llm-post-training/query-matrix.yaml` | `6cce751ee5e11e4f3c17e24531b99ac8ba16a127bddbbc084a53921076db09af` |
| `config/llm-post-training/paper-policy.yaml` | `ba2803f3be76e8f9ae815837ab2b2d8d200f8ed8c6baa019f2eb14997d05870f` |
| `config/llm-post-training/categories.yaml` | `09826255be14b7df7b7fb70b19b3bd87f8d9adc2036cac8d9ae29be9e7e8aed0` |

`mineru-config --format json` 退出码 0：MinerU `3.4.5`、commit `4fe4bde114a23ee5dd637eae99b767f4669bf58c`、Python `3.12`、pipeline/auto、并发与窗口均为 1、公式和表格开启、API `127.0.0.1:17860`。`harvest-plan --mode current --format json` 退出码 0：18 Track、36 shards、7200 observation 上限、Current 上限 180。配置未改变。`arxiv-check --format json` 退出码 0，`https://export.arxiv.org/api/query` 在 configured proxy 下可达。开始前没有 WAL/SHM。

四库隔离根仍由 `config/machine.local.yaml` 派生：`D:\agent-data\data\paper-libraries\<library>`、`D:\paper\paper-knowledge-engine\<library>`、`D:\obsidian\data\paper-knowledge-engine\<library>` 和 `D:\agent-data\backups\paper-libraries\<library>`。四个方向的 state/PDF/Vault 根均存在，backup 根均未创建；本次新写入仅落在 `llm-post-training`。没有创建 `Knowledge/`、scheduler、模型训练或数据集/权重下载。

### 唯一真实 run 与失败恢复

只启动了以下唯一的 discovery/selection run：

```powershell
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
```

首次在下载第一篇 `2609.03887v1` 时发生 `EPERM`：从 `D:\agent-data\data\paper-libraries\llm-post-training\work\2609.03887-v1.part` rename 到隔离 PDF 根失败。该命令已经完成 36/36 discovery 并固定选择；随后按 `canResume=true` 使用同一命令、同一 run/config 做了唯一一次受限恢复，没有改 host、proxy、port、limit 或全局配置。恢复后五篇下载、五篇 MinerU 解析、五篇 Archive v2 均完成。

| 字段 | 结果 |
|---|---|
| runId | `64dc5e84-3b88-4b17-a611-6a57ad441692` |
| 窗口 | `2026-01-01T00:00:00.000Z` 至 `2026-09-08T09:51:02.400Z` |
| 状态 | `failed`，stage `evidence-publish`，`canResume=true` |
| observations / unique | 5,979 / 2,751 |
| requested / evaluated | 5 / 2,751 |
| accepted / existing / new candidates | 2,477 / 9 / 2,468 |
| selected / downloaded / parsed / archived | 5 / 5 / 5 / 5 |
| published | 0；发布在 immutable-history 校验前失败 |
| selection manifest SHA-256 | `7b00a215d5d68846cb6e6eac5250a7d770d124cacc04ebef5e2f8c19d1e8c7e7` |

五篇固定选择如下，主/交叉 Track 使用批准的 Track ID：

| arXiv | 主 Track | 交叉 Track | 选择结果 |
|---|---|---|---|
| `2609.03887v1` | `pt-foundations` | `pt-preference-optimization`, `pt-sft`, `pt-stability` | new / downloaded / parsed / archived |
| `2609.04108v2` | `pt-sft` | `pt-distillation`, `pt-verifiable-rewards` | new / downloaded / parsed / archived |
| `2511.08590v2` | `pt-data-curation` | — | new / downloaded / parsed / archived |
| `2608.11604v1` | `pt-synthetic-data` | — | new / downloaded / parsed / archived |
| `2609.03342v1` | `pt-reward-modeling` | `pt-policy-optimization`, `pt-training-systems`, `pt-verifiable-rewards` | new / downloaded / parsed / archived |

自动发布失败的原始错误为：

```text
EVIDENCE_RECEIPT_CONFLICT: completed publication Evidence manifest identity differs: 7e922ec5-b1ab-462d-ad70-d113b1089a86
```

恢复后的集成发布 job `e09f2d64-1dfc-49ac-bec1-7f47b14f2111` 记录了该错误；随后只按要求对同一 run 执行了一次独立的 `evidence-publish --run-id 64dc5e84-3b88-4b17-a611-6a57ad441692 --format json`，job `4da72097-0481-4ab0-ae83-fc214dba2bd3` 在同一阶段失败。没有新 publication ID，没有新 receipt，没有修改旧 run `7e922ec5...` 的 receipt/DB/Vault，也没有继续重试。

### 只读抽样、人工选择审查与边界

Appendix B sampler 在确认 WAL/SHM 已关闭后读取本 run，但按设计拒绝不完整 run：`AssertionError: sample only a completed run`（实际状态 `failed`）。因此此前不存在的 `D:\agent-data\data\paper-libraries\llm-post-training\work\acceptance\review-64dc5e84-3b88-4b17-a611-6a57ad441692.json` 没有被创建或覆盖；等价 sampler 脚本 SHA-256 为 `1a8a57c7e297f3fe1263a8be94e18860262e63a66adf6e946851ab76b3afb0e0`。没有绕过状态写出 36 条样本，也没有虚构 sampler 与预运行 hash 的等值证据；本节列出的四份当前 hash 是唯一可核验的配置基线。

作为有限的 selection audit，人工读取新 run 的真实 arXiv metadata、abstract、source URL 与 PDF，审查了 5 条固定选择：4 relevant、1 irrelevant、0 uncertain，比例 `4/5 = 80.0%`，分母少于 20，不能宣称相关性门槛通过或召回率。逐行记录如下：

| arXiv / source | 判断 | 主 / 交叉 Track | 理由与误收原因 |
|---|---|---|---|
| [2609.03887v1](https://arxiv.org/abs/2609.03887v1) | relevant | `pt-foundations` / `pt-preference-optimization`, `pt-sft`, `pt-stability` | 直接比较 SFT、reasoning-augmented SFT 和 ORPO 对安全拒答的后训练影响。 |
| [2609.04108v2](https://arxiv.org/abs/2609.04108v2) | relevant | `pt-sft` / `pt-distillation`, `pt-verifiable-rewards` | 直接研究 on-policy distillation 与 RLVR 的后训练阶段组合。 |
| [2511.08590v2](https://arxiv.org/abs/2511.08590v2) | irrelevant | `pt-data-curation` / — | GMTRouter 是 LLM 路由与用户偏好推断，摘要强调不需大量 fine-tuning；没有直接后训练贡献，属于 LLM、sampling 等宽词误收。 |
| [2608.11604v1](https://arxiv.org/abs/2608.11604v1) | relevant | `pt-synthetic-data` / — | LOFA 把在线反馈转成 token-level distillation 与可验证购买结果 RL，明确训练 shopping agent。 |
| [2609.03342v1](https://arxiv.org/abs/2609.03342v1) | relevant | `pt-reward-modeling` / `pt-policy-optimization`, `pt-training-systems`, `pt-verifiable-rewards` | GAR 在 RLVR 中用 gradient-aligned reward 产生稠密训练信号，直接属于奖励/策略后训练。 |

边界复核基于本 run 的 5,979 条 observation（VLM 和 RA-FinBERT 各观察到 2 次）：

| 边界 | 当前结果 |
|---|---|
| `2608.05949v1` VLM videogame annotation | observed 2；当前策略 `accepted=false`、`excluded=true`、无 eligible Track，Remediation D 校准生效 |
| `2609.04336v1` MedProb | 未观察到 |
| `2609.00049v1` deployment post-training quantization | 未观察到 |
| `2507.12399v3` pure test-time rejection sampling | 未观察到 |
| `2606.11082v1` RLHF-only audit | 未观察到 |
| `2608.09834v1` RA-FinBERT | observed 2；当前 lexical policy 仍保留为高风险 encoder-only/LoRA 边界，未从历史问题中删除 |

### 五篇 PDF/Archive 质量核验

五篇 source metadata 的 arXiv ID/version、作者、分类和时间与 selection manifest 一致；工作 PDF、Archive `source.json`、`manifest.json`、`document.md`、`pages.json` 与 `assets/` 均存在，且 manifest 中的 `source.pdf` 哈希与下载文件一致。代表性结构统计如下：

| arXiv | PDF bytes / pages / SHA-256 | Archive document / images | 结构页与人工检查 |
|---|---:|---:|---|
| `2609.03887v1` | 995542 / 27 / `5e3a049b2736c377cdaee68e541519663d56b667076ab150c08c432d0e05b726` | 94984 / 48 | 源 PDF 第 3 页公式、第 4 页表格、第 1 页 Figure 1 均清晰；MinerU 页级文本保留公式/表格/图注。 |
| `2609.04108v2` | 736372 / 19 / `3cd1e8d799cfce7d006b82d3138eb21f64c111198cad26381ca1b1e607678fdd` | 78557 / 34 | 第 3 页公式和 Table 1 均可读；公式页结构被保留。 |
| `2511.08590v2` | 1341633 / 23 / `8214ded01888a7a4649e44b308daa11dc6e733bc64e6ed28b10ea57af6342e37` | 93082 / 31 | 第 5 页公式可读；正文包含表格页，但该篇被人工判为路由应用误收。 |
| `2608.11604v1` | 1004474 / 15 / `777f8a6ec759ea58cc91122222679c877e48be516d6a84db18586f2607b12d48` | 58959 / 20 | 第 8 页 Table 1–3 数值与布局可读；正文保留图表结构。 |
| `2609.03342v1` | 1693708 / 21 / `6b0f3afd6d67ef582d906af8c25d9d14a93cfc2a768e81308a3ddbdf07b760b4` | 108999 / 35 | 第 6 页 Table 2 结构和数值可读；正文保留公式与图表引用。 |

结构页渲染文件写在本库 `tmp/llm-post-training-quality/`，没有纳入提交：`2609.03887v1` 的 formula/table/figure 页分别为 p3/p4/p1，`2609.04108v2` formula p3，`2511.08590v2` formula p5，`2608.11604v1` table p8，`2609.03342v1` table p6。源 PDF 页面没有裁切或不可读字形；这些截图只证明源 PDF 可读，不把 Markdown 存在当作解析正确证明。

由于 Evidence publication 未完成，五篇新 paper 的 Vault `Evidence/papers/<baseId>-v<version>/paper.md`、`pages.md`、`source.pdf` 和 frontmatter/index 不能被声称已发布；只读检查确认这五个新 Evidence 目录均不存在。这是本次质量链和阶段门禁的直接阻塞。

### Evidence 与 reconcile

现有两个历史 completed publication 仍保持原身份：旧 publication `evidence-3525848a894310b47102e389377c0585` 的 receipt SHA-256 为 `58be1666ab75570ee78e3670544c56a077ff27214e3c325cce49bc5896c3311d`；retry publication `evidence-2e9775d5e9a046900e3dbb068c7163c1` 的 receipt SHA-256 为 `514270ec01f26f7e5787d80676232e3f5c7f567ef320f2685f3c3f21b46ec71b`。新 run 不存在 `runs/64dc5e84-3b88-4b17-a611-6a57ad441692/evidence/publication.json`，没有新 receipt 可比较，也没有编辑旧 receipt/DB/Vault。

发布失败后只读 `reconcile` 退出码为 0，但结果为：`evidence.valid=false`、`paperCount=10`、`expectedPaperCount=15`、`indexCount=4`、`brokenLinks=8`、`missingAssets=168`；`archiveIssues=[]`、`missingPdf=[]`、`duplicatePdfs=[]`、`retryParse=[]`、`retryWiki=[]`。10 个历史 Evidence 纸目录仍在，5 个本 run 纸目录尚未进入托管投影；BridgeAlign 历史断链和当前 renderer 变更导致的 completed-history identity conflict 均未通过手工修复。没有重复论文、非预期覆盖或跨库写入。

### fresh-trial gate

- discovery/selection、下载、MinerU 解析和 Archive：已完成，run 计数和 manifest 可核验。
- sampler/人工相关性门槛：**失败**；run 状态为 `failed`，Appendix B 拒绝输出，只有 5 条 selection audit（4/5，分母不足）。
- VLM application-side annotation：**已校准**，`2608.05949v1` 被排除；其他边界结果已保留。
- source/PDF/Archive：五篇完成且哈希链通过；Vault body/frontmatter/index：**未发布**。
- Evidence publication：**失败**，旧完成回执在修复 renderer 后的历史 manifest 认证冲突；新 run 无 publication/receipt。
- reconcile：**失败**，`evidence.valid=false`，8 broken links、168 missing assets、10/15 paper projection。
- 隔离性：**通过**，没有 `Knowledge/`、scheduler 或其它三个方向的写入。

因此本 fresh trial 的 Task 5 gate **未通过**，Task 6 继续阻塞。下一步必须在不改旧 immutable receipt/DB/Vault 的前提下，提供支持新 renderer 的历史 publication 迁移/基线处理，随后以新的完整 run 重新获得不少于 20 条、相关率至少 85% 的 sampler 样本，并让新的 Evidence reconcile 达到 `valid=true` 且 zero broken/missing/archive issues。

## Task 5 最终补救与验收（2026-09-08）

### 结论

Remediation E 已完成，Task 5 最终门禁通过，可以进入下一阶段。之前的三次失败记录、失败样本和 immutable receipt 均保留；本节记录的是在同一 `llm-post-training` 库上的补救结果。

补救包含两部分：新增 `evidence-v3-renderer-upgrade-baseline`，把两次既有 V3 publication 的原始 receipt、Archive 身份和新 renderer projection 绑定在一个 hash-pinned baseline 中；同时修复历史校验按 publication 顺序逐 run 建立前缀，禁止用后续 run 的 Archive source 回填早期 publication。对应实现提交为 `67c5a29` 和 `f443eb0`；独立复核没有 P0–P3 问题，聚焦测试 276 项通过。

### 补救 run、抽样与边界

只恢复原失败 run `64dc5e84-3b88-4b17-a611-6a57ad441692` 的发布阶段，没有重新发现、换 limit 或创建第二个 run。最终 run 状态为 `completed`，36/36 shards 完成，5,979 条 observations、2,751 个唯一候选、2,477 个规则通过候选；selection manifest 的 `requestedLimit=5`、`evaluatedCount=2751`、`acceptedCount=2477`、`selectedCount=5`，SHA-256 为 `7b00a215d5d68846cb6e6eac5250a7d770d124cacc04ebef5e2f8c19d1e8c7e7`。5 篇均完成 downloaded、MinerU parsed、Archive 和 Evidence 发布：

| arXiv | 主 Track | 交叉 Track | 结果 |
|---|---|---|---|
| `2609.03887v1` | `pt-foundations` | `pt-preference-optimization`, `pt-sft`, `pt-stability` | published |
| `2609.04108v2` | `pt-sft` | `pt-distillation`, `pt-verifiable-rewards` | published |
| `2511.08590v2` | `pt-data-curation` | — | published；人工判为路由应用边界误收 |
| `2608.11604v1` | `pt-synthetic-data` | — | published |
| `2609.03342v1` | `pt-reward-modeling` | `pt-policy-optimization`, `pt-training-systems`, `pt-verifiable-rewards` | published |

Appendix B sampler 脚本 SHA-256 为 `1787ec3e02cdeb8c3e15ab1900c4c4c33d45fa61a2df3319c6312c1a48061a61`；输出为此前不存在的 [review-64dc5e84-3b88-4b17-a611-6a57ad441692-post-baseline.json](D:/agent-data/data/paper-libraries/llm-post-training/work/acceptance/review-64dc5e84-3b88-4b17-a611-6a57ad441692-post-baseline.json)，SHA-256 为 `d4aed8e03600841e5e0e06700fd8efd4de100514d768f5de75359a8d8c68e897`。固定 `runId:baseId` 排序、按 Track 轮询得到 36 个唯一样本，覆盖全部 18 Track；每条保存了 arXiv version、标题、摘要、source URL、判断和理由。人工结果为 **31 relevant、5 irrelevant、0 uncertain，31/36 = 86.1%**，满足至少 20 篇且不低于 85% 的门槛。

5 条 irrelevant 为：`2608.26152`（认知轨迹预测，SFT 是 semantic fluency task）、`2503.05383`（StarCraft MARL/VLM benchmark，语言模型部分 zero-shot）、`2607.27421`（zero-shot 模型选择）、`2607.22720`（推理期模块剪枝）、`2608.18628`（安全对齐内部分析且明确不 retrain）。其余 31 条都在标题/摘要中提供了后训练方法、训练数据、奖励/验证器、训练系统或后训练评测的直接贡献；`2208.05545` 作为 alignment 评测数据并包含 PEFT/fine-tuned LLM 设置，按评测资源边界计入 relevant。

当前 run 的边界检查保留历史事实：`2608.05949` 仍有 2 条 observation 但已由 Remediation D 以 `excluded=true` 排除；`2609.04336`、`2609.00049`、`2507.12399`、`2606.11082` 在本 run 中没有 observation；`2608.09834` 有 2 条 observation，保留为 encoder-only/LoRA 的高风险边界。旧的误收论文和失败 receipt 没有从 SQLite 或样本分母删除。

### Vault 重建、baseline 与发布一致性

发布前把旧 live Vault 可恢复地移到 `D:\obsidian\data\paper-knowledge-engine\llm-post-training-pre-render-upgrade-20260908T2014`。备份快照为 478 个文件、61,390,617 bytes，树 SHA-256 `afebb0903505bf5ec42c10069dc4acb0571b4601627ef1f20918bc00907df88b`，与写入前快照一致。随后用人工复核的 Vault rebuild plan 原子重建 live Vault；plan 的 canonical SHA-256 为 `56984aeb89f6d0aba8cdc8021d74121fc9b07a71bc79406428bf43653a03f82b`，包含 15 个 Archive package。plan 重新生成后 canonical 内容相等，未发现 Archive 或旧 Vault 漂移。

renderer baseline 文件和 SQLite singleton row 的 canonical SHA-256 均为 `6b717f68a6e5579c6216f448673469b1d17f833fd447ae76e85f67cfeea642fc`，覆盖两次既有 publication、15 个累计 source；写入时没有修改原始 receipt、publication 或历史 DB 行。当前三次 completed publication 中，前两次由 baseline 提供 V3 projection，第三次由新 run 正常认证。

新 run 的 publication ID 为 `evidence-c3ac2bf6f9391922d8ca2189a08d1f5e`，input SHA-256 `a34dc0ecc970d9fdc74434b7565246caeb4a8725f9c8d448a9fa9405dc3fa13a`，receipt SHA-256 `7046fd4abee59b891ab36faf67121e9c549f8ed3aff259a3e81caf50989d8876`，Evidence manifest 文件 SHA-256 `10af66c65cfe86d0b00151690bcc3ff43e7cab645c1f081cd9c26283e3bae47b`。随后再次以同一 run 执行 `evidence-publish`，返回 `replayed=true`、`sourceCount=15`；Vault 托管树重放前后都为 661 个文件、74,978,055 bytes，聚合 SHA-256 `e5467b2060bfdb31f64c98110e8bde073e41e7bd66c9dd59ebaaad70c2f6b42e`。旧 receipt SHA-256 仍为 `58be1666ab75570ee78e3670544c56a077ff27214e3c325cce49bc5896c3311d` 和 `514270ec01f26f7e5787d80676232e3f5c7f567ef320f2685f3c3f21b46ec71b`。

最终只读 `reconcile` 退出码 0，结果为 `consistent` 15 个 source、`evidence.valid=true`、`paperCount=15`、`expectedPaperCount=15`、`indexCount=4`、`brokenLinks=0`、`missingAssets=0`、`archiveIssues=[]`、`missingPdf=[]`、`duplicatePdfs=[]`、`retryParse=[]`、`retryWiki=[]`、`rebuildNote=[]`。SQLite 已 checkpoint，当前没有 `library.sqlite-wal` 或 `library.sqlite-shm`；live Vault 没有 `Knowledge/`，没有注册 scheduler，也没有下载训练集/权重、执行论文仓库代码或调用 LLM。

四份当前配置指纹保持为：`library.yaml` `2ec11244c33fcf18050b1961320aa265ebe33b66a8b4108ab69f7981b7436051`、`query-matrix.yaml` `6cce751ee5e11e4f3c17e24531b99ac8ba16a127bddbbc084a53921076db09af`、`paper-policy.yaml` `ba2803f3be76e8f9ae815837ab2b2d8d200f8ed8c6baa019f2eb14997d05870f`、`categories.yaml` `09826255be14b7df7b7fb70b19b3bd87f8d9adc2036cac8d9ae29be9e7e8aed0`。写入和运行都局限在 `llm-post-training` 的 state、PDF、Archive、Vault 根；没有发现其它三个方向被写入。

### 最终门禁

- 18 Track、查询矩阵、筛选边界和配置指纹：**通过**。
- 补救 run 的 36/36 discovery shards、5979 observations、5 篇下载/解析/Archive/Evidence：**通过**。
- 固定 36 篇人工相关性审查：**通过**（31/36，86.1%，0 uncertain，覆盖全部 Track）。
- Vault rebuild plan、旧 Vault 备份和 renderer baseline：**通过**（hash-pinned、可重放、旧证据不变）。
- Evidence receipt 重放：**通过**（同 publication、`replayed=true`、托管集合和内容哈希不变）。
- 最终 Evidence reconcile：**通过**（15/15、4 indexes、0 broken、0 missing、0 archive issue）。
- 写入隔离与安全边界：**通过**（无 Knowledge、scheduler、训练资源下载或跨库写入）。

因此，LLM Post-Training 首期知识库已完成本轮实施和验收；后续可按计划进入人工 Knowledge 页建设与下一批次增量采集。
