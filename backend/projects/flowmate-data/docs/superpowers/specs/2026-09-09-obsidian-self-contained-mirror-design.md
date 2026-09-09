# Obsidian 自包含发票镜像设计

## 背景

Flowmate 当前在 `D:\obsidian\data\flowmate-data` 生成 Markdown 卡片，但卡片中的原图、标注、字段、解析结果和 Release 清单仍通过 `file:///` 指向 `D:\paper\Invoice` 或 `D:\agent-data\data\flowmate-data`。Vault 因此不是可独立复制和浏览的数据副本。

## 目标

- 将发票任务的原图、发布方标注、统一字段、MinerU 解析结果、处理回执、记录和快照物理复制到 Obsidian Vault。
- 将 Release 清单和校验清单物理复制到 Vault。
- Markdown 中不再出现指向 `D:\paper\Invoice` 或 `D:\agent-data\data\flowmate-data` 的 `file:///` 跳转。
- 保留 Vault 内部的相对链接和图片嵌入，保证总览、数据集和发票卡片仍可导航。
- 保持 `D:\paper\Invoice` 为原始数据和解析镜像的权威副本，保持 `D:\agent-data\data\flowmate-data` 为机器记录和校验数据的权威副本。
- 复制过程具备路径边界、哈希校验、原子发布和重复执行能力。

## 非目标

- 不改变项目代码路径、原始数据根、机器数据根、备份根或 Vault 根配置。
- 不把本机 MinerU、代理或路径配置复制到 Vault。
- 不为无发布方标注的记录伪造 `annotation.json`、`fields.json` 或标签结论。
- 不改变现有 Release 的再分发策略。

## Vault 目录

```text
D:\obsidian\data\flowmate-data\
└─ Evidence\
   ├─ indexes\
   │  ├─ overview.md
   │  └─ voxel51.md
   ├─ invoices\
   │  └─ voxel51\
   │     └─ 000001\
   │        ├─ invoice.md
   │        ├─ original.jpg
   │        ├─ annotation.json
   │        ├─ fields.json
   │        ├─ record.json
   │        ├─ receipt.json
   │        ├─ snapshot.json
   │        ├─ content.md
   │        ├─ content.json
   │        ├─ pages.json
   │        ├─ parse.json
   │        └─ assets\
   └─ releases\
      └─ public-invoice-p0-v1\
         ├─ manifest.json
         └─ checksums.json
```

`annotation.json` 和 `fields.json` 只在记录具有发布方标注时出现。`content.md`、`content.json`、`pages.json`、`parse.json` 和解析资产来自已验证的 MinerU 规范化结果。文件名保持短且稳定，目录中的样本编号沿用数据根的持久化编号。

## 数据流

1. 获取阶段继续把来源原图和原始记录写入 `D:\paper\Invoice`，把机器记录、回执和选样清单写入 `D:\agent-data\data\flowmate-data`。
2. 标签阶段继续从机器记录验证发布方标注，并生成带哈希的统一字段。
3. MinerU 阶段继续把规范化结果和解析回执写入数据根，并由结构化快照逻辑在原始数据根发布可验证镜像。
4. Obsidian 构建阶段读取两套权威副本，生成 Markdown 页面，同时把页面引用的所有最终文件复制到 Vault 内的样本目录或 Release 目录。
5. 复制前验证来源路径必须位于对应权威根内、文件哈希与记录一致；复制后验证 Vault 文件字节和清单一致。
6. 复制和 Markdown 发布使用现有 Vault 锁、暂存目录、恢复目录和用户文件冲突保护。生成文件只替换同一生成器产生的文件，用户手写文件保持不变。

## 页面引用规则

- 发票卡片使用 Vault 内部相对路径或 Obsidian 嵌入，例如 `![[000001/original.jpg]]` 和 `[[000001/content.md]]`。
- 总览和数据集页面只链接 Vault 内部 Markdown 页面。
- Release 页面只链接 Vault 内部的 `Evidence/releases/<version>/manifest.json`。
- 来源主页和许可证证据可以作为普通 URL 元数据保留，但不能用本机绝对路径或 `file:///` 指向外部数据根。
- 构建结果中不得出现 `D:\paper\Invoice`、`D:\agent-data\data\flowmate-data` 或对应的 `file:///` 文件链接。

## 实现边界

- 扩展目录构建计划，使其能够描述文本文件和经验证的源文件副本；计划仍只接受 Vault 内相对路径。
- `buildCatalog` 为每个样本收集原图、记录、回执、快照、标注、字段和已验证解析文件，为 Release 收集清单文件。
- `applyCatalog` 在 Vault 锁和暂存目录内执行文本写入与二进制复制，并复用现有用户文件冲突、路径边界和原子替换逻辑。
- 数据资产复制使用独立的目标哈希校验，不创建指向权威根的符号链接或硬链接；目标已存在且字节相同时视为幂等，字节不同时拒绝覆盖用户文件或报告冲突。Markdown 继续复用目录生成器已有的 Vault 内原子发布机制。
- 既有只含 Markdown 的 Vault 可以通过一次 `catalog build` 补齐缺失副本；过期的 Flowmate 生成文件按现有清理规则移除，手写文件不删除。

## 无标注记录

无标注记录在 Vault 中保存原图、`record.json`、`receipt.json`、`snapshot.json` 和 MinerU 结果。它们的卡片明确显示 `publisher_annotation: unannotated`，不创建 `annotation.json`、`fields.json`，也不创建统一标签链接。

## 验证

- 单元测试验证样本和 Release 文件确实存在于 Vault，内容哈希与权威副本一致，构建结果不含外部 `file:///` 数据链接。
- 测试带标注和无标注样本的差异文件集合。
- 测试重复构建的字节稳定性、目标文件篡改检测、用户手写文件保护、路径逃逸和符号链接拒绝。
- 运行 Flowmate 类型检查和完整测试套件。
