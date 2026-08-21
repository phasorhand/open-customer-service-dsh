# OpenCS-DSH 设计规格

- 日期：2026-08-21
- 上游调研：`docs/superpowers/research/2026-08-21-dsh-rewrite-research.md`
- 目标产物：`/Users/sunxing/Downloads/projects/open-customer-service-dsh`
- 一句话：把 OpenCS（Python/FastAPI）完全重写为 **TypeScript + deepseek-harness 内嵌**的自托管 AI 客服/增长 Agent。

---

## 1. 设计原则（不可协商）

1. **Agent 运行时不自建**——turn 循环、工具调用管线、会话事件溯源、审批、subagent 全部走 dsh 的 `ctx.*` 服务。
   自研代码只出现在「dsh 没有业务语义」的地方。
2. **只依赖 `ctx.*` 服务接口**，不 import dsh 的 `src/**` 内部实现；契约测试锁住依赖面。
3. **Model-visible ⟺ logged**：任何进入模型请求的内容（persona、技能正文、联系人画像）
   必须有对应的 session 事件，否则回放不成立。
4. **LLM 永不直接执行不可逆动作**：发消息 / 改生命周期 / 写标签一律经 `defineTool` 收口，
   由 `tools/pre-execute` guard 链做租户隔离 + 风险分级 + 频控。
5. **展示层不自建协议**：卡片 = `defineTool` 的 `output.presentationMeta`（纯函数），回放免费。
6. **业务持久化与 session 日志分离**：session 是「运行期审计源」（格式版本 0，无兼容承诺）；
   联系人 / 发件箱 / 提案 / 审计等长期数据落自建 SQLite。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/admin-web   Next.js 14（从 Python 版迁移，仅改 API base）      │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP / WS
┌───────────────────────────▼─────────────────────────────────────┐
│ src/gateway   Fastify 5                                          │
│  · /channels/webchat  /channels/wecom   入站 webhook             │
│  · /admin/**                            管理 API                 │
│  · /ws/conversations/:id                前端流式帧                │
│  · /health/live  /health/ready                                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│ src/runtime   组合根：assembleRuntime()                           │
│   OpenCSRuntime = { ctx, stores, services, channels, nurture }   │
└──────┬────────────────────────────────────────┬─────────────────┘
       │                                        │
┌──────▼──────────────────────────┐   ┌─────────▼───────────────────┐
│ dsh Context（内嵌，同进程）        │   │ 自研业务层（TypeScript）       │
│  ctx.agents / agentLoop          │   │  channel/  渠道网关           │
│  ctx.tools（defineTool + guard） │◄──┤  crm/      联系人 · 漏斗       │
│  ctx.llm（DeepSeek / OpenAI 兼容）│   │  nurture/  节奏引擎           │
│  ctx.sessions + persistence      │   │  outreach/ 发件箱 · 事件       │
│  ctx.systemPrompt（section 注入） │   │  knowledge/ FTS5 知识库       │
│  ctx.subagents（worker 委托）     │   │  skills/   技能库 · 策展       │
│  ctx.skills（SKILL.md 加载）      │   │  memory/   L2 长期记忆        │
│  ctx.jobs（背景作业）             │   │  evolution/ 提案 · 门禁        │
│  ctx.compaction（长会话压缩）      │   │  evaluation/ CS 三指标        │
└──────────────────────────────────┘   │  lineage/  血缘 DAG          │
                                       │  replay/   回放差分            │
                                       └────────────────────────────────┘
```

---

## 3. 仓库结构

```
open-customer-service-dsh/
├── package.json                 pnpm，type: module，Node ≥ 22
├── tsconfig.json                strict + NodeNext
├── vitest.config.ts
├── .env.example
├── docker-compose.yml
├── docs/superpowers/{research,specs,plans}/
├── knowledge/                   Markdown 知识库（冷启动）
├── skills/                      SKILL.md 技能库
├── src/
│   ├── main.ts                  进程入口
│   ├── config.ts                环境变量 → RuntimeConfig（zod 校验）
│   ├── runtime.ts               组合根 assembleRuntime()
│   ├── harness/                 ── dsh 内嵌层 ──
│   │   ├── assemble.ts          Context + 插件挂载
│   │   ├── session-scope.ts     sessionId → TenantScope 绑定
│   │   ├── plugins/
│   │   │   ├── tools-cs.ts      客服工具集（channel.reply / knowledge.search / ...）
│   │   │   ├── tools-crm.ts     CRM 工具集（contact.get / contact.update_stage / ...）
│   │   │   ├── tools-evolution.ts 演进工具（evolution.propose）
│   │   │   ├── guard-scope.ts   租户隔离 guard
│   │   │   ├── guard-risk.ts    六档风险分级 guard（ActionGuard 的等价物）
│   │   │   └── prompt-sections.ts persona / 技能索引 / 画像注入
│   │   ├── mock-llm.ts          离线确定性 adapter（无 API key 时自动启用）
│   │   └── cards.ts             presentationMeta 卡片类型定义
│   ├── channel/                 渠道网关（自建）
│   ├── crm/                     联系人 · 生命周期 · 分群 · 导入（自建）
│   ├── nurture/                 节奏引擎（自建）
│   ├── outreach/                发件箱 · 投递事件（自建）
│   ├── knowledge/               FTS5 知识库 + 文件监听（自建）
│   ├── skills/                  技能库 + 策展（薄封装 ctx.skills + 自建 curator）
│   ├── memory/                  L2 结构化长期记忆（自建）
│   ├── evolution/               提案 · 演进门禁 · 影子回放（自建）
│   ├── evaluation/              CS 指标 · 评测存储（自建）
│   ├── lineage/                 血缘 DAG（自建）
│   ├── replay/                  会话回放差分（薄封装）
│   ├── gateway/                 Fastify 路由（自建）
│   └── db/                      SQLite 连接池 + migration runner
├── tests/
│   ├── contract/dsh-api.test.ts  ★ dsh 依赖面契约测试
│   ├── unit/**                   与 src/ 镜像
│   └── e2e/**                    端到端旅程
└── apps/admin-web/               Next.js 14（迁移自 Python 版 web-ui/）
```

---

## 4. dsh 内嵌层设计

### 4.1 组装（`src/harness/assemble.ts`）

```ts
export async function assembleHarness(cfg: RuntimeConfig, deps: HarnessDeps): Promise<Harness> {
  const ctx = new Context()

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })

  // LLM：有 key 走真实 provider，无 key 走确定性 mock（离线开发/CI 全绿）
  const model = resolveModel(cfg)          // deepseek-official | openai-compatible | opencs-mock
  if (model.kind === 'deepseek') await ctx.plugin(LlmDeepSeek, {})
  if (model.kind === 'openai')   await ctx.plugin(LlmPiAi, { baseUrl: cfg.llm.baseUrl })
  await ctx.plugin(OpenCSMockLlm)          // 永远挂，作为兜底

  // 持久化：session 事件 = 运行期审计源
  await ctx.plugin(SqliteSessionPersistence, { path: cfg.paths.sessionsDb })

  // 业务插件（全部只用 ctx.* 接口）
  await ctx.plugin(PromptSections, deps)   // persona / 技能索引 / 联系人画像
  await ctx.plugin(CsTools, deps)
  await ctx.plugin(CrmTools, deps)
  await ctx.plugin(EvolutionTools, deps)
  await ctx.plugin(ScopeGuard, deps)       // 先挂：租户隔离最外层
  await ctx.plugin(RiskGuard, deps)        // 后挂：风险分级

  return { ctx, model, agentFor, runTurn }
}
```

**Agent 生命周期**：一个 `conversation_id` 对应一个常驻 agent + session；
`agentFor(scope)` 首次创建时 `bindScope(sessionId, scope)`，之后复用。
超长会话由 `dsh-compaction-basic` 压缩（Python 版没有此能力，净增）。

### 4.2 租户/会话作用域（`session-scope.ts`）

```ts
export interface TenantScope {
  readonly tenantId: string
  readonly conversationId: string
  readonly channelId: string
  readonly customerId: string
  readonly contactId?: string
}
```

`sessionId → TenantScope` 注册表。工具 execute 内通过 `exec.agent.session.id` 反查；
**guard 与 tool 双重校验**（纵深防御，与 ai_mingtai_copilot 的 claims 模式一致）。

### 4.3 风险治理：`ActionGuard` → guard 插件链

Python 版的六档 `RiskTier` 保留为**工具的静态声明**，由 `guard-risk.ts` 统一裁决：

| 档 | 名称 | 决策 | 典型工具 |
|---|---|---|---|
| 0 | GREEN | allow | `knowledge.search` `contact.get` `crm.get_order` |
| 1 | YELLOW | allow | `memory.write_l2` `contact.add_note` |
| 2 | ORANGE_A | allow（模板，频控） | `channel.send_template` |
| 3 | ORANGE_B | allow（频控 + 事后审计） | `nurture.deliver`（节奏外呼） |
| 4 | ORANGE_C | **ask** → HITL | `channel.reply`（自由文本回复）默认档 |
| 5 | RED | **ask** → HITL | `contact.mark_won` `crm.write_external` |

```ts
// guard-risk.ts
ctx.on('tools/pre-execute', async (exec, next) => {
  const tier = RISK_TIERS[exec.name] ?? RiskTier.ORANGE_C   // 未登记 = 保守档
  if (tier >= RiskTier.ORANGE_C && !autoApproveEnabled(tier))
    return { kind: 'ask', reason: `风险档 ${RiskTier[tier]} 需人工确认` }
  if (tier === RiskTier.ORANGE_B && !rateLimiter.allow(exec)) 
    return { kind: 'deny', reason: '触发频控上限' }
  return next()
})
```

**审计日志 = session 事件**（`tool/call` / `tool/result` / `approval/*` 天然入库），
另建 `audit` 表只存「跨会话可查询投影」（action_id / tool / tier / decision / actor / ts）。

### 4.4 工具即卡片（`cards.ts` + `presentationMeta`）

```ts
ctx.tools.register(defineTool({
  name: 'contact.segment_preview',
  description: '按筛选条件预览命中的联系人',
  parameters: { filter: { type: 'object', required: true }, limit: { type: 'integer', default: 20 } },
  output: {
    schema: SEGMENT_VALUE_SCHEMA,
    render: (_a, v) => [{ type: 'text', text: `命中 ${v.total} 位联系人` }],  // 模型只看摘要
    presentationMeta: (_a, v) => ({                                          // UI 看完整卡片
      protocolVersion: 1, type: 'contact_segment',
      title: `命中 ${v.total} 位联系人`, items: v.preview, actions: [...],
    }),
  },
  async execute(args, exec) { /* 走 store，scope 从 exec.agent.session.id 反查 */ },
}))
```

卡型（v1 六种）：`cs_reply` `contact_segment` `contact_profile` `knowledge_hit`
`cadence_stats` `proposal_review`。

### 4.5 多 worker → subagent

Python 版的 `CSReplyWorker` / `LeadQualifierWorker` 改为：

- **主 agent**：意图理解 + 回复生成（挂全部只读工具 + `channel.reply`）
- **`lead_qualifier` subagent**（one-shot）：判定生命周期阶段跃迁，工具白名单
  在 spawn 时固化为 `['contact.get', 'contact.update_stage']`——**提示注入无法越权**
- **`outreach_composer` subagent**（one-shot）：节奏步骤组稿

技能选择保留 Python 版验证过的**两轮法**：
Round 1 注入紧凑技能索引（`ctx.systemPrompt.section`）→ 模型输出 `[SKILLS: a, b]`；
Round 2 注入选中技能正文 → 生成最终回复。

---

## 5. 数据模型（自建持久化）

单文件 SQLite（WAL），按域分库，migration 用编号 SQL 文件：

| 库 | 表 | 说明 |
|---|---|---|
| `crm.db` | `contacts` `contact_events` | 联系人 + 追加式时间线 |
| `nurture.db` | `cadences` `cadence_steps` `cadence_runs` `sends` `delivery_receipts` | 节奏 + 运行 + 发件箱 |
| `knowledge.db` | `knowledge_chunks` + FTS5 | Markdown 分块 |
| `memory.db` | `l2_entries` + FTS5 | 结构化长期记忆 |
| `evolution.db` | `proposals` `crm_configs` `hitl_queue` | 提案 + 门禁 |
| `eval.db` | `eval_results` | 指标结果 |
| `lineage.db` | `lineage_edges` | 血缘 DAG |
| `audit.db` | `audit_entries` | 跨会话审计投影 |
| `sessions.db` | dsh 自有 schema | **由 dsh 管理，不动** |

### 5.1 Contact（核心不变量）

```ts
type LifecycleStage = 'new' | 'engaged' | 'qualified' | 'opportunity' | 'customer'
                    | 'disqualified' | 'churned'
type LeadStatus = 'not_contacted' | 'contacted' | 'replied' | 'in_progress'
                | 'unresponsive' | 'opted_out' | 'won' | 'lost'
```

- `lifecycle_stage` **单调**（`new < engaged < qualified < opportunity < customer`），
  `disqualified` / `churned` 为终态出口；回退需显式 `force` + RED 档审批
- **身份三分**（Python 版教训 #3/#4）：
  - 业务身份 `dedup_key`（email/phone 归一化）
  - 渠道身份 `(channel_id, external_id)` — 独立唯一索引，一个联系人可挂多渠道
  - 会话身份 `conversation_id`
  - 无任何渠道身份的联系人 → `unaddressable`，外呼时**显式失败**并记事件，绝不静默跳过

### 5.2 Cadence / Send（并发与幂等）

- `sends` 唯一约束 `(cadence_run_id, step_order)` → 天然幂等，重复 materialize 无副作用
- 租约字段 `worker_id` / `lease_until`；`drain` **并发 8 路**（可配 `NURTURE_DRAIN_CONCURRENCY`）
- 租约时长按 `单条组稿耗时 × 批大小 ÷ 并发度 × 安全系数` 计算，写进配置注释
- step 双模式：`template`（毫秒级，大批量首触默认）/ `goal`（LLM 组稿，高价值跟进）
- `sender_persona` 贯穿 Cadence → Store → Engine → Composer → API 全链路（教训 #1）

### 5.3 NurtureEngine 五阶段 tick（保持 Python 版已验证形状）

```
reap（回收过期租约） → exit（退出条件） → enrol（自动入组）
  → advance（到期步骤 materialize 进发件箱） → drain（并发投递 + 静默时段 + 频控）
```

---

## 6. HTTP 接口

保持与 Python 版路径**逐一对齐**（Admin UI 零改动迁移），仅补充 dsh 带来的新能力：

| 分组 | 路径 | 变化 |
|---|---|---|
| 健康 | `/health/live` `/health/ready` | 不变 |
| 渠道 | `POST /channels/webchat` `POST /channels/wecom/callback` | 路径微调（原 `/chat/message` `/wecom/callback`），保留旧路径别名 |
| 会话流 | `WS /ws/conversations/:id` | **新增**——转发 session 事件为帧（`text/delta` `card/open` `card/item` `card/close` `tool/status`） |
| 提案 | `/admin/proposals*` `/admin/audit-log` `/admin/stats` | 不变 |
| 联系人 | `/admin/tenants/:t/contacts*` | 不变（funnel / import / segment-preview / link-identity） |
| 节奏 | `/admin/tenants/:t/cadences*` | 不变 |
| 技能 · 知识 · 血缘 · 评测 · 消融 · 战役 | 同 Python 版 | 不变 |
| 回放 | `POST /admin/replay` + **`GET /admin/sessions/:id/events`** | 新增 session 事件查询（dsh 原生） |

---

## 7. 配置

```
OPENCS_ENV=development|test|production
OPENCS_DATA_DIR=./data
OPENCS_KNOWLEDGE_DIR=./knowledge
OPENCS_SKILLS_DIR=./skills
OPENCS_TENANT_ID=default
OPENCS_PORT=8080

# LLM：三选一，均无则自动降级为确定性 mock
DEEPSEEK_API_KEY=            # → dsh-llm-deepseek
OPENAI_API_KEY=              # → dsh-llm-pi-ai（OpenAI 兼容网关）
OPENAI_BASE_URL=
OPENCS_MODEL=deepseek-chat

# 治理
OPENCS_ACTION_TOKEN_SECRET=  # 生产必填，≥32 字节
OPENCS_AUTO_APPROVE_TIERS=0,1,2,3   # 高于此档走 HITL

# 节奏
OPENCS_NURTURE_ENABLED=true
OPENCS_NURTURE_POLL_INTERVAL=60
OPENCS_NURTURE_DRAIN_CONCURRENCY=8
OPENCS_NURTURE_LEASE_SECONDS=300

# 渠道
WECOM_CORP_ID= WECOM_TOKEN= WECOM_ENCODING_AES_KEY=

# 观测（可选）
LANGFUSE_HOST= LANGFUSE_PUBLIC_KEY= LANGFUSE_SECRET_KEY=
```

`config.ts` 用 zod 校验，**生产环境配置错误 fail loud**，不静默降级。

---

## 8. 测试策略

| 层 | 工具 | 门禁 |
|---|---|---|
| 契约 | vitest | `tests/contract/dsh-api.test.ts` 断言依赖的每个 dsh 导出存在且形状正确 |
| 单元 | vitest | 与 `src/` 镜像；纯函数（pacer / segment / lifecycle / cards）100% 分支 |
| 集成 | vitest | 真实 `assembleHarness()` 启动，**不允许只 mock Context** |
| E2E | vitest | 入站→回复、导入→节奏→成单、提案→门禁→审批、回放一致性 |
| 冒烟 | `pnpm smoke` | 离线 mock LLM 跑通全链路，CI 无 key 也全绿 |

**Mock 与真实接口用同一份 TS interface**（教训 #5，类型系统兜住漂移）。

---

## 9. 明确不做的事

- ❌ 不引入 `boot()` / `cordis.yml` / bundle profile 组合层（对单服务进程是过度设计）
- ❌ 不挂 dsh 的 `client/*` 浏览器 UI 插件树、TUI、sandbox、shell、fs、lsp、code-runtime
  （coding agent 专用能力，与客服场景无关且拉大依赖树）
- ❌ 不做向量检索（v1 再评估 sqlite-vec），MVP 用 FTS5
- ❌ 不重写 Admin UI，Next.js 14 直接迁移
- ❌ 不做多租户 RBAC 完整方案（v1），MVP 用 `tenant_id` + scope guard
- ❌ 不迁移 Python 版的历史 SQLite 数据（全新部署；如需迁移另立 phase）

---

## 10. 取舍决策记录

| 决策 | 选择 | 放弃的方案 | 理由 |
|---|---|---|---|
| Agent 运行时 | dsh 内嵌 | 自研 Orchestrator | 25% 自研代码由框架承担，且净增 compaction/MCP/subagent/回放 |
| dsh 依赖方式 | `link:` 本地 checkout + SHA 锁 | npm 版本号 | rc.5 未发 npm；npm 最新 rc.8/1.1 有 API 漂移风险 |
| dsh 装配 | `new Context()` 手写 | `boot()` + cordis.yml | 单进程服务不需要 YAML 组合层与 profile 目录 |
| HTTP | Fastify 5 | Express / Hono | 内建 JSON Schema 校验 + 官方 WS/multipart 插件 |
| CRM 底座 | 自建 SQLite | twenty / EspoCRM / Erxes | 全部 AGPL/GPL/受限 license，且是整套产品非可嵌库 |
| 节奏调度 | 自建五阶段 tick | `dsh-schedule` / BullMQ | dsh-schedule 是 session 级提醒（下限 5 分钟）；BullMQ 强依赖 Redis 抬高自托管门槛 |
| 卡片协议 | `presentationMeta` | 自建协议层 | 回放免费，实时与历史共用同一纯函数 |
| 风险治理 | guard 插件链 | 保留 ActionGuard 类 | deny/ask 自动入 session 日志，多 guard 职责分离可叠加 |
| 长期数据 | 自建 SQLite | 全放 session 日志 | `SESSION_FORMAT_VERSION=0` 无兼容承诺，长期数据不能押在上面 |

---

## 11. 验收标准（全部满足才算重写完成）

1. `pnpm smoke` 离线（无任何 API key）全绿：入站消息 → 技能选择 → 工具调用 → 卡片 → 回放一致
2. 越权租户请求被 guard 拒绝，且不产生业务卡片；拒绝事件可从 session 日志查到
3. CSV 导入 500 联系人 → 创建节奏 → 激活 → 自动入组 → 并发投递 → 回复退出，全自动无人工介入
4. 提案 → 影子回放 → 门禁 → HITL 审批 → 生效，链路可跑通
5. `pnpm typecheck` + `pnpm lint` + `pnpm test` 全绿；契约测试覆盖全部 dsh 依赖符号
6. HTTP 接口与 Python 版路径对齐，`apps/admin-web` 仅改 API base 即可工作
7. 真实 LLM（DeepSeek）端到端冒烟通过，且**不复现** Python 版四个生产 bug（身份混淆 / 租约超时重发 / 重复联系人 / 静默丢弃）

---

下一步：Plan（`docs/superpowers/plans/2026-08-21-phase*.md`）。
