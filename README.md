# OpenCS-DSH

自托管的 AI 客服 / 增长 Agent，**基于 [DeepSeek Harness (dsh)](https://github.com/deepseek-harness) 内嵌构建**。

这是 [`open-customer-service`](../open-customer-service)（Python / FastAPI）的完全重写版：
Agent 运行时不再自建，转由 dsh 承担；OpenCS 只保留 dsh 不提供的 CS/CRM 业务语义。

> ⚠️ 开发中。当前进度：**P0 骨架 / P1 dsh 内嵌闭环 / P2 渠道与网关** 已完成，
> 后续见 `docs/superpowers/plans/2026-08-21-rewrite-master-plan.md`。

---

## 为什么基于 dsh

Python 版里约 25% 的代码是在自建 agent 运行时（Orchestrator、ToolRegistry、
ToolExecutor、ActionGuard、L0 事件库、LLMClient）。这些在 dsh 里都有框架级实现：

| Python 版自建 | dsh 原生 |
|---|---|
| `Orchestrator` 三阶段循环 | `ctx.agentLoop` |
| `ToolRegistry` + `ToolExecutor` | `ctx.tools` + `defineTool` |
| `ActionGuard` 六档风险 + HITL | `tools/pre-execute` guard 链 + `ctx.approval` |
| `L0RawEventStore` 事件溯源 | `ctx.sessions` + session persistence |
| `LiteLLMClient` | `ctx.llm` adapter 注册制 |
| 多 worker 路由 | `ctx.subagents`（工具白名单 spawn 时固化） |

换来的净增能力：长会话 compaction、MCP 工具零代码接入、结构化会话回放。

完整调研见 [`docs/superpowers/research/2026-08-21-dsh-rewrite-research.md`](docs/superpowers/research/2026-08-21-dsh-rewrite-research.md)，
设计见 [`docs/superpowers/specs/2026-08-21-opencs-dsh-design.md`](docs/superpowers/specs/2026-08-21-opencs-dsh-design.md)。

---

## 依赖 dsh 的方式（重要）

本项目通过 pnpm `link:` 依赖**本地 checkout** 的 dsh，而不是 npm 版本号：

```
dsh 仓库：  ../deepseek-harness
锁定版本：  0.1.0-rc.5
锁定 commit：47f943859b
```

**原因**：rc.5 未发布到 npm；npm 上的 rc.8 / 0.1.1-rc.1 与本项目全部调研所依据的
源码存在 API 漂移风险，而 dsh 官方明确「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」。

**对冲**：`tests/contract/dsh-api.test.ts` 断言我们依赖的每个 dsh 导出符号存在且形状正确。
升级 dsh 时先跑契约测试定位破坏面，再跑全量回归。

### 准备 dsh

```bash
# 与本仓库同级
git clone <dsh-repo> ../deepseek-harness
cd ../deepseek-harness && git checkout 47f943859b && pnpm install && pnpm build
```

---

## 快速开始

```bash
pnpm install
pnpm smoke          # 离线冒烟：无需任何 API key，全链路验证
pnpm test           # 全量测试
pnpm typecheck
pnpm dev            # 起服务 → http://localhost:8080
```

未配置 LLM API key 时自动降级为**确定性 mock 模型**——完整走 agent loop、
guard、工具执行与 session 持久化，只是 token 由规则生成。CI 无 key 也能全绿。

### 试一下

```bash
curl -X POST localhost:8080/channels/webchat \
  -H 'content-type: application/json' \
  -d '{"conversation_id":"c1","customer_id":"u1","text":"买的东西想退款，还来得及吗"}'
```

```jsonc
{
  "conversation_id": "c1",
  "reply": "[售后 / 退款政策] 签收后 7 天内可无理由退款…",  // 发给客户的话
  "agent_narration": "我帮你确认一下退款政策。",              // 模型的内部叙述
  "delivered": true,
  "frames": [ /* text/delta、tool/status、card/open|item|close */ ],
  "trace": { "from_seq": 1, "to_seq": 34 }
}
```

WebSocket：`ws://localhost:8080/ws/conversations/:id?customer_id=u1`
连接时先收到 `{type:"history",frames:[...]}`，之后实时收帧。
**重连收到的历史与当时实时收到的逐帧一致**——两者共用同一个纯投影函数。

---

## 架构

```
apps/admin-web (Next.js，P7)
        │ HTTP / WS
┌───────▼─────────────────────────────────────────┐
│ src/gateway   Fastify 5                          │
│  /channels/webchat  /ws/conversations/:id        │
│  /health/live  /health/ready                     │
└───────┬─────────────────────────────────────────┘
        │
┌───────▼──────────────┐   ┌────────────────────────┐
│ dsh Context（内嵌）    │   │ 自研业务层               │
│  agents / agentLoop   │◄──┤  channel/  渠道网关      │
│  tools（defineTool）  │   │  crm/      联系人（P4）  │
│  llm / sessions       │   │  nurture/  节奏（P5）    │
│  systemPrompt         │   │  knowledge/ 知识库（P3） │
│  subagents / jobs     │   │  evolution/ 演进（P6）   │
└──────────────────────┘   └────────────────────────┘
```

### 三条核心纪律

1. **LLM 永不直接执行不可逆动作**
   发消息 / 改生命周期 / 写标签一律经 `defineTool` 收口，由 `tools/pre-execute`
   guard 链做租户隔离 + 风险分级 + 频控。`channel.reply` 默认 ORANGE_C 档 —— 需人工确认。
   放开它靠改 `OPENCS_AUTO_APPROVE_TIERS`，是一个**显式的运营决策**，不是代码默认值。

2. **卡片不是自建协议，是 `defineTool` 的 `presentationMeta`**
   纯函数投影，随 `tool/result` 事件持久化 → 回放免费，实时与历史不可能不同步。

3. **Model-visible ⟺ logged**
   进入模型请求的任何内容都必须能从 session 日志重建，否则回放不成立。

### 风险分级

| 档 | 名称 | 默认 | 典型工具 |
|---|---|---|---|
| 0 | GREEN | 放行 | `knowledge.search` `crm.get_order` |
| 1 | YELLOW | 放行 | `contact.add_note` `memory.write_l2` |
| 2 | ORANGE_A | 放行（频控） | `channel.send_template` |
| 3 | ORANGE_B | 放行（频控+审计） | `nurture.deliver` |
| 4 | ORANGE_C | **人工确认** | `channel.reply` |
| 5 | RED | **人工确认** | `contact.update_stage` `contact.mark_won` |

未在 `src/harness/risk.ts` 登记的工具落到 ORANGE_C —— 新增工具忘记登记时会走审批而非放行。

---

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCS_ENV` | `development` | `development` / `test` / `production` |
| `OPENCS_DATA_DIR` | `./data` | SQLite 与 session 日志目录 |
| `OPENCS_KNOWLEDGE_DIR` | `./knowledge` | Markdown 知识库 |
| `OPENCS_SKILLS_DIR` | `./skills` | SKILL.md 技能库 |
| `OPENCS_TENANT_ID` | `default` | 默认租户 |
| `OPENCS_HOST` / `OPENCS_PORT` | `0.0.0.0` / `8080` | 监听地址 |
| `DEEPSEEK_API_KEY` | — | 配置后走 dsh-llm-deepseek |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | — | OpenAI 兼容网关（P2 后续接入） |
| `OPENCS_MODEL` | `deepseek-chat` | 模型 id |
| `OPENCS_ACTION_TOKEN_SECRET` | — | **生产必填**，≥32 字节 |
| `OPENCS_AUTO_APPROVE_TIERS` | `0,1,2,3` | 自动放行的风险档 |
| `OPENCS_NURTURE_ENABLED` | `true` | 节奏引擎开关（P5） |
| `OPENCS_NURTURE_POLL_INTERVAL` | `60` | tick 间隔（秒） |
| `OPENCS_NURTURE_DRAIN_CONCURRENCY` | `8` | 并发投递数 |
| `OPENCS_NURTURE_LEASE_SECONDS` | `300` | 发件租约时长 |
| `WECOM_*` | — | 企微三件套，必须同时配置（P7） |
| `LANGFUSE_*` | — | 可选观测 |

生产环境缺少必填项或降级为 mock 模型会**直接启动失败**，不静默降级。

---

## 测试

| 层 | 位置 | 说明 |
|---|---|---|
| 契约 | `tests/contract/` | 锁定 dsh 依赖面，升级时先跑这层 |
| 单元 | `tests/unit/` | 纯函数（帧投影、卡片降级、风险档、频控、渠道解析） |
| 集成 | `tests/integration/` | **真实 `assembleHarness()`**，不允许只 mock Context |
| 端到端 | `tests/e2e/` | 真实 Fastify + 真实 runtime 对象图 |

```bash
pnpm test        # 150 tests
pnpm smoke       # 离线全链路冒烟
```

---

## 开发工具

```bash
tsx scripts/dev/ws-probe.ts   # 连 WS 发消息，打印帧序列并验证重连历史一致
```

---

## License

Apache-2.0
