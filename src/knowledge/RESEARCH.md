# knowledge · OSS 调研

## 目标
把企业的 Markdown 手册变成 agent 可检索的知识库：解析分块 → 索引 → 全文检索 → 文件变更热重载。

## 候选对比

### 检索引擎

| 候选 | License | 最近 commit | Stars | 体量 | 评分 | 备注 |
|---|---|---|---|---|---|---|
| SQLite FTS5（`node:sqlite` 内置） | Public Domain | 持续 | — | 0（内置） | ✅ | 零依赖；与本项目其他持久化同库同事务；CJK 需配合 LIKE 兜底 |
| [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) | Apache-2.0 / MIT | 2026 活跃 | 5k+ | ~1MB | ⏸ | 向量检索，能力更强但 MVP 不做 embedding（需要额外的 embedding 调用与成本）。**登记为 v1 切换目标** |
| [run-llama/LlamaIndexTS](https://github.com/run-llama/LlamaIndexTS) | MIT | 活跃 | 2k+ | 大 | ❌ | 体量超载——为一个 FTS 检索拉入整个 RAG 框架及其 provider 抽象 |
| [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs) | MIT | 活跃 | 13k+ | 大 | ❌ | 同上；且其检索抽象与 dsh 的工具管线概念重叠，双份抽象 |
| [typesense/typesense](https://github.com/typesense/typesense) | GPL-3.0 | 活跃 | 21k+ | — | ❌ | License 否决（GPL）；且需独立服务进程，抬高自托管门槛 |
| [meilisearch/meilisearch](https://github.com/meilisearch/meilisearch) | MIT | 活跃 | 47k+ | — | ❌ | 独立服务进程；MVP 单进程自托管场景下运维成本 > 收益 |

### Markdown 解析

| 候选 | License | 最近 commit | 体量 | 评分 | 备注 |
|---|---|---|---|---|---|
| [jonschlinkert/gray-matter](https://github.com/jonschlinkert/gray-matter) | MIT | 稳定 | ~40KB | ✅ | 只做 frontmatter 解析，职责单一；Python 版用的 `python-frontmatter` 的等价物 |
| [remarkjs/remark](https://github.com/remarkjs/remark) | MIT | 活跃 | 中 | ⏸ | AST 级解析，能力过剩——我们只需要按 `##` 切段，不需要完整 mdast |
| 自建 frontmatter 解析 | — | — | — | ❌ | YAML 解析自建是明显的造轮子 |

### 文件监听

| 候选 | License | 最近 commit | 评分 | 备注 |
|---|---|---|---|---|
| [paulmillr/chokidar](https://github.com/paulmillr/chokidar) @4 | MIT | 活跃 | ✅ | 跨平台一致性优于原生 `fs.watch`（macOS 的 fsevents 语义差异）；Python 版 `watchdog` 的等价物 |
| `node:fs.watch` | — | — | ❌ | 平台差异大：macOS 上重命名/原子写会漏事件，编辑器保存常被漏掉 |

## 决策

- **复用**：`SQLite FTS5`（`node:sqlite` 内置）做倒排索引，封装在 `src/knowledge/store.ts`
- **复用**：`gray-matter @ ^4` 解析 frontmatter，封装在 `src/knowledge/parser.ts`
- **复用**：`chokidar @ ^4` 监听文件变更，封装在 `src/knowledge/ingestor.ts`
- **自建**：按 `##` 标题分块的切分逻辑（~80 行）
  - 理由：这是**业务语义**——「一个二级标题 = 一个可独立回答的知识单元」，
    通用 splitter（按 token 数切）会把一条政策切成两半，检索命中后答不完整。
    remark 能给 AST 但切分策略仍要自己写，多一层依赖不换来实质收益。

## CJK 检索的特殊处理

FTS5 默认 tokenizer 按空白/标点切词，中文整句会被当成一个 token，
「退款」查不到「申请退款流程」。处理方式（与 Python 版一致）：

1. FTS5 用 `unicode61` tokenizer 建索引，负责英文/数字/混排
2. **中文查询走 LIKE 兜底**：`content LIKE '%退款%' OR heading_path LIKE '%退款%'`
3. 两路结果合并去重，标题命中权重高于正文

v1 切到 sqlite-vec 后，这一层可由向量检索取代。

## 集成边界

暴露给项目其他部分的只有 `KnowledgePort`（`src/harness/ports.ts` 已定义）：

```ts
interface KnowledgePort {
  search(tenantId: string, query: string, limit: number): Promise<readonly KnowledgeHit[]>
}
```

`SqliteKnowledgeStore` 实现它。**工具层只认这个接口**，因此 P1 的内存桩、
本阶段的 FTS5 实现、未来的 sqlite-vec 实现可以互换，工具代码零改动。

`KnowledgeIngestor` 不暴露给工具层——它是运行时的后台组件，由 `runtime.ts` 拉起。

## 升级与停机预案

- **FTS5**：随 SQLite 走，无停更风险
- **gray-matter**：已稳定多年、无活跃开发但也无需求变更；停更不影响（frontmatter 格式冻结）。
  替代路径：`js-yaml` + 20 行手写分隔符解析
- **chokidar**：停更时可退回 `node:fs.watch` + 500ms 防抖轮询兜底（已在 ingestor 里留了防抖层）
- **sqlite-vec 切换路径**：新增 `VectorKnowledgeStore implements KnowledgePort`，
  与 FTS5 版并行跑一段时间对比召回，再切换 `runtime.ts` 里的一行装配
