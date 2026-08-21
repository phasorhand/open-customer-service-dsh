# OpenCS 基于 deepseek-harness 完全重写 · 调研报告

- 日期：2026-08-21
- 目标：把 `../open-customer-service`（Python / FastAPI，12.7k LOC，840 测试）完全重写为
  基于 **deepseek-harness（dsh）** 的 TypeScript 实现，落到 `../open-customer-service-dsh`
- 输入来源：
  1. `../open-customer-service` 全量源码盘点（16 个子模块、12 个 SQLite 库、40+ HTTP 路由）
  2. `../deepseek-harness` 官方文档 + 56 个 package 的能力盘点
  3. `../ai_mingtai_copilot` 已完成的 dsh 选型调研 + Phase-1 可运行实现（**直接复用其决策，不重做选型**）

---

## 0. 为什么这份调研可以「站在别人肩膀上」

`ai_mingtai_copilot` 是同一作者的另一个项目，已经在 2026-08-20 完成了
「自研 Agent 编排 vs 采用 dsh」的完整选型调研并落地了 Phase-1 可运行实现。
按 CLAUDE.md 的 OSS-First 原则，**该项目的选型结论对本项目直接生效**，本报告的工作是：

1. 复述并校验其结论（§1）
2. 补齐本项目特有的能力缺口调研——CS/CRM 域（§3、§4）
3. 给出 OpenCS 16 个模块逐一的「dsh 原生 / 薄封装 / 必须自建」判定（§5）

---

## 1. 框架选型：直接继承 ai_mingtai_copilot 的结论

### 1.1 已做过的对比（来源：`ai_mingtai_copilot/reference/techweek/pi-open-source-coding-agent-framework-comparison.md`）

| 候选 | License | 结论 | 理由 |
|---|---|---|---|
| **deepseek-harness (dsh)** | MIT | ✅ **采用** | everything-is-a-plugin（Cordis DI）；框架级提供 agent loop / tool pipeline / session 事件溯源 / subagent / approval / jobs / skill / MCP；Service 接口稳定优先于内部实现 |
| Pi | MIT | ❌ | 内核极简，Plan/Subagent/MCP/权限都要自建，等于把 dsh 已有的东西重写一遍 |
| LangGraph | MIT | ❌ | 通用编排图，不提供 session 事件树 / provider registry / 工具执行管线 / 审批；且是 Python，与「换语言重写」目标冲突 |
| Dify / FastGPT | 部分 BSL/受限 | ❌ | UI-first，无法 headless 内嵌；License 对商业自托管不友好 |
| OpenHands / OpenClaw | MIT | ❌ | 定位是 coding agent 产品而非可嵌入框架 |

### 1.2 校验：dsh 当前状态（2026-08-21 实测）

```
repo:    /Users/sunxing/Downloads/projects/deepseek-harness
版本:    0.1.0-rc.5（本地 checkout，lib/ 已构建）
npm:     @deepseek-ai/dsh-* 已公开发布，registry 最新 0.1.1-rc.1
License: MIT
包数量:  56 个 package 目录（core/llm/session/storage/skill/subagent/jobs/workflow/mcp/web/...）
最近提交: 47f9438 Merge PR #2519 feat/npm-public（2026-08 内）
```

对照 CLAUDE.md 的「否决硬性条件」逐条核验：

| 否决条件 | 判定 |
|---|---|
| 最近 commit > 18 个月 | ❌ 不成立（本月仍在发版） |
| 无 tagged release | ❌ 不成立（0.1.0-rc.5 / 0.1.1-rc.1 已发 npm） |
| 核心 API 与抽象冲突 | ❌ 不成立——见 §5，OpenCS 的 Orchestrator/ToolExecutor/ActionGuard 与 dsh 的 AgentLoop/ToolRuntime/pre-execute guard 是一一对应关系，是**收敛**而非冲突 |
| License 不兼容 | ❌ 不成立（MIT） |
| 12 个月内未修复 CVE | ❌ 未发现 |
| 依赖树 > 50MB / 引入无关重模块 | ⚠️ 需按需选包：只挂 headless 需要的 core/llm/session/tools，不挂 client/* 与 web GUI（那部分是浏览器 UI 插件树） |

**结论：采用 `deepseek-harness @ 0.1.0-rc.5`。**

### 1.3 依赖方式决策：`link:` 本地 checkout（而非 npm 版本号）

实测：

```bash
$ npm view @deepseek-ai/dsh-tools@0.1.0-rc.5 version   # → NOT-ON-NPM
$ npm view @deepseek-ai/dsh-agent-loop versions        # → ... 0.1.0-rc.8, 0.1.1-rc.1
```

npm 上只有 rc.6+ 与 0.1.1-rc.1，**本地 checkout 的 rc.5 未发布**。
本项目全部文档/调研是针对 rc.5 源码做的，跨版本盲跳有 API 漂移风险
（AGENTS.md 明确「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」）。

因此沿用 `ai_mingtai_copilot/impl` 已验证的方式——pnpm `link:` 指向本地 checkout：

```json
"@deepseek-ai/cordis": "link:../deepseek-harness/vendor/cordis",
"@deepseek-ai/dsh-tools": "link:../deepseek-harness/packages/core/tools"
```

- 优点：与我们读过的源码逐字一致；`lib/` 已构建，无需在本仓库跑 dsh 的 build
- 风险与对冲：仓库不自包含 → 在 README 记录 dsh commit SHA `47f943859b` + 版本 rc.5；
  写**契约测试**（`tests/contract/dsh-api.test.ts`）断言我们依赖的每个导出符号存在，
  升级 dsh 时先跑契约测试再跑全量回归
- 迁移路径：等 dsh 发布稳定版后，把 `link:` 换成精确版本号即可，代码零改动

---

## 2. dsh 能力盘点（只列本项目会用到的）

### 2.1 headless 内嵌方式

两条路，本项目选 **B（直接 Cordis 组装）**：

| 方式 | 说明 | 判定 |
|---|---|---|
| A. `boot()` + `cordis.yml` | `@deepseek-ai/dsh-app-boot` 读配置文件挂插件树，支持 bundle 分层与 profile patch | ❌ 引入 YAML 组合层与 profile 目录约定，对「一个 Node 服务进程」是过度设计 |
| **B. `new Context()` + `ctx.plugin()`** | 手写组装，显式挂载需要的 service | ✅ **采用**——`ai_mingtai_copilot/impl/src/harness/assemble.ts` 已验证可跑通 |

最小组装（实测可用的导出符号）：

```ts
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt, { persona: '...' })
await ctx.plugin(ToolRuntime, {})
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(LlmDeepSeek, {})
await ctx.plugin(JsonlSessionPersistence, { root: '.sessions' })
```

### 2.2 关键 service 与本项目的映射

| ctx service | 包 | OpenCS 用途 |
|---|---|---|
| `ctx.agents` | `dsh-agent` | 每会话一个 agent；`agents.create({ sessionId, agentOptions })` |
| `ctx.agentLoop` | `dsh-agent-loop` | 取代自研 Orchestrator 的 turn/step 驱动 |
| `ctx.tools` | `dsh-tools` | 取代自研 ToolRegistry + ToolExecutor；`defineTool` + guard 管线 |
| `ctx.llm` | `dsh-llm` | 取代 LiteLLMClient；adapter 注册制 |
| `ctx.sessions` | `dsh-session` | 取代 L0 原始事件库（append-only SessionEvent） |
| `ctx.sessionPersistence` | `dsh-session-persistence-{jsonl,sqlite}` | 取代 memory_l0.db 自建 schema |
| `ctx.systemPrompt` | `dsh-system-prompt` | `section({name, order, text})` 注入 persona/技能/画像 |
| `ctx.subagents` | `dsh-subagent` | 取代自研多 worker 路由（cs_reply / lead_qualifier） |
| `ctx.jobs` | `dsh-jobs` | 长任务（批量外呼草稿生成）背景作业 |
| `ctx.approval` | `dsh-user-approval` | 与 `tools/pre-execute` 一起取代 ActionGuard 的 HITL 分支 |
| `ctx.skills` | `dsh-skill` + `dsh-skill-filesystem` | 取代自研 SkillRepo 的 SKILL.md 加载 |
| `ctx.storageDomain` | `dsh-storage-domain` | 轻量 KV（persona 库、租户配置） |
| `ctx.compaction` | `dsh-compaction-basic` | 长会话压缩（自研版本完全没有，是净增能力） |
| `ctx.mcp` | `dsh-mcp-client` | 外部 MCP 工具零代码接入（自研版本没有，净增） |

### 2.3 工具协议：`defineTool` 的三段式输出

这是本次重写最重要的结构性收益。dsh 的工具输出天然分三层：

```ts
output: {
  schema:           // canonical value，运行时校验
  render(args, v)   // 给模型看的 ContentBlock[]（省 context）
  presentationMeta(args, v)  // 给 UI 的纯函数投影，随 tool/result 事件持久化
}
```

`presentationMeta` 必须是**纯函数**（禁 I/O、时钟、session 态），因此：
- 实时流式与历史回放共用同一份渲染逻辑，不会不同步
- **回放免费**：Admin UI 的卡片可以从 session 日志重建，不需要另存一份

对应 OpenCS：原来 `routes_*.py` 手写的 response model + web-ui 手写的展示组件，
统一收敛为 `presentationMeta` 投影。

### 2.4 治理管线：`tools/pre-execute` waterfall

```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (越权) return { kind: 'deny', reason: '...' }   // 短路
  if (高风险) return { kind: 'ask', reason: '...' }   // 走 approval
  return next()                                        // 委托下一个监听器
})
```

这正是 OpenCS `ActionGuard.evaluate()` 六档风险分级的框架级等价物，且：
- deny/ask 自动写入 session 事件 → 审计日志免费
- 多个 guard 可叠加（租户隔离 guard + 风险分级 guard + 频控 guard），职责分离

---

## 3. 能力缺口调研：dsh 不提供、OpenCS 必须自建的部分

dsh 是 **coding agent 框架**，不含任何 CS/CRM 业务语义。以下五块必须自建，
逐块调研了 OSS 等价物：

### 3.1 渠道网关（Channel Gateway）

| 候选 | License | 最近 commit | 判定 |
|---|---|---|---|
| [botpress/botpress](https://github.com/botpress/botpress) | MIT（部分模块受限） | 活跃 | ❌ 是完整 chatbot 平台，不是渠道 SDK；集成成本 > 自建 |
| [wechaty/wechaty](https://github.com/wechaty/wechaty) | Apache-2.0 | 活跃 | ⚠️ 个人微信为主，企业微信客服接口覆盖不全；且拉入 puppet 体系较重 |
| [node-wecom / @wecom/crypto](https://github.com/wecom/crypto) | MIT | 活跃 | ✅ **复用**——只做企微回调 AES 加解密与签名，体量小、职责单一 |
| 自建 ChannelAdapter 抽象 | — | — | ✅ **自建**——`parse_inbound / send / capabilities` 三方法接口，Python 版已验证形状正确 |

**决策**：渠道抽象自建（薄），加解密复用 `@wecom/crypto`。

### 3.2 CRM 联系人库与漏斗

| 候选 | License | 判定 |
|---|---|---|
| [twentyhq/twenty](https://github.com/twentyhq/twenty) | AGPL-3.0 | ❌ **License 否决**（CLAUDE.md 明确 AGPL 默认禁用） |
| [EspoCRM](https://github.com/espocrm/espocrm) | GPL-3.0 | ❌ License 否决 |
| [Erxes](https://github.com/erxes/erxes) | 自定义受限 | ❌ 非 OSI 开源 |
| 自建 ContactStore + 生命周期状态机 | — | ✅ **自建** |

**决策**：自建。理由已量化——三个主流 OSS CRM 全部 copyleft/受限 license，
且都是「整套产品」而非「可嵌库」，封装成本远大于 ~600 行 SQLite store。
OSS 等价物登记为 twenty（若未来 license 变更可评估切换）。

### 3.3 Cadence / 外呼节奏引擎

| 候选 | License | 判定 |
|---|---|---|
| `@deepseek-ai/dsh-schedule` | MIT | ❌ **能力不匹配**——实测其 README：session-scoped 提醒，为单个 live agent 的 `after/at/every` 定时 followup 设计，`every_seconds` 下限 5 分钟，状态存在 session 事件日志里。无法承载「5000 联系人 × 多步节奏 × 静默时段 × 频控」 |
| [BullMQ](https://github.com/taskforcesh/bullmq) | MIT | ⚠️ 强依赖 Redis；本项目 MVP 定位单进程 + SQLite 自托管，引入 Redis 抬高部署门槛 |
| [node-cron](https://github.com/node-cron/node-cron) | ISC | ✅ **复用**（可选）——仅用于「每 N 秒 tick」的定时器，替代手写 setInterval |
| 自建 NurtureEngine 五阶段 tick | — | ✅ **自建** |

**决策**：自建节奏引擎（Python 版已验证的 reap → exit → enrol → advance → drain 五阶段），
定时器用 node-cron 或原生 timer；发件箱租约（lease）机制自建。
**关键教训（来自 Python 版实测，S1277）**：LLM 组稿单条 ~40s，串行 50 条 = 33 分钟 >
300s 租约 → reaper 回收 → 重复骚扰。**并发 drain（8 路）是必需项，不是优化项。**

### 3.4 知识库检索

| 候选 | License | 判定 |
|---|---|---|
| SQLite FTS5（内置） | Public Domain | ✅ **复用**——Python 版已用，CJK 场景用 LIKE 兜底 |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Apache-2.0/MIT | ⚠️ 向量检索，v1 再评估（MVP 不做 embedding） |
| LlamaIndex.TS / LangChain.js | MIT | ❌ 体量超载，为一个 FTS 检索拉入整个 RAG 框架 |

**决策**：FTS5 复用；embedding 检索留到 v1，OSS 等价物登记 sqlite-vec。

### 3.5 评测 / 可观测

| 候选 | License | 判定 |
|---|---|---|
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | MIT（core） | ✅ **复用**——Python 版已接入，TS SDK `langfuse` 官方支持 |
| `@deepseek-ai/dsh-session-telemetry-otel` | MIT | ✅ **复用**——dsh 原生 OTel 导出，与 Langfuse OTel endpoint 对接 |
| 自建 EvalEngine（CS 三指标） | — | ✅ **自建**（业务语义，无 OSS 等价物） |

---

## 4. Python 版实战教训（必须带进重写）

来自 `../open-customer-service` 的生产冒烟记录（claude-mem S1277、Phase-14 REVIEW）：

| # | 教训 | 对重写的约束 |
|---|---|---|
| 1 | **身份混淆**：LLM 把「客户所在公司」读成自己的雇主，自称「我是晨光电商的小王」 | composer system prompt 必须有显式身份边界；`sender_persona` 贯穿 Cadence→Store→Engine→Composer→API 全链路 |
| 2 | **租约超时导致重复发送**：串行 LLM 组稿 40s × 50 = 33min > 300s lease | drain 必须并发；lease 时长与批大小要按「单条组稿耗时 × 批大小 / 并发度」推算 |
| 3 | **入站回复按手机号建重复联系人** | 渠道身份（channel_id + external_id）与业务身份（phone/email）必须分开，且有显式 link-identity 动作 |
| 4 | **无渠道身份的联系人被静默丢弃** | 必须有 unaddressable guard，显式失败而非静默跳过 |
| 5 | **测试 mock 与真实接口签名漂移**：composer 加 `sender_persona=` 参数后 7 个测试炸 | TS 版用类型系统兜住；且 mock 必须用同一份 interface 类型 |
| 6 | 大批量（1000+）首触必须用 template 模式，LLM 组稿只留给高价值跟进步骤 | Cadence step 保留 `template`（毫秒级）/ `goal`（LLM）双模式 |

---

## 5. 逐模块判定表：dsh 原生 / 薄封装 / 自建

| # | OpenCS 模块 | Python LOC 量级 | dsh 对应 | 判定 |
|---|---|---|---|---|
| 1 | `agents/`（Orchestrator + 2 worker + LLMClient） | 大 | `ctx.agentLoop` + `ctx.subagents` + `ctx.llm` | 🟢 **dsh 原生取代**——Orchestrator 三阶段循环完全由 AgentLoop 承担；worker → subagent |
| 2 | `harness/`（ActionGuard/Token/AuditLog/HITLQueue） | 中 | `tools/pre-execute` + `ctx.approval` + session 事件 | 🟢 **dsh 原生取代**——风险分级作为 guard 插件；审计 = session 日志；token 由 dsh 的 exec.token 承担 |
| 3 | `tools/`（Registry/Executor/APITool） | 中 | `ctx.tools` + `defineTool` | 🟢 **dsh 原生取代** |
| 4 | `memory/`（L0/L1/L2） | 中 | L0→`ctx.sessions`；L1→agent 内存；L2→自建 | 🟡 **部分取代**：L0/L1 由 dsh 承担；L2 结构化长期记忆自建（FTS5） |
| 5 | `skills/`（SkillRepo/Curator/Lineage） | 大 | `ctx.skills`（加载）+ 自建（curator/lineage） | 🟡 **薄封装 + 自建** |
| 6 | `replay/`（ReplayEngine/差分） | 中 | session 事件回放 + `dsh-llm-replay` | 🟡 **薄封装**——dsh 已有 replay adapter，差分器自建 |
| 7 | `channel/`（Registry/Adapter/WebChat/WeCom） | 中 | 无 | 🔴 **自建**（+ `@wecom/crypto`） |
| 8 | `crm/`（ContactStore/Service/Importer/Scoring/Segment） | 大 | 无 | 🔴 **自建** |
| 9 | `nurture/`（Engine/Store/Composer/Pacer） | 大 | 无（dsh-schedule 不匹配，见 §3.3） | 🔴 **自建** |
| 10 | `outreach/`（SendOutbox/EventStore） | 中 | 无 | 🔴 **自建** |
| 11 | `knowledge/`（Store/Ingestor/Parser） | 中 | 无 | 🔴 **自建**（FTS5 + chokidar + gray-matter） |
| 12 | `evolution/`（ProposalStore/Gate/ShadowRunner/Handlers） | 大 | 无 | 🔴 **自建** |
| 13 | `evaluation/`（Engine/Metrics/Store） | 中 | 无 | 🔴 **自建** |
| 14 | `lineage/` | 小 | 无 | 🔴 **自建** |
| 15 | `evolution/ablation/` | 中 | 无 | 🔴 **自建** |
| 16 | `gateway/`（FastAPI 40+ 路由） | 大 | 无（dsh 的 webserver 是浏览器 UI 插件树，不适用） | 🔴 **自建**（Fastify） |

**净效果估算**：模块 1/2/3 是 Python 版约 25% 的代码量，重写后由 dsh 承担 → 自研代码显著缩减，
且换来 dsh 原生的 compaction / MCP / subagent / 结构化回放等净增能力。

---

## 6. HTTP 层选型

| 候选 | License | 最近 commit | 判定 |
|---|---|---|---|
| [fastify/fastify](https://github.com/fastify/fastify) | MIT | 活跃 | ✅ **复用 v5**——原生 JSON Schema 校验（对齐 dsh 的 schema 风格）、性能好、插件体系、`@fastify/websocket` 官方 WS |
| [expressjs/express](https://github.com/expressjs/express) | MIT | 活跃 | ⚠️ 生态最大但无内建 schema 校验，需额外拼装 |
| [honojs/hono](https://github.com/honojs/hono) | MIT | 活跃 | ⚠️ 更适合 edge runtime，Node 生态插件（multipart/CSV 上传）不如 fastify 成熟 |

**决策：复用 `fastify @ ^5`** + `@fastify/websocket` + `@fastify/multipart`（CSV 导入）。

## 7. 其他依赖决策

| 用途 | 复用 | License | 理由 |
|---|---|---|---|
| SQLite | `node:sqlite`（Node 22+ 内置） | — | 零依赖；WAL 模式；退路 `better-sqlite3`(MIT) |
| Schema 校验 | `zod @ ^3` | MIT | dsh 用 schemastery，但我们自己的 HTTP/领域层用 zod 更主流；边界处转换 |
| Markdown frontmatter | `gray-matter` | MIT | SKILL.md / 知识库解析 |
| 文件监听 | `chokidar @ ^4` | MIT | 知识库热重载（Python 版用 watchdog） |
| CSV | `csv-parse` | MIT | 联系人批量导入 |
| 时区 | `Intl` + `@date-fns/tz` | MIT | 静默时段计算（Python 版用 pytz） |
| 测试 | `vitest @ ^3` | MIT | 与 dsh 同栈，减少工具链分裂 |
| Lint | `oxlint` | MIT | 与 dsh 同栈 |
| Admin UI | 沿用 Next.js 14 App Router | MIT | Python 版 `web-ui/` 可直接迁移（只改 API base），不重写 |

---

## 8. 风险登记

| 风险 | 等级 | 对冲 |
|---|---|---|
| dsh pre-release 破坏性变更 | 高 | 锁 SHA `47f943859b` + rc.5；契约测试 `tests/contract/dsh-api.test.ts`；升级走全量回归 |
| `SESSION_FORMAT_VERSION = 0` 无兼容承诺 | 中 | session 只做「当前运行期」审计源；跨版本长期数据落自建 SQLite（审计/联系人/发件箱） |
| `link:` 依赖使仓库不自包含 | 中 | README 记录 checkout 步骤 + SHA；CI 中先 clone dsh 再 pnpm install |
| 一次性重写 16 模块风险高 | 高 | 分 7 个 Phase，每 Phase 有可运行验收（见 plan）；先打通「入站 → 回复」最小闭环 |
| 并发 drain 的 LLM 限流 | 中 | 并发度可配；失败退避；template 模式作为大批量首触默认 |

---

## 9. 结论

1. **采用 dsh @ 0.1.0-rc.5，`link:` 本地 checkout**，锁 SHA + 契约测试对冲破坏性变更
2. **headless 内嵌用 `new Context()` + `ctx.plugin()`**，不引入 `boot()`/cordis.yml 组合层
3. **agents / harness / tools 三个模块由 dsh 原生取代**，是本次重写的主要结构性收益
4. **CS/CRM 业务语义（channel/crm/nurture/outreach/knowledge/evolution/evaluation/lineage/ablation/gateway）全部自建**，
   三个主流 OSS CRM 因 AGPL/GPL/受限 license 被否决
5. **卡片/展示层统一收敛为 `defineTool` 的 `presentationMeta`**，回放免费
6. **风险治理收敛为 `tools/pre-execute` guard 插件链**，审计 = session 事件日志
7. HTTP 用 fastify，测试用 vitest，与 dsh 同栈

下一步：Spec（`docs/superpowers/specs/2026-08-21-opencs-dsh-design.md`）。
