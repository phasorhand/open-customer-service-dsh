# dsh 版完整进化子系统设计（对标 Python 原版 + 依赖 dsh agent loop）

> 状态：**设计文档** · 日期：2026-08-24 · 范围：核心完整对标（已与用户确认）

## 1. 目标与范围

让 dsh 版 OpenCS 完整对齐 Python 原版 `src/opencs/evolution/` 的进化子系统，
并且**进化能力构建在 dsh agent loop 之上**，而不是像 Python 版那样自建一套
agent 运行时。

**已确认范围（核心完整对标）：**
- ✅ **技能自策展**：低分对话 → 沉淀证据 → 生成新技能/技能更新草案 → 影子运行验证 → 提案 → 人工门禁 → 生效
- ✅ **回放差分器**：同输入重跑，对比新旧技能的行为差异，给人工审批提供证据
- ✅ **记忆维度**：dsh 已原生提供长期记忆，纳入提案维度
- ✅ **血缘追踪**：提案与来源会话、应用效果的关联追踪

**明确跳过：** 消融实验（数据化归因非核心路径，YAGNI）

## 2. 架构决策

### 2.1 不复制 Python 版「进化=影子重跑器 + 全套 L0 事件」

Python 版把进化做成了一套平行于生产 agent 的重放运行时：
`ReplayEngine`（重放 LLM 缓存 + 工具缓存 + 只读渠道）→ `ShadowRunner` →
`ReplayDiffer`（对比 baseline/replay 的事件流差异）。

**dsh 版的核心洞察**：dsh 的 agent 是**无状态投影**的——会话历史是一串事件，
回放就是 `replayFrames(events)` 的纯投影，不重跑 agent。这带来一个巨大的简化：
影子运行**不需要自建重放运行时**，只需要「同输入重跑一个全新 agent」来对比输出。

### 2.2 三条不变量（写进代码与测试）

1. **改变 agent 行为准则的提案永远需要人工确认**（Python 版一脉相承，已是 dsh 版现有立场）
2. **影子验证通过才进人工队列**：`INCONCLUSIVE` 阻止提案进门控（Python 版 `blocks_gate`）
3. **批准的就是发出的**：生效的原文是批准时看到的原文，不再过模型（dsh 版现有 HITL 已保证）

## 3. 组件设计

### 3.1 证据收集（EvaluationStore 增强）

复用现有 `src/evaluation/`，把评测结果补上「证据画像」：
- 低分命中项 → 记入 `evidence[]`（commitment_violation / tone_issue / no_progression / factual_gap）
- 关联 `source_conversation_id`

### 3.2 提案维度扩展（EvolutionStore 增强）

Python 版 `EvolutionDimension`：SKILL / MEMORY / CRM_TOOL / KNOWLEDGE / OUTREACH
dsh 版现状：`skill | knowledge | memory | cadence`

**对齐**：新增 `dimension` 元数据校验，把现有 4 维度校准到 Python 版语义
（skill=行为准则 · knowledge=事实来源 · memory=长期记忆 · cadence=节奏策略），
保留 gate 的「skill/cadence 强制人工」立场。

### 3.3 技能自策展 Handler（新）

- `skills/` 目录是 dsh 版技能来源（SKILL.md 格式）
- 低分会话命中 → 自动生成技能草案（`{{dimension}}`、`{{intent_signals}}`、`{{priority}}`）
- 写入 `skills/` 下的**待审子目录**（如 `skills/proposals/`，不入库技能加载）
- 提交提案 → 影子验证 → 门禁 → 批准后移入正式技能目录 → 触发技能热加载

### 3.4 影子运行器（新，核心复用 dsh agent loop）

```ts
interface ShadowRunner {
  run(proposal: Proposal): Promise<ShadowResult>
}
// 同输入重跑：创建一个全新的临时 agent（不持久化），喂低分会话的原始输入
// → 对比输出帧，判定 verdict
```

关键：**复用 `assembleHarness`**，影子 agent 用同一个 dsh agent loop + 技能加载器，
只是会话不持久化。

### 3.5 回放差分器（新）

- 输入：baseline 事件流（旧）+ replay 输出帧（新）
- 输出：`Verdict`（BADCASE_FIXED / BADCASE_REMAINS / NEW_REGRESSION / INCONCLUSIVE）+ 差异点列表
- 差异点分类：ACTION_CHANGED / CONTENT_CHANGED / TOOL_MISSING / TOOL_ADDED / LLM_OUTPUT_CHANGED

复用现有 `src/gateway/frames.ts` 的 `Frame` 类型（已是纯投影输出），
不需要像 Python 版那样重放工具/LLM 缓存。

### 3.6 血缘追踪（新）

现有 `ProposalStore` 已有 `source_conversation_id`。**轻量实现**定义如下：
- **数据模型**：复用现有 `proposals` 表 + 新增一条 `lineage` 事件表（`lineage_id, proposal_id, kind, detail, created_at`）
- **kind 取值**：`proposed`（来源会话）、`shadow_verified`（影子 verdict）、`applied`（生效）、`session_hit`（后续会话命中该技能）、`eval_feedback`（命中后的评测反馈）
- **查询**：给定提案 id → 一条事件时间线；给定技能 id → 反查所有相关提案
- **不建独立 DAG**：事件按时间线性追加，够「看来源 + 看效果」即可，不追踪跨提案依赖
- **Schema**：`proposals` 表已建，`lineage` 表随本次迁移新增

### 3.7 管理端（现有控制台增强）

- 提案卡片增加：来源会话链接、影子验证 verdict、差异点摘要
- 审批操作保持现有 approve/reject，新增「看影子对比」

## 4. 数据流（核心闭环）

```
客户对话 → EvaluationStore 评测 → 低分命中
  → SkillProposalHandler 生成技能草案 → skills/proposals/
  → 提案（含 evidence, source_conversation_id）
  → ShadowRunner 同输入重跑 → 回放差分器 → verdict
  → verdict=BADCASE_FIXED → 门禁（skill 维度强制人工）
  → 人工审批 → 生效 → 技能热加载 → 后续会话使用
  → LineageStore 记录：技能 → 会话 → 效果
```

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 影子运行失败（LLM 超时） | `INCONCLUSIVE`，阻止进门控，不阻塞主流程 |
| 低分会话无原始输入（无法重跑） | `INCONCLUSIVE`，跳过影子验证 |
| 提案证据不足 | 门禁直接驳回 |
| 技能草案格式非法 | 不入库，记错误并跳过 |

## 6. 测试策略

| 层 | 覆盖 |
|---|---|
| 单元 | ShadowRunner verdict 判定、差分器分类、skill handler 草案生成、门禁新增策略 |
| 集成 | 真实 assembleHarness：低分会话 → 提案 → 影子 → 门禁全链路 |
| 端到端 | 技能生效后命中行为变化（含回归防线：Python 版 4 个生产 bug） |

## 7. 部署影响

- 无新外部依赖（复用 SQLite、dsh agent loop、现有技能目录）
- `skills/proposals/` 待审目录需加入 `.gitignore`（不入库）
- 管理端零构建增强（现有单文件 console.ts 追加 JS）

## 7.5 消融实验预留（不实现，只留登记点）

**不实现**消融实验（明确范围外）。但留一个登记点，避免未来补时需要改架构：
- 技能 repo 的 `load()` 已按名字精确加载；影子运行/消融若需「排除某技能」，
  只需在 `load(names)` 调用处按名过滤即可（dsh 技能加载器无全局排除开关，但 `load()` 本身支持指定名列表）
- 消融实验语义 = 「同输入，A 技能开 / A 技能关，对比输出」——与影子运行的
  「同输入重跑」机制完全相同，未来只需把「换新技能」换成「排掉旧技能」

## 8. 与 Python 版对照表

| 子系统 | Python 版 | dsh 版 | 说明 |
|---|---|---|---|
| 评测 | evaluation/ | evaluation/（已对齐） | CS 三指标 |
| 提案+门禁 | evolution/ | evolution/（保留，扩展维度） | 立场一致 |
| 技能自策展 | evolution/handlers/skill.py | **新增** | 核心缺口 |
| 影子运行 | shadow_runner.py | **新增**（同输入重跑） | 依赖 dsh agent loop |
| 回放差分 | replay/differ.py | **新增**（复用 frames） | 不重放工具/LLM 缓存 |
| 血缘 | lineage/ | **新增**（轻量） | 不建独立 DAG |
| 消融实验 | ablation/ | 跳过（明确） | YAGNI |
