# OpenCS-DSH 重写 · 总计划

- 上游：`../research/2026-08-21-dsh-rewrite-research.md`、`../specs/2026-08-21-opencs-dsh-design.md`
- 原则：每个 Phase 结束必须**可运行 + 测试全绿**，不允许「半成品堆积到最后一次性调通」

## Phase 总览

| Phase | 名称 | 交付 | 依赖 |
|---|---|---|---|
| **P0** ✅ | 骨架与契约 | pnpm 工程 + dsh link + 契约测试 + config + db migration runner | — |
| **P1** ✅ | dsh 内嵌最小闭环 | assembleHarness + 1 工具 + guard + mock LLM + smoke | P0 |
| **P2** ✅ | 渠道与网关 | ChannelAdapter + WebChat + Fastify + WS 帧 + 入站→回复端到端 | P1 |
| **P3** ✅ | 知识库与技能 | FTS5 知识库 + SKILL.md + 两轮技能选择 + prompt sections | P2 |
| **P4** | CRM 与记忆 | ContactStore/Service/Importer/Segment + L2 记忆 + CRM 工具集 | P2 |
| **P5** | 节奏与外呼 | SendOutbox + CadenceStore + NurtureEngine + Composer + subagent | P4 |
| **P6** | 演进与评测 | Proposal/Gate/ShadowRunner + EvalEngine + Lineage + Replay + Ablation | P3,P4 |
| **P7** | 管理端与交付 | 全量 Admin API + Next.js 迁移 + WeCom + docker-compose + README | P5,P6 |

---

## P0 · 骨架与契约

**目标**：一个能 `pnpm test` 的空工程，且 dsh 依赖面被契约测试锁死。

- [x] T0.1 `package.json`：pnpm、`type: module`、Node ≥22；scripts = dev/build/typecheck/lint/test/smoke
- [x] T0.2 dsh 依赖以 `link:../deepseek-harness/...` 写入；README 记录 SHA `47f943859b` @ rc.5
- [x] T0.3 `tsconfig.json`（strict, NodeNext, noEmit）、`vitest.config.ts`、`.oxlintrc.json`、`.gitignore`
- [x] T0.4 `src/config.ts`：zod schema → `RuntimeConfig`；生产缺失必填项 fail loud
- [x] T0.5 `src/db/`：SQLite 连接工厂（WAL）+ 编号 migration runner + `openDb(name)` API
- [x] T0.6 `tests/contract/dsh-api.test.ts`：断言 `Context/AgentRegistry/AgentLoop/LlmRuntime/SessionStore/SystemPrompt/ToolRuntime/defineTool/createUserMessage/SessionId/LlmAdapter/SqliteSessionPersistence` 全部可导入且类型形状正确
- [x] T0.7 `tests/unit/config.test.ts`、`tests/unit/db.test.ts`
- **验收**：`pnpm install && pnpm typecheck && pnpm test` 全绿

## P1 · dsh 内嵌最小闭环

**目标**：一条 `用户消息 → 模型 → 工具 → 卡片 → 回放` 的链路在离线 mock 下跑通。

- [x] T1.1 `src/harness/session-scope.ts`：`TenantScope` + bind/lookup 注册表
- [x] T1.2 `src/harness/mock-llm.ts`：`LlmAdapter` 子类，确定性意图路由（无 key 时兜底）
- [x] T1.3 `src/harness/cards.ts`：卡片协议类型 + `protocolVersion` + 软降级
- [x] T1.4 `src/harness/plugins/tools-cs.ts`：首个工具 `knowledge.search`（P3 前先用内存桩）
- [x] T1.5 `src/harness/plugins/guard-scope.ts`：租户越权 deny
- [x] T1.6 `src/harness/plugins/guard-risk.ts`：六档 `RiskTier` 表 + allow/ask/deny 裁决
- [x] T1.7 `src/harness/assemble.ts`：Context 组装 + `agentFor()` + `runTurn()`
- [x] T1.8 `scripts/smoke.ts`：离线冒烟（意图→工具→卡片→越权拒绝→回放幂等）
- [x] T1.9 `tests/integration/harness.test.ts`：真实 `assembleHarness()`（不 mock Context）
- **验收**：`pnpm smoke` 全绿；越权被拒且无业务卡片；回放帧数与实时一致

## P2 · 渠道与网关

- [x] T2.1 `src/channel/types.ts`：`ContentPart` / `InboundMessage` / `OutboundAction` / `ChannelCapabilities`
- [x] T2.2 `src/channel/adapter.ts`：`ChannelAdapter` 接口 + `ChannelRegistry`
- [x] T2.3 `src/channel/webchat.ts`：WebChat adapter（`canSendProactive: true`）
- [x] T2.4 `src/harness/plugins/tools-cs.ts` 补 `channel.reply`（ORANGE_C 档）
- [x] T2.5 `src/gateway/app.ts`：Fastify 工厂 + `/health/live` `/health/ready`
- [x] T2.6 `src/gateway/routes-channels.ts`：`POST /channels/webchat`（+ 旧路径 `/chat/message` 别名）
- [x] T2.7 `src/gateway/frames.ts`：SessionEvent → 帧（`text/delta` `tool/status` `card/*`）
- [x] T2.8 `src/gateway/ws.ts`：`WS /ws/conversations/:id` 实时 + 历史重放
- [x] T2.9 `src/runtime.ts` + `src/main.ts`：组合根 + 生命周期（启动/优雅关停）
- [x] T2.10 单测（frames/adapter/registry）+ `tests/e2e/inbound-reply.test.ts`
- **验收**：`pnpm dev` 起服务，POST 一条消息拿到回复；WS 收到分片帧；重连历史一致

## P3 · 知识库与技能

- [x] T3.1 `src/knowledge/parser.ts`：Markdown 按 `##` 分块 + frontmatter（gray-matter）
- [x] T3.2 `src/knowledge/store.ts`：FTS5 + CJK LIKE 兜底 + `upsertChunks/deleteBySource/status`
- [x] T3.3 `src/knowledge/ingestor.ts`：chokidar 监听 + 增量重建
- [x] T3.4 `src/skills/repo.ts`：`ctx.skills` + `dsh-skill-filesystem` 薄封装；`buildIndex()` 紧凑索引
- [x] T3.5 `src/harness/plugins/prompt-sections.ts`：persona / 技能索引 / L2 摘要注入（`ctx.systemPrompt.section`）
- [x] T3.6 两轮技能选择：Round1 索引 → `[SKILLS: ...]` → Round2 正文注入
- [x] T3.7 `knowledge/` 与 `skills/` 示例内容（退款政策、问候、订单查询）
- [x] T3.8 单测 + `tests/e2e/knowledge.test.ts`
- **验收**：改一个 .md 文件，热重载后新答案立即生效；技能命中记录进 lineage

## P4 · CRM 与记忆

- [ ] T4.1 `src/crm/types.ts`：`Contact` / `LifecycleStage` / `LeadStatus` / `ContactEvent`
- [ ] T4.2 `src/crm/store.ts`：contacts + contact_events；**渠道身份独立唯一索引**
- [ ] T4.3 `src/crm/lifecycle.ts`：单调跃迁校验 + 终态出口
- [ ] T4.4 `src/crm/scoring.ts`：frequency/success/satisfaction/recency 加权 + 衰减
- [ ] T4.5 `src/crm/segment.ts`：`AudienceFilter` 规则求值（eq/gt/lt/in/contains）
- [ ] T4.6 `src/crm/importer.ts`：CSV（csv-parse）+ 中英表头别名 + 去重 + `ImportReport`
- [ ] T4.7 `src/crm/service.ts`：`onInbound()`（打分/跃迁/时间戳）+ `linkIdentity()` + `unaddressable` 判定
- [ ] T4.8 `src/memory/l2-store.ts`：结构化长期记忆 + FTS5 + 多版本
- [ ] T4.9 `src/harness/plugins/tools-crm.ts`：`contact.get/update_stage/add_note/link_conversation`
- [ ] T4.10 `lead_qualifier` subagent（one-shot，工具白名单 spawn 固化）
- [ ] T4.11 单测（6 文件）+ `tests/e2e/crm.test.ts`
- **验收**：入站消息自动建/更新联系人；同一人多渠道不重复建档；无渠道身份显式失败

## P5 · 节奏与外呼

- [ ] T5.1 `src/outreach/outbox.ts`：sends + delivery_receipts；`(run_id, step_order)` 幂等；租约 + reap
- [ ] T5.2 `src/outreach/event-store.ts`：投递事件漏斗
- [ ] T5.3 `src/nurture/types.ts`：`Cadence` / `CadenceStep` / `CadenceRun` / `TickReport`
- [ ] T5.4 `src/nurture/store.ts`：cadences/steps/runs CRUD
- [ ] T5.5 `src/nurture/pacing.ts`：静默时段（IANA 时区）+ 周频控 + `nextOpenSlot`
- [ ] T5.6 `src/nurture/composer.ts`：template 短路 / goal 走 LLM；**身份边界 system prompt**（教训 #1）
- [ ] T5.7 `src/nurture/engine.ts`：五阶段 tick（reap→exit→enrol→advance→drain）+ **并发 drain**（教训 #2）
- [ ] T5.8 `src/harness/plugins/tools-cs.ts` 补 `nurture.deliver`（ORANGE_B 档 + 频控 guard）
- [ ] T5.9 单测（engine/composer/pacing/outbox）+ `tests/e2e/lead-to-close.test.ts`
- **验收**：导入 500 联系人 → 激活节奏 → 全自动投递 → 回复退出；无重复发送

## P6 · 演进与评测

- [ ] T6.1 `src/evolution/types.ts` + `proposal-store.ts`（5 维度 / 3 动作 / 6 状态）
- [ ] T6.2 `src/evolution/handlers/*`：skill/memory/crm_tool/knowledge/outreach 五处理器
- [ ] T6.3 `src/evaluation/`：`cs-metrics.ts`（policy/tone/resolution）+ `engine.ts`（realtime/gate/batch）+ `store.ts`
- [ ] T6.4 `src/replay/`：session 事件加载 + `dsh-llm-replay` + 差分器 + 判定（accepted/diverged/regressed）
- [ ] T6.5 `src/evolution/shadow-runner.ts` + `gate.ts`（评测→影子回放→冲突检测→风险分级）
- [ ] T6.6 `src/lineage/`：DAG store + `LineageContext`
- [ ] T6.7 `src/skills/curator.ts`：CREATE/IMPROVE/MERGE/ABSTRACT/PRUNE 五种变异 + 健康度
- [ ] T6.8 `src/evolution/ablation/`：技能消融实验 runner + store
- [ ] T6.9 `src/harness/plugins/tools-evolution.ts`：`evolution.propose`
- [ ] T6.10 单测 + `tests/e2e/evolution.test.ts`、`tests/e2e/replay.test.ts`
- **验收**：低分会话触发提案 → 影子回放 → 门禁判定 → HITL 审批 → 生效

## P7 · 管理端与交付

- [ ] T7.1 `src/gateway/routes-admin.ts`（提案/审计/统计）
- [ ] T7.2 `routes-contacts.ts`（含 funnel / import / segment-preview / link-identity）
- [ ] T7.3 `routes-cadences.ts`（CRUD / activate / pause / enroll / stats）
- [ ] T7.4 `routes-knowledge.ts` `routes-skills.ts` `routes-lineage.ts` `routes-eval.ts` `routes-replay.ts` `routes-ablation.ts` `routes-campaigns.ts`
- [ ] T7.5 `GET /admin/sessions/:id/events`（dsh 原生回放查询，新增能力）
- [ ] T7.6 `src/channel/wecom.ts`：企微客服 adapter（`@wecom/crypto` 加解密）+ `POST /channels/wecom/callback`
- [ ] T7.7 `apps/admin-web/`：从 Python 版 `web-ui/` 迁移，仅改 API base
- [ ] T7.8 `Dockerfile` + `docker-compose.yml` + `.env.example`
- [ ] T7.9 `README.md`（产品说明 + dsh 依赖说明 + 环境变量表 + 快速开始）
- [ ] T7.10 路由单测 + 真实 LLM 端到端冒烟
- **验收**：docker-compose 一键起；Admin UI 可用；真实 LLM 冒烟不复现四个已知生产 bug

---

## 跨 Phase 约束

- 每个 `src/<module>/` 首次实现前先产出 `RESEARCH.md`（CLAUDE.md 强制门禁）
- 每个 task 完成后跑 `pnpm typecheck && pnpm test`
- mock 与真实实现共用同一 TS interface（教训 #5）
- 提交信息写明「复用：<库> @ <版本> — <理由>」或「自建：<理由 + 排除候选>」


---

## 已完成阶段的实测结论（写回计划，供后续阶段参考）

### P0
- `oxlint` 因网络问题暂未接入，`pnpm lint` 先指向 `tsc --noEmit`；恢复网络后补回
- 契约测试立刻锁到两条 dsh API 约束：
  1. object value schema 必须显式 `additionalProperties`
  2. 输出属性未标 `required: true` 会被推成可选，`presentationMeta` 因此过不了 `JsonValue`
- `node:sqlite` 必须用 `createRequire` 动态加载：Vite 剥掉 `node:` 前缀后查不到内置模块

### P1
- cordis 没有 `ctx.stop()`：整棵树关停靠逆序 dispose 每个 `ctx.plugin()` 返回的 fiber
- `Fiber.dispose()` 是异步的，必须 await

### P2
- **fastify 默认 `removeAdditional: true` 会静默剥掉未知字段**——对 webhook 是隐患
  （接入方字段拼错到线上才发现）。已改为显式拒绝 + 400
- **`tool/result` 事件不带工具名**，只有 `message.source.callId`。要给前端
  「xx 已完成」提示必须维护 callId → 工具名映射，因此帧投影从纯函数改为
  一次性 `FrameProjector`；WS 侧的 projector 必须**长期存活**，否则映射跨回调丢失
- **WebChat 有两种消费形态**（WS 长连接 / HTTP 请求-响应）。最初只支持前者，
  导致纯 HTTP 接入方每次都收到「投递失败」，模型据此向用户道歉。已改为
  「先入 per-conversation 待取队列，再推在线订阅者」，两种形态都成立
- HTTP 响应区分 `reply`（对客户说的话，来自 `channel.reply`）与
  `agent_narration`（模型内部叙述）——两者混为一谈会让接入方把内部推理发给客户

### P3
- **dsh-skill-filesystem 只识别 frontmatter 的 `name`/`description`/`whenToUse`/`metadata`
  与两个 invocation 开关，其余顶层键一律忽略**。OpenCS 的 priority/routing/intent_signals
  必须嵌在 `metadata:` 之下（那是 dsh 给下游的开放扩展点）。已写回 skills/RESEARCH.md
- `includeDefaultRoots: false` 是必须的——默认会扫 `$DSH_HOME/skills` 与 `~/.agents`，
  那是**开发者机器上的个人技能**，绝不能混进服务端话术库。已加隔离测试守住
- `PromptSection.text` 必须是**同步**的（`string | (ctx) => string`），
  而技能加载是异步的 → repo 维护一个同步索引快照，启动与 `skills/change` 后预热
- chokidar 的 `watch()` 必须等到 `ready` 再返回，否则紧随其后的变更被静默丢弃
