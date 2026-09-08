# 大模型后训练知识库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `llm-post-training` 接入为独立的 18-Track paper 方向库，完成配置、筛选校准、隔离验证、资料试运行及初始/增量验收。

**Architecture:** 通过现有四文件 `PaperLibraryConfig` 契约接入，共用 OpenCLI/arXiv → 规则选篇 → PDF → MinerU → Archive v2 → Evidence v3。方向配置表达差异；不新增专用生产模块，不修改共享日期、选篇、调度、解析或发布语义。

**Tech Stack:** 仓库现有 Bun 1.4.0、TypeScript 7.0.2、YAML、OpenCLI、SQLite、MinerU 和 Obsidian；不升级依赖。

**Spec:** [已确认的目标方案](../specs/2026-09-08-llm-post-training-design.md)

**状态：** 2026-09-08 编写；目标方案已确认，本实施计划尚未执行。以下复选框记录实施进度，不记录本轮计划编写进度。

## Global Constraints

- `library_id: llm-post-training`；`display_name: LLM Post-Training（大模型后训练知识库）`；`library_kind: paper`。
- 18 个 Track 和 PDF 目录与目标方案第 4 节一致；每个 Track 同时包含 submitted/updated，共 36 分片。
- `start_date: 2026-01-01`；`overlap_hours: 48`；Current 总上限 180；18 个 Track 各配置 10；Weekly 总上限 18。
- 每 Track 的 10 是共享选篇器的初始分配目标，允许空额外溢，不新增每类硬上限。
- 自动来源仅 OpenCLI/arXiv；保留手动 `import-local` / `parse-local`，不接入 research 工作流。
- PDF、SQLite、Archive、运行记录、水位、锁、Vault 和回执按方向隔离；保留共享机器根与资源约束。
- Archive v2 / Evidence v3 保持不变；托管发布器不得生成或覆盖人工 `Knowledge/`。
- 模型对象词与后训练信号来自标题/摘要，不以 Track 标签替代证据；规则共现不等同于语义审查。
- 首期试运行 5–10 篇；另抽查 20–40 篇通过规则的唯一候选，初期相关率目标至少 85%。不足样本量必须报告不足。
- 历史基础候选清单 20–30 篇；按真实来源人工补充，不更改日期、不伪装自动发现。
- 本计划不运行模型训练、不下载训练集或权重、不执行论文仓库代码、不调用 LLM 生成知识内容。
- 首期不注册 Windows/Codex 定时任务。`weekly_schedule.enabled: true` 仅保持既有手动增量入口可用。
- 测试使用隔离路径。保留当前工作区已有修改；不得 reset、clean、整体覆盖现有文档或夹带提交。
- 本轮只编写计划及更新目标方案确认状态；执行以下步骤须由后续实施请求启动。

## 0. 执行前准备与任务依赖

默认从 `D:/agent-data/backend/projects/paper-knowledge-engine` 执行命令。若使用执行工作树，所有项目相对路径以该工作树的项目根为准。

当前工作区已经包含未提交的共享引擎和 Agent/Multi-Agent 修改。不能假定从仓库 HEAD 新建的工作树具有本计划依赖的能力。实施前记录 `git status --short`、`git rev-parse HEAD`，核对现有四文件加载、36 分片、`run-task --limit`、Archive v2 和 Evidence v3；工作树如需隔离，应携带经过核对的当前工作状态，不遗漏未跟踪配置与代码。

执行前阅读项目 `AGENTS.md`、`.trellis/workflow.md`、`.trellis/spec/backend/index.md`、`tests/README.md`。Trellis 工作记录引用本方案和本计划，不复制第二份互相漂移的设计正文。

```powershell
git status --short
git rev-parse HEAD
bun --version
bun run typecheck
bun test --timeout 30000 tests/multi-agent-paper-library.test.ts tests/configured-task-limits.test.ts tests/cli-menu.test.ts tests/run-task.test.ts
```

记录退出码及既有失败。基线不通过时先判断是否影响新方向的必需链路；不能把既有失败归给本计划，也不能在关键链路失败时继续批量入库。

任务顺序：**1 → 2 → 3 → 4 → 5 → 6**。前四项交付代码配置与操作说明；第 5 项交付真实试运行证据；第 6 项形成初期资料和增量验收。没有实际 runId 和资料检查结果时，不得把后两项标记完成。

## 1. 文件职责与变更范围

| 文件 | 操作 | 职责 |
|---|---|---|
| `config/llm-post-training/library.yaml` | 新增 | 方向身份、配额和执行参数 |
| `config/llm-post-training/query-matrix.yaml` | 新增 | 18 个 Boolean 检索表达式及分类 |
| `config/llm-post-training/paper-policy.yaml` | 新增 | 对象词、后训练信号词、变体和分类顺序 |
| `config/llm-post-training/categories.yaml` | 新增 | PDF 目录映射 |
| `tests/helpers/llm-post-training-fixture.ts` | 新增 | 基于既有 fixture 创建四库隔离环境 |
| `tests/llm-post-training-paper-library.test.ts` | 新增 | 方向契约、筛选正反例、日期边界 |
| `tests/llm-post-training-integration.test.ts` | 新增 | 四库隔离、菜单、共享发现入口 |
| `README.md`、`config/README.md`、`CONTEXT.md`、`使用手册.md`、`tests/README.md` | 定点修改 | 新库入口、范围、运行和测试说明 |
| `docs/llm-post-training/operations.md` | 新增 | 当前/增量/恢复/历史导入操作说明 |
| `docs/llm-post-training/foundational-papers.md` | 新增 | 20–30 篇经来源核对的基础候选及收录记录 |
| `docs/llm-post-training/acceptance.md` | 验收时新增 | 环境、测试和实际运行结论，不预填成功 |
| 新库运行根下 `work/acceptance/` | 执行时临时生成 | 原始抽样、查询/规则版本与检查记录 |

临时生成/审查脚本可放在项目 `tmp/`，不作为长期工具或生产模块提交。原始运行产物不提交；需要长期保留的样本 ID、判断和结果摘要写入 acceptance 文档，避免仅存放于可清理工作区。

生产 TypeScript 预期零修改。若测试证明公共链路存在阻塞，先记录具体失败和最小变更范围，再补充计划；不要绕过契约复制新 workflow。

## Task 1：接入四文件配置和方向契约

**Files:** 新增四个方向 YAML、fixture helper 和 `tests/llm-post-training-paper-library.test.ts`。

**Interfaces:**

- 消费 `loadEngineContext({ root, libraryId })`、`listLibraries(root)`、`configurationFiles(libraryId, 'paper')`、`routeHarvestPlan(args, context)`、`routeScheduleConfig(args, context)`。
- 产出有效的 `PaperLibraryConfig`、18 个 Track、36 个分片与独立路径；后续任务通过同一 fixture 读取最终 YAML。

- [ ] **1.1 建立隔离 fixture。** 新增以下 helper；复用现有机器根重写能力，并复制各库真实配置。`writeLayeredConfigFixture` 的 `additionalLibraryIds` 只会克隆 FSD，因此不能用它冒充其他方向的真实配置。

```ts
// tests/helpers/llm-post-training-fixture.ts
import { cp, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { writeLayeredConfigFixture } from '../fixtures/layered-config.ts';
import { removeOwnedTestDirectory } from '../fixtures/runtime-fixtures.ts';

export const paperLibraryIds = [
  'fsd', 'agent-engineering', 'multi-agent-engineering', 'llm-post-training',
] as const;

export async function withPostTrainingFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const testRoot = process.env.FSD_TEST_ROOT;
  if (!testRoot) throw new Error('FSD_TEST_ROOT must be set by tests/preload.ts');
  const root = await mkdtemp(join(testRoot, 'post-training-'));
  try {
    await writeLayeredConfigFixture({ root });
    for (const id of paperLibraryIds.slice(1)) {
      await cp(join(import.meta.dirname, '../../config', id), join(root, 'config', id), {
        recursive: true,
      });
    }
    return await run(root);
  } finally {
    await removeOwnedTestDirectory(root);
  }
}
```

- [ ] **1.2 写方向契约测试。** 固定期望来自已确认设计，不从被测 YAML 动态推导所有期望。

```ts
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadEngineContext, listLibraries } from '../src/shared/engine-context.ts';
import { routeHarvestPlan, routeScheduleConfig } from '../src/cli/routes.ts';
import { configurationFiles } from '../src/shared/config-files.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { withPostTrainingFixture } from './helpers/llm-post-training-fixture.ts';

const libraryId = asLibraryId('llm-post-training');
const expectedTracks = [
  'pt-foundations', 'pt-sft', 'pt-data-curation', 'pt-synthetic-data',
  'pt-reward-modeling', 'pt-preference-optimization', 'pt-policy-optimization',
  'pt-verifiable-rewards', 'pt-reasoning', 'pt-distillation', 'pt-tool-agent',
  'pt-multimodal', 'pt-safety-alignment', 'pt-adaptation', 'pt-efficient-tuning',
  'pt-training-systems', 'pt-stability', 'pt-evaluation',
];

test('post-training loads the complete paper contract', () => withPostTrainingFixture(async root => {
  const { library } = loadEngineContext({ root, libraryId });
  if (library.kind !== 'paper') throw new Error('expected paper library');
  assert.equal(library.displayName, 'LLM Post-Training（大模型后训练知识库）');
  assert.equal(library.startDate, '2026-01-01');
  assert.equal(library.paperPolicy.startDate, library.startDate);
  assert.equal(library.overlapHours, 48);
  assert.equal(library.downloadAfterHardFilter, true);
  assert.equal(library.currentTask.maxPapers, 180);
  assert.deepEqual(library.currentTask.trackLimits,
    Object.fromEntries(expectedTracks.map(id => [id, 10])));
  assert.deepEqual(library.tracks.map(track => track.id), expectedTracks);
  assert.deepEqual(library.paperPolicy.trackPriority, expectedTracks);
  assert.deepEqual(Object.keys(library.categories.tracks), expectedTracks);
  assert.equal(library.categories.fallbackPdf, '99-Unclassified');
  assert.deepEqual(library.paperPolicy.programStructureTerms, []);
  assert.ok(listLibraries(root).some(item => item.libraryId === libraryId));
  const names = ['library.yaml', 'query-matrix.yaml', 'paper-policy.yaml', 'categories.yaml'];
  assert.deepEqual((await readdir(join(root, 'config', libraryId))).sort(), [...names].sort());
  assert.deepEqual(configurationFiles(libraryId, 'paper').slice(-4),
    names.map(name => join(libraryId, name)));
  for (const mode of ['current', 'weekly']) {
    const plan = routeHarvestPlan(['--mode', mode, '--format', 'json'], { root, libraryId });
    assert.equal(plan.trackCount, 18);
    assert.equal(plan.totalShards, 36);
    assert.equal(plan.submittedShards, 18);
    assert.equal(plan.updatedShards, 18);
    assert.equal(plan.maxPapers, mode === 'current' ? 180 : 18);
  }
  const schedule = routeScheduleConfig(['--format', 'json'], { root, libraryId });
  assert.equal(schedule.enabled, true); // manual weekly must remain executable
  assert.equal(schedule.taskName, 'paper-knowledge-engine-llm-post-training-weekly');
  assert.deepEqual(schedule.command, ['--library', libraryId, 'run-task', '--mode', 'weekly']);
}));
```

- [ ] **1.3 运行契约测试，记录尚无配置时的失败。**

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts
```

预期在复制/加载 `config/llm-post-training` 时失败。若执行时目录已由其他任务创建，先核对内容与来源，不覆盖或制造人为失败。

- [ ] **1.4 创建四文件初稿。** 将附录 A 保存为临时脚本 `tmp/llm-post-training-config-seed.ts`，从项目根执行；脚本只允许创建尚不存在的目标方向目录。最终可提交产物是四份 YAML，脚本不参与运行时配置加载。

```powershell
bun tmp/llm-post-training-config-seed.ts
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts
bun src/cli.ts --library llm-post-training harvest-plan --mode current --format json
bun src/cli.ts --library llm-post-training schedule-config --format json
```

预期契约通过；描述符为 18/36/180，增量配额 18。配置查看不创建真实论文状态。

- [ ] **1.5 检查调度语义。** `weekly_schedule.enabled: true` 允许手动 weekly；禁止调用安装器。附录 A 的周一、四周、23:30、2026-09-07 只满足现有描述符必填契约，未注册任务前不会触发运行，也不是已确定的将来调度承诺。

**完成标准：** 四文件可加载、目录/数量与设计一致、共享调度语义清楚，尚无论文入库。

## Task 2：校准筛选边界与检索表达式

**Files:** 完善 `tests/llm-post-training-paper-library.test.ts`；按失败样例调整新库 `paper-policy.yaml` 和 `query-matrix.yaml`。

**Interfaces:** 消费 `evaluateCandidate(rawPaper, paperPolicy)`，检查 `accepted`、`reasons`、`signals` 与 `paper` 内匹配结果；Boolean 查询由既有 `buildArxivQuery` 加上分类与日期窗口。

- [ ] **2.1 增加每个 Track 的明确正例。** 在契约测试文件引入 `evaluateCandidate` 和 `PaperMetadata`，加入下列数据与测试。样例是人工构造的规则测试，不能当作真实论文或检索召回证据。

```ts
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import type { PaperMetadata } from '../src/types/papers.ts';

const positives: [string, string][] = [
  ['pt-foundations', 'A survey of language model post-training objectives'],
  ['pt-sft', 'Supervised fine-tuning of large language models'],
  ['pt-data-curation', 'Instruction tuning data quality for language models'],
  ['pt-synthetic-data', 'Synthetic instruction data for language models'],
  ['pt-reward-modeling', 'Process reward models for large language models'],
  ['pt-preference-optimization', 'Direct preference optimization for LLMs'],
  ['pt-policy-optimization', 'GRPO optimization for large language models'],
  ['pt-verifiable-rewards', 'Reinforcement learning with verifiable rewards for LLMs'],
  ['pt-reasoning', 'Reasoning training for language models'],
  ['pt-distillation', 'Policy distillation for large language models'],
  ['pt-tool-agent', 'Agent reinforcement learning for language models'],
  ['pt-multimodal', 'Instruction tuning for vision-language models'],
  ['pt-safety-alignment', 'Safety alignment of language models'],
  ['pt-adaptation', 'Continual fine-tuning of language models'],
  ['pt-efficient-tuning', 'QLoRA for large language models'],
  ['pt-training-systems', 'Asynchronous RLHF training of LLMs'],
  ['pt-stability', 'Entropy collapse in language model post-training'],
  ['pt-evaluation', 'Evaluation of language model post-training generalization'],
];
function paper(title: string, track = 'pt-foundations', extra: Partial<PaperMetadata> = {}): PaperMetadata {
  return {
    baseId: '2609.90001', arxivId: '2609.90001v1', version: 1,
    title, summary: '', authors: ['Synthetic Fixture'], categories: ['cs.CL'],
    published: '2026-09-01T00:00:00Z', updated: '2026-09-01T00:00:00Z',
    matchedTracks: [track], ...extra,
  };
}
test('post-training accepts all intended policy themes', () => withPostTrainingFixture(async root => {
  const { library } = loadEngineContext({ root, libraryId });
  if (library.kind !== 'paper') throw new Error('expected paper library');
  for (const [track, title] of positives) {
    const decision = evaluateCandidate(paper(title, track), library.paperPolicy);
    assert.equal(decision.accepted, true, `${track}: ${JSON.stringify(decision.reasons)}`);
  }
}));
```

- [ ] **2.2 增加负例与边界例。**

```ts
test('post-training rejects lexical negatives and validates source/date/track', () => withPostTrainingFixture(async root => {
  const { library } = loadEngineContext({ root, libraryId });
  if (library.kind !== 'paper') throw new Error('expected paper library');
  const decide = (input: PaperMetadata) => evaluateCandidate(input, library.paperPolicy);
  for (const title of [
    'PPO reinforcement learning for robot locomotion',
    'GRPO for game agents without natural language processing',
    'Large language model pretraining data scaling',
    'Prompt optimization for language model question answering',
    'Language model inference acceleration with quantization',
    'Language model agent orchestration and message routing',
    'Fine-tuning a language model for a hospital application',
    'DPO for a scheduling solver',
  ]) assert.equal(decide(paper(title)).accepted, false, title);
  const title = 'Post-training of language models';
  assert.equal(decide(paper(title, 'pt-foundations', { arxivId: '2609.90001v2' })).reasons.sourceAccepted, false);
  assert.equal(decide(paper(title, 'unknown-track')).reasons.trackAccepted, false);
  assert.equal(decide(paper(title, 'pt-foundations', { published: '2025-01-01', updated: '2025-12-31' })).accepted, false);
  assert.equal(decide(paper(title, 'pt-foundations', { published: '2025-01-01', updated: '2026-01-01' })).accepted, true);
  assert.equal(decide(paper(title, 'pt-foundations', { published: '2026-01-01', updated: '2026-01-01' })).accepted, true);
  assert.equal(decide(paper(title, 'pt-foundations', { updated: 'invalid-date' })).accepted, false);
  assert.equal(decide(paper('An unrelated systems paper')).accepted, false);
  for (const title of [
    'POST–TRAINING of LLMs',
    'Reward modelling for language models',
    'Reward hacking in language model reinforcement learning',
    'Forgetting and jailbreaks after language model safety alignment',
  ]) assert.equal(decide(paper(title)).accepted, true, title);
  // A known limitation: source text mentioning related work can satisfy lexical gates.
  const ambiguous = paper('Language model inference study', 'pt-evaluation', {
    summary: 'Related work discusses GRPO, but our contribution is an inference cache.',
  });
  assert.equal(decide(ambiguous).accepted, true);
}));
```

最后一例固定记录当前语义限制，不表示应人工收录该论文。如果以后改进公共筛选器，需要同步更新这一限制测试及设计说明。普通应用微调负例只验证缺乏特定信号的情况；包含完整 SFT/GRPO 词语的应用论文仍需要人工评审。

- [ ] **2.3 运行并按失败修正规则。**

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts
```

出现漏收时优先补充明确短语及词形，不用裸 `training`、`optimization`、`agent`、`fine-tuning` 放宽全库。`program_structure_terms` 保持空数组，排除词初始为空；风险研究词不能设为全局排除项。

- [ ] **2.4 校对查询与词表的对应。** 逐 Track 检查附录 A 的主题短语至少有对应的规则信号，确认 `cs.CL/cs.LG/cs.AI` 等分类按主题选取。通过 `harvest-plan` 只能证明配置展开正确，不能证明 arXiv 实际召回；真实命中在 Task 5 记录。

**完成标准：** 18 个规则正例、明确负例和时间/身份边界通过；查询初稿可审阅；关键词局限有可复现记录。

## Task 3：证明共享执行、四库隔离与命令行为

**Files:** 新增 `tests/llm-post-training-integration.test.ts`；消费 Task 1 的 helper。复用现有恢复、发布和本地导入测试，不复制其实现。

**Interfaces:** 消费 `main(argv, context)`、`normalizeCliOperation(...)`、CLI `runConfiguredTask(args, root, context)` 和 `openStateStore(':memory:')`；产出无真实网络/GPU写入的方向集成验证。

- [ ] **3.1 添加以下集成测试。**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { main } from '../src/cli.ts';
import { normalizeCliOperation, runConfiguredTask } from '../src/cli/routes.ts';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { asLibraryId } from '../src/shared/identity.ts';
import { openStateStore } from '../src/library/state/state-store.ts';
import { paperLibraryIds, withPostTrainingFixture } from './helpers/llm-post-training-fixture.ts';

const libraryId = asLibraryId('llm-post-training');
test('all four paper libraries have separate paths and opening a menu creates no state', () =>
  withPostTrainingFixture(async root => {
    const contexts = paperLibraryIds.map(id => loadEngineContext({ root, libraryId: id }));
    for (const key of ['dataRoot', 'databasePath', 'archiveRoot', 'runsRoot',
      'operationsRoot', 'workRoot', 'backupRoot', 'pdfRoot', 'vaultRoot'] as const) {
      const paths = contexts.map(context => context.paths[key]);
      assert.ok(paths.every(path => typeof path === 'string'));
      assert.equal(new Set(paths).size, 4, key);
    }
    const lines: string[] = [];
    await main(['--library', libraryId], {
      root, interactive: true, readLine: async () => '0', writeLine: line => { lines.push(line); },
    });
    assert.ok(lines.some(line => line.includes('LLM Post-Training')));
    assert.ok(lines.includes('11. 切换方向库'));
    for (const { paths } of contexts) {
      for (const path of [paths.dataRoot, paths.vaultRoot, paths.pdfRoot]) {
        assert.ok(path && !existsSync(path));
      }
    }
    assert.throws(() => normalizeCliOperation('run-task', ['--mode', 'backfill'], libraryId, 'paper'),
      /UNSUPPORTED_LIBRARY_KIND/);
    assert.deepEqual(normalizeCliOperation('run-task', ['--mode', 'weekly'], libraryId, 'paper'),
      { kind: 'weekly' });
  }));

test('post-training current and weekly use shared discovery with checkpoints', () =>
  withPostTrainingFixture(async root => {
    const expected = loadEngineContext({ root, libraryId });
    for (const mode of ['current', 'weekly']) {
      let calls = 0;
      await runConfiguredTask(['--mode', mode], root, {
        libraryId, openStateStore: () => openStateStore(':memory:'), bootstrap: async () => {},
        harvest: async (shards, _window, options) => {
          calls++;
          assert.equal(shards.length, 36);
          assert.equal(typeof options.checkpoint.start, 'function');
          assert.deepEqual(options.network, expected.machine.network);
          return [];
        },
        executeTask: async (options, dependencies) => {
          assert.equal(dependencies.config.weeklySchedule.enabled, true);
          assert.equal(dependencies.config.libraryId, libraryId);
          assert.equal(dependencies.runRoot, expected.paths.runsRoot);
          const window = { from: '2026-01-01T00:00:00Z', to: '2026-09-08T00:00:00Z' };
          const run = dependencies.store.startRun(window, options.mode);
          await dependencies.discovery.harvest({ window, run });
          return { status: 'completed', mode: options.mode, runId: run.id, window, selected: [], paperCount: 0 };
        },
      });
      assert.equal(calls, 1);
    }
    await assert.rejects(runConfiguredTask(['--mode', 'weekly', '--limit', '5'], root, { libraryId }),
      /weekly run-task does not accept --limit/);
  }));
```

这里替换网络与执行接缝，验证方向路由；不把该测试宣称为实际 MinerU 或完整流水线验收。手动 weekly 的禁用语义已有 `tests/run-task.test.ts` 覆盖，Task 6 再验证真实增量。

- [ ] **3.2 运行新库与三个现有方向的定向回归。**

```powershell
bun test --timeout 30000 tests/llm-post-training-paper-library.test.ts tests/llm-post-training-integration.test.ts tests/multi-agent-paper-library.test.ts tests/research-library-config.test.ts tests/cli-menu.test.ts tests/configured-task-limits.test.ts tests/research-fsd-isolation.test.ts
bun test --timeout 30000 tests/run-task.test.ts tests/task-selection.test.ts tests/automatic-selection-resume.test.ts tests/harvest-checkpoint.test.ts tests/local-pdf-import.test.ts tests/evidence-publisher.test.ts tests/evidence-atomic-replace.test.ts tests/evidence-layout-v3.test.ts
bun run typecheck
bun test --timeout 30000
```

只在首次集成完成或新修改/失败需要时运行全套，不为凑次数反复执行。测试 preload 负责隔离根，禁止把测试根指向生产数据或 Vault。

- [ ] **3.3 记录验收映射。** 用现有共享测试证明多 Track 去重/配额外溢、冻结选择、中断恢复、原子发布及本地导入水位行为；新测试证明真实新库配置接入这些接口。报告必须区分“离线路由覆盖”与“真实链路覆盖”。

**完成标准：** 新库及现有方向回归通过；类型检查通过；失败与基线差异明确；没有依靠生产路径完成自动化测试。

## Task 4：补充使用文档与历史基础候选

**Files:** 定点更新文件表中的五份现有说明；新增 `docs/llm-post-training/operations.md` 与 `foundational-papers.md`。

**Interfaces:** 操作说明消费共享 CLI；历史记录以真实 arXiv ID/版本和本地内容身份建立人工对应，不向数据库添加新 Schema。

- [ ] **4.1 在现有入口文档补充第四个 paper 库。** 更新当前方向数量、显示名、18 Track、36 分片、Current 180 / Weekly 18、路径派生和测试命令；保留原有段落中的其他任务修改。

`CONTEXT.md` 增加定义：“大模型后训练方向库研究预训练之后的学习方法及其数据、奖励、系统与评测；稳定标识 llm-post-training；与 Agent 运行时工程和 Multi-Agent 编排分开，允许交叉论文各库独立保存。”

- [ ] **4.2 写明以下操作顺序与行为。**

```powershell
bun src/cli.ts --library llm-post-training harvest-plan --mode current --format json
bun src/cli.ts --library llm-post-training mineru-config --format json
bun src/cli.ts --library llm-post-training arxiv-check --format json
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
bun src/cli.ts --library llm-post-training run-task --mode weekly --format json
bun src/cli.ts --library llm-post-training reconcile
```

文档必须解释：`current --limit 5` 只限制选篇/下载/解析规模，检索仍按分片预算执行；`weekly` 不接受 `--limit`；`run-task` 没有供本计划使用的 `--resume` 参数。未完成任务重复相同命令自动恢复，冻结选择后保持原限额；完成试运行后再以默认 180 创建新的 current，不能改写旧 selection manifest。

发布恢复使用 `evidence-publish --run-id`，其中 runId 必须来自实际运行输出/记录；禁止虚构 ID 或将其他库的 runId 混入本库。只读对账采用不带修复选项的 `reconcile`。

不引用 `package.json` 中省略 `--library` 的快捷脚本；不调用默认仍按 FSD 装载配置的 `automation/weekly/install-weekly-task.ts`。没有注册新库定时任务才是首期自动调度关闭的依据。

- [ ] **4.3 形成 20–30 篇真实历史候选清单。** 先核对目标方案已列出的六篇原始来源，再从这些论文的参考文献及原始论文网站补充 SFT、数据、反馈、安全、蒸馏与高效训练的缺口。每项至少记录：标题、作者、原始来源 URL、arXiv ID（如有）、拟选版本、首次提交/更新时间、Track、入选理由、是否已自动收录。

初始核对入口：`2203.02155`、`2305.18290`、`2305.20050`、`2305.14314`、`2402.03300`、`2501.12948`。它们的链接与概念说明见目标方案；其余候选必须实际查询原始来源后填写，不能把预期数量当成已核对数量。

- [ ] **4.4 写明历史导入的真实限制。** 现有本地导入以 PDF 哈希生成 `local-...` 身份，使用共享默认 Track；它不会自动恢复论文全部 arXiv 元数据，也不会自动归入本库 18 个主题。原始提交时间、版本、来源 URL 与 `local-*` 对应关系保存于人工清单，不伪造数据库字段、不修改全局 Local-PDF 默认值、不伪装自动发现水位。

导入前逐文件执行预览，再导入选定的文件。避免直接扫描整个历史资料文件夹造成未选论文进入系统。`operations.md` 给出命令 `import-local --path` 和 `--preview` 的用途，并说明真实绝对路径由候选清单中的文件记录提供。

**完成标准：** 文档命令与实际 CLI 一致；20–30 篇候选具有已核对的来源；尚未导入的条目明确记为候选；文档审阅通过即可，无需为纯文本另造测试。

## Task 5：真实小批量试运行与候选相关性审查

**Files:** 新库数据根、PDF 根与 Vault；临时 `work/acceptance/` 记录；新增 `docs/llm-post-training/acceptance.md`。

**Interfaces:** 消费真实 `run-task` 输出的 runId、`runs/<runId>/selection-manifest.json`、SQLite 中完成分片的 observations、Archive 与 Evidence；产出真实质量报告。

- [ ] **5.1 记录环境和配置版本。** 保存本次四个 YAML 的 SHA-256、引擎 commit、工作区差异摘要、MinerU 配置及根路径。核对新库路径与三个现有方向分离，先完成 `arxiv-check`；429 按持久冷却恢复，不切换主机/代理反复重试。首次运行前不改变全局 MinerU 并发和机器代理。

- [ ] **5.2 执行 5 篇试运行。**

```powershell
bun src/cli.ts --library llm-post-training run-task --mode current --limit 5 --format json
```

记录实际 runId、任务状态及 candidates/accepted/newVersions/archived/published 五个计数。没有合格候选时报告空结果并检查各 Track 召回，不放宽为裸通用词。失败时保留 checkpoint 与 selection manifest，重跑相同命令；不同限额不能用作恢复手段。

- [ ] **5.3 从检索候选抽取审查样本。** 不只审查已下载的 5 篇。停止本库写入后，调用既有 `openReadOnlyStateStore` 读取本次完成分片 observations，按唯一 baseId 选最新版本并合并 Track，再按当前保存的策略重算接受结果。确认配置哈希与 Task 5.1 一致；如果规则变化，另存新审查批次，不能覆盖旧结果。

附录 B 给出可直接保存到 `tmp/llm-post-training-review.ts` 的脚本。命令的第一个参数是步骤 5.2 取得的真实 runId，第二个参数是新库 `work/acceptance/` 内一个尚不存在的 JSON 文件路径。脚本拒绝覆盖文件、拒绝不完整运行，使用只读快照接口；若存在活跃 WAL/SHM，等待正常关闭，不删除或绕过它们。

抽样默认最多 36 篇：按已确认 Track 顺序轮询，每轮每 Track 取一篇；各候选先按固定 runId+baseId 的哈希顺序排列；全局去重。这样能复核抽样过程，也不会事后挑选更容易通过的论文。

- [ ] **5.4 完成人工相关性审查。** 每个样本记录 `relevant` / `irrelevant` / `uncertain`、原始链接、判断理由、主要/交叉主题及误收原因。未决条目计入分母但不计入相关数，避免抬高比例；至少 20 篇且比例不低于 85% 才通过本门槛。样本不足、失败或缺失 Track 分别报告，不声称召回率或主题完整覆盖。

不达标时回到 Task 2 调整新库词表/查询，并保留失败样本作为回归资料；不能为提高数字只删样本。查询变化需要新的查询结果，规则变化可以对保留 observations 重新评估，但两者都要生成新记录和哈希。

- [ ] **5.5 验证阅读质量与发布恢复。** 对试运行每篇检查来源、版本、PDF、正文和索引链接。至少从样本中选有公式、有表格、有图片的论文各一例；若 5 篇不涵盖这些结构，可在总试验范围 5–10 篇内补足，不把缺失结构默认为通过。

记录具体页码、正确/缺失内容及截图或源文件引用。MinerU 对关键公式/表格解析错误时，保留原 PDF 证据并记录影响；不能将“存在 Markdown”作为解析正确的证明。

对完成 runId 再执行 `evidence-publish --run-id`，比较托管文件集合与内容哈希，确认没有重复论文或非预期覆盖。冻结选篇和故障注入的证明主要来自 Task 3 的离线测试；不故意杀死共享 GPU 服务来制造生产故障。实际发生中断时另记录真实恢复证据。

- [ ] **5.6 归档本阶段结论。** acceptance 文档写入 runId、配置哈希、抽样 ID、相关率分子/分母、缺失主题、解析缺陷、发布重放结果、已有方向影响及下一阶段是否满足进入条件。完整摘要移出可回收 `work/`。

**完成标准：** 真实 5–10 篇资料可读、候选审查达到门槛、重放结果可核查；发现阻塞性质量问题则保持阶段未完成。

## Task 6：首期资料、历史补充与增量验收

**Files:** 新库运行资料；更新 `foundational-papers.md`、`operations.md` 与 `acceptance.md`。

**Interfaces:** 消费共享 Current/Weekly、Local PDF import 和 Evidence 发布；保留相同方向身份、版本和水位规则。

- [ ] **6.1 完成首轮 Current 建库。** Task 5 通过后，先确认没有未完成的 5 篇冻结任务，再运行默认 Current。

```powershell
bun src/cli.ts --library llm-post-training run-task --mode current --format json
```

本次上限 180，不是需要新增 180 篇或全库上限。记录真实选篇、已存在版本、成功归档/发布、失败和各 Track 分布；重叠论文不重复计数，不因主题空缺放松收录要求。

- [ ] **6.2 按清单补充历史基础论文。** 对照已入库的 arXiv ID/版本，去除已有项；仅处理已选定且可用的本地 PDF。逐文件预览与导入，保存原始来源和导入后 `local-*` 身份对应。没有文件的候选保持“未导入”，清单完成不等于全部已入库。

导入前后读取 `getLastSuccess()` 比较水位一致。只读连接在操作间关闭，避免跨导入持有旧快照。对同一个 PDF 重复导入一次，验证内容哈希去重与回放行为；不要用改文件名模拟新版本。

- [ ] **6.3 验证手动增量。** 在完成 Current 后运行：

```powershell
bun src/cli.ts --library llm-post-training run-task --mode weekly --format json
bun src/cli.ts --library llm-post-training reconcile
```

核对窗口从上次成功水位回退 48 小时且不早于配置起点，配额 18，跨 Track 与重叠窗口去重。真实无新增论文是合法结果，不为演示更新伪造日期或版本。旧论文新版路径由日期边界测试与共享版本测试覆盖；真实命中时补充对应 runId 和旧/新版本证据。

- [ ] **6.4 确认自动调度仍未注册。** 只读查询新库任务名，确认没有本计划创建的 Windows 或 Codex 自动运行。可用 PowerShell：

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -eq 'paper-knowledge-engine-llm-post-training-weekly' } | Select-Object TaskName,State
```

查询权限不足应报告“未验证”，不能当作不存在。若发现其他来源创建的同名任务，记录并核对，不直接删除。定时任务安装与未来频率不属于本计划交付。

- [ ] **6.5 完成总验收并提交限定范围。** 记录各阶段测试与实际运行结果，明确已实现/已验证/仍有缺口。全套测试已经通过且随后只修改人工验收文档时，不重复长时测试。

提交前使用 `git diff --check` 和逐文件 diff 核对。仅在隔离执行工作树或明确拥有待提交变更时，按任务分段提交；不使用 `git add .`。当前脏工作区的同名文档若夹有其他任务内容，保留未提交并说明，不为完成计划擅自提交全部变更。提交不含机器配置、PDF、SQLite、Archive、Vault、临时脚本和原始运行数据。

**完成标准：** 第四方向库可正常执行；初期资料与缺口有清单；历史导入和手动增量验证完成；现有三个方向保持可用；没有新增自动调度。

## 2. 回退与故障处理

| 问题 | 处理 | 保留的证据 |
|---|---|---|
| 新方向 YAML 不可加载 | 在新方向文件内修正或恢复已验证版本，不修改其他库 | 错误字段、配置 diff、测试输出 |
| 筛选相关率低或主题缺失 | 调整本库查询/词表，保留旧抽样并生成新批次 | 误收/漏收 ID、原因、前后配置哈希 |
| arXiv 429/网络失败 | 复用冷却与 checkpoint，原命令恢复 | runId、分片状态、错误码 |
| MinerU/PDF 失败 | 保留原件和冻结集合，从共享失败状态恢复 | 失败论文、attempt、阶段及原始 PDF |
| Evidence 发布失败 | 以同一 runId 重放已验证 Archive | 发布回执、文件集合及哈希 |
| 发现跨库路径或写入 | 停止本库后续操作，修复前先保留受影响文件与状态 | 绝对路径、操作记录、基线差异 |

停止新增库的使用不需要删除资料。已经有真实数据后，不通过移除整个数据根“重来”；也不做全仓库 Git 回滚。恢复配置不能宣称自动撤销已发布数据，任何后续资料清理都应明确到具体新库范围。

## 3. 设计覆盖与最终核对

| 已确认设计要求 | 实施位置 |
|---|---|
| 独立 paper 库、四文件、18 Track | Task 1、附录 A |
| 收录边界、关键词限制、日期与更新 | Task 2、Task 5 |
| 四库隔离、共享菜单、恢复和发布 | Task 3、Task 5 |
| 经典论文、手工来源可追溯 | Task 4、Task 6 |
| 5–10 篇试运行、20–40 篇审查、85% | Task 5 |
| Current 180 / Weekly 18 / 48 小时 | Task 1、Task 6 |
| 不注册自动调度、保留手动 weekly | Task 1、Task 4、Task 6 |
| 人工 Knowledge 不受覆盖、无 LLM | 全局约束、共享发布回归、Task 4–6 |

最终交付必须同时包含配置/代码验证结果和真实资料验收结果；仅前四项完成时，准确报告“方向接入已完成，真实资料验收未完成”。

计划编写自检（2026-09-08）：18 个 Track 和 PDF 目录与已确认设计一致；7 个 TypeScript 代码块通过语法解析；仅在内存构造附录 A 数据并调用现有纯筛选器，18 个正例、8 个负例与 4 个变体通过。此次自检没有生成方向配置或执行采集，不等同于完整类型检查、集成测试和真实运行验收；这些仍是实施步骤中的要求。

## 附录 A：四文件初稿生成脚本

此脚本是计划中的实现内容，尚未运行。查询是首版可执行表达式，必须经过 Task 2/5 校准；不把下表当作已验证的召回结果。

```ts
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

const rows: [string, string, string[], string[]][] = [
  ['pt-foundations', '01-PT-Foundations', ['post-training', 'post training', 'posttraining'], ['cs.CL','cs.LG','cs.AI']],
  ['pt-sft', '02-PT-SFT', ['instruction tuning', 'supervised fine-tuning', 'supervised finetuning', 'SFT'], ['cs.CL','cs.LG']],
  ['pt-data-curation', '03-PT-Data-Curation', ['instruction data', 'preference data', 'post-training data'], ['cs.CL','cs.LG']],
  ['pt-synthetic-data', '04-PT-Synthetic-Data', ['synthetic instruction', 'synthetic preference', 'self-instruct', 'rejection sampling'], ['cs.CL','cs.LG','cs.AI']],
  ['pt-reward-modeling', '05-PT-Reward-Modeling', ['reward model', 'reward models', 'reward modeling', 'process supervision', 'verifier training'], ['cs.CL','cs.LG','cs.AI']],
  ['pt-preference-optimization', '06-PT-Preference-Optimization', ['preference optimization', 'preference optimisation', 'DPO', 'ORPO', 'SimPO'], ['cs.CL','cs.LG']],
  ['pt-policy-optimization', '07-PT-Policy-Optimization', ['PPO', 'GRPO', 'policy optimization', 'policy optimisation'], ['cs.CL','cs.LG','stat.ML']],
  ['pt-verifiable-rewards', '08-PT-Verifiable-Rewards', ['verifiable reward', 'verifiable rewards', 'RLVR', 'rule-based reward'], ['cs.CL','cs.LG','cs.AI']],
  ['pt-reasoning', '09-PT-Reasoning', ['reasoning training', 'reasoning distillation', 'reasoning reinforcement learning', 'reasoning post-training'], ['cs.CL','cs.LG','cs.AI']],
  ['pt-distillation', '10-PT-Distillation', ['distillation', 'knowledge distillation', 'policy distillation'], ['cs.CL','cs.LG']],
  ['pt-tool-agent', '11-PT-Tool-Agent', ['agent reinforcement learning', 'agent training', 'tool-use training', 'trajectory supervision'], ['cs.CL','cs.LG','cs.AI','cs.MA','cs.SE']],
  ['pt-multimodal', '12-PT-Multimodal', ['instruction tuning', 'vision-language alignment', 'reinforcement learning', 'post-training', 'post training'], ['cs.CL','cs.LG','cs.CV','cs.SD']],
  ['pt-safety-alignment', '13-PT-Safety-Alignment', ['safety alignment', 'safety fine-tuning', 'RLHF', 'RLAIF', 'constitutional AI'], ['cs.CL','cs.LG','cs.AI']],
  ['pt-adaptation', '14-PT-Adaptation', ['continual fine-tuning', 'continual finetuning', 'domain instruction tuning', 'multilingual instruction tuning'], ['cs.CL','cs.LG']],
  ['pt-efficient-tuning', '15-PT-Efficient-Tuning', ['LoRA', 'QLoRA', 'parameter-efficient fine-tuning', 'parameter efficient finetuning'], ['cs.CL','cs.LG']],
  ['pt-training-systems', '16-PT-Training-Systems', ['RLHF', 'GRPO', 'post-training system', 'post-training systems', 'asynchronous reinforcement learning'], ['cs.CL','cs.LG','cs.DC']],
  ['pt-stability', '17-PT-Stability', ['post-training stability', 'reward hacking', 'entropy collapse', 'preference optimization'], ['cs.CL','cs.LG','stat.ML']],
  ['pt-evaluation', '18-PT-Evaluation', ['post-training evaluation', 'alignment evaluation', 'reward model evaluation', 'post-training generalization'], ['cs.CL','cs.LG','cs.AI']],
];
const terms = (values: string[]) => '(' + values.flatMap(value =>
  [`ti:"${value}"`, `abs:"${value}"`]).join(' OR ') + ')';
const modelTerms = ['language model', 'language models', 'LLM', 'LLMs',
  'vision-language model', 'vision-language models', 'multimodal language model'];
const folder = join(process.cwd(), 'config', 'llm-post-training');
try {
  await access(folder);
  throw new Error('Target config already exists; inspect and edit it instead of regenerating');
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
}
const trackIds = rows.map(([id]) => id);
const signals = [
  'post-training', 'instruction tuning', 'supervised fine-tuning', 'sft',
  'instruction data', 'preference data', 'synthetic instruction', 'synthetic preference',
  'self-instruct', 'rejection sampling', 'reward model', 'reward modeling',
  'process supervision', 'verifier training', 'preference optimization', 'dpo', 'orpo', 'simpo',
  'policy optimization', 'ppo', 'grpo', 'reinforcement learning', 'verifiable reward',
  'rlvr', 'rule-based reward', 'reasoning training', 'reasoning distillation',
  'distillation', 'agent training', 'tool-use training', 'trajectory supervision',
  'vision-language alignment', 'safety alignment', 'safety fine-tuning', 'rlhf', 'rlaif',
  'constitutional ai', 'continual fine-tuning', 'lora', 'qlora', 'parameter-efficient fine-tuning',
];
const variants = {
  'language model': ['language models'],
  'large language model': ['large language models'],
  llm: ['llms'],
  'vision-language model': ['vision-language models', 'vision language model', 'vision language models'],
  'multimodal language model': ['multimodal language models'],
  'post-training': ['post training', 'posttraining'],
  'supervised fine-tuning': ['supervised finetuning', 'supervised fine tuning'],
  'continual fine-tuning': ['continual finetuning', 'continual fine tuning'],
  'reward model': ['reward models'],
  'reward modeling': ['reward modelling'],
  'preference optimization': ['preference optimisation'],
  'policy optimization': ['policy optimisation'],
  'verifiable reward': ['verifiable rewards'],
  'parameter-efficient fine-tuning': ['parameter efficient finetuning', 'parameter efficient fine tuning'],
};
const documents = {
  'library.yaml': {
    library_kind: 'paper', library_id: 'llm-post-training',
    display_name: 'LLM Post-Training（大模型后训练知识库）',
    start_date: '2026-01-01', overlap_hours: 48, download_after_hard_filter: true,
    current_task: { max_papers: 180, track_limits: Object.fromEntries(trackIds.map(id => [id, 10])) },
    weekly_schedule: {
      enabled: true, task_name: 'paper-knowledge-engine-llm-post-training-weekly',
      day_of_week: 'monday', interval_weeks: 4, start_date: '2026-09-07',
      local_time: '23:30', timezone: 'Asia/Shanghai', max_papers: 18,
    },
  },
  'query-matrix.yaml': { tracks: rows.map(([id, _pdf, topics, categories]) => ({
    id, query: `${terms(id === 'pt-multimodal' ? ['vision-language model', 'vision-language models', 'multimodal language model', 'multimodal language models', 'audio language model', 'video language model'] : modelTerms)} AND ${terms(topics)}`, categories,
    date_modes: ['submitted', 'updated'],
  })) },
  'paper-policy.yaml': {
    start_date: '2026-01-01', excluded_domains: [],
    ai_technique_terms: ['language model', 'large language model', 'llm', 'vision-language model', 'multimodal language model'],
    program_structure_terms: [], engineering_task_terms: signals,
    term_variants: variants, track_priority: trackIds,
  },
  'categories.yaml': {
    tracks: Object.fromEntries(rows.map(([id, pdf]) => [id, { pdf }])),
    fallback_pdf: '99-Unclassified',
  },
};
await mkdir(folder, { recursive: true });
for (const [name, document] of Object.entries(documents)) {
  await writeFile(join(folder, name), YAML.stringify(document), { flag: 'wx' });
}
```

Task 2/5 可以改进明确短语和分类范围。涉及 Track 身份、目录、总配额、日期或来源种类的变更属于目标设计变更，应先更新设计依据，而不是藏在词表校准中。

## 附录 B：只读候选抽样脚本

该脚本只读取本库已完成运行并输出新审查 JSON，不下载、解析或发布论文。不得把它作为常驻采集器。人工审查结论需要另外保存；`review: null` 表示待实际审查的记录状态，不是计划未写完。

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadEngineContext } from '../src/shared/engine-context.ts';
import { openReadOnlyStateStore } from '../src/library/state/state-store.ts';
import { evaluateCandidate } from '../src/library/selection/paper-policy.ts';
import { configurationFiles } from '../src/shared/config-files.ts';
import type { PaperMetadata } from '../src/types/papers.ts';

const [runId, outputArg] = process.argv.slice(2);
assert.ok(runId && outputArg, 'pass an actual runId and a new output JSON path');
const root = process.cwd();
const context = loadEngineContext({ root, libraryId: 'llm-post-training' });
assert.equal(context.library.kind, 'paper');
if (context.library.kind !== 'paper') throw new Error('expected paper library');
const library = context.library;
const reviewRoot = resolve(context.paths.workRoot, 'acceptance');
const output = resolve(outputArg);
const rel = relative(reviewRoot, output);
assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'),
  'output must be inside this library work/acceptance');
const hashes: Record<string, string> = {};
for (const name of configurationFiles('llm-post-training', 'paper').slice(-4)) {
  hashes[name] = createHash('sha256').update(Buffer.from(await Bun.file(join(root, 'config', name)).arrayBuffer())).digest('hex');
}
const store = openReadOnlyStateStore(context.paths.databasePath);
try {
  const run = store.getRun(runId);
  assert.equal(run?.status, 'completed', 'sample only a completed run');
  const observed = store.listHarvestObservations(runId);
  const merged = new Map<string, PaperMetadata>();
  for (const { paper, track } of observed) {
    assert.ok(paper.baseId && paper.arxivId && paper.version);
    const prior = merged.get(paper.baseId);
    if (!prior || Number(paper.version) > Number(prior.version)) {
      merged.set(paper.baseId, { ...paper, matchedTracks: [track] });
    } else if (paper.version === prior.version) {
      prior.matchedTracks = [...new Set([...(prior.matchedTracks ?? []), track])];
    }
  }
  const all = [...merged.values()].map(paper => evaluateCandidate(paper, library.paperPolicy));
  const accepted = all.filter(decision => decision.accepted);
  const rank = (id: string) => createHash('sha256').update(`${runId}:${id}`).digest('hex');
  accepted.sort((a, b) => rank(a.paper.baseId!).localeCompare(rank(b.paper.baseId!)));
  const sample: typeof accepted = [];
  const used = new Set<string>();
  while (sample.length < 36) {
    let added = false;
    for (const track of library.tracks) {
      const candidate = accepted.find(item => !used.has(item.paper.baseId!) && item.paper.eligibleTracks.includes(track.id));
      if (!candidate) continue;
      used.add(candidate.paper.baseId!); sample.push(candidate); added = true;
      if (sample.length === 36) break;
    }
    if (!added) break;
  }
  const report = {
    libraryId: library.libraryId, runId, configSha256: hashes,
    uniqueObserved: merged.size, uniqueAccepted: accepted.length,
    sampleSize: sample.length, review: null,
    tracks: library.tracks.map(({ id }) => ({
      id, observed: [...merged.values()].filter(paper => paper.matchedTracks?.includes(id)).length,
      accepted: accepted.filter(item => item.paper.eligibleTracks.includes(id)).length,
    })),
    samples: sample.map(({ paper, reasons }) => ({
      baseId: paper.baseId, arxivId: paper.arxivId, title: paper.title, summary: paper.summary,
      sourceUrl: `https://arxiv.org/abs/${paper.arxivId}`,
      matchedTracks: paper.matchedTracks, reasons, judgment: null, rationale: null,
    })),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ runId, sampleSize: sample.length, output }));
} finally {
  store.close();
}
```
