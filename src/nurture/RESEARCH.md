# nurture · OSS 调研

## 目标
把「导入一批联系人」变成「按节奏自动触达、有人回复就停、成单为止」的全自动流程，
且不骚扰客户（静默时段、频控）、不重复发送（幂等 + 租约）。

## 候选对比

| 候选 | License | 最近 commit | 评分 | 备注 |
|---|---|---|---|---|
| `@deepseek-ai/dsh-schedule` | MIT | 2026-08 | ❌ **能力不匹配** | 实测其 README：**session-scoped** 提醒，为单个 live agent 的 `after`/`at`/`every` 定时 followup 设计；`every_seconds` **下限 5 分钟**；状态存在 session 事件日志里。无法承载「5000 联系人 × 多步节奏 × 静默时段 × 周频控 × 并发投递」 |
| [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq) | MIT | 活跃 | ⚠️ | 能力足够（延迟任务、重试、并发、幂等 jobId）。但**强依赖 Redis**——OpenCS 的 MVP 定位是「单进程 + SQLite 自托管」，引入 Redis 会把部署从 `docker run` 变成 compose 编排，抬高自托管门槛。**登记为规模化切换目标** |
| [node-cron/node-cron](https://github.com/node-cron/node-cron) | ISC | 活跃 | ⏸ | 只是 cron 表达式定时器。我们的 tick 是固定间隔，`setInterval` 已足够；引入它换不来实质收益 |
| [agenda/agenda](https://github.com/agenda/agenda) | MIT | **停更 >18 个月** | ❌ | 触发 CLAUDE.md 停更否决条件；且依赖 MongoDB |
| 自建五阶段 tick + SQLite 发件箱 | — | — | ✅ **自建** | 见下方决策 |

## 决策

**自建**。理由：

1. **dsh-schedule 语义不对**——它是「让 agent 提醒自己」，我们要的是
   「对一批外部联系人按业务规则投递」。两者只是名字像。
2. **BullMQ 的 Redis 依赖与 MVP 定位冲突**。且我们真正需要的调度语义
   （静默时段、周频控、按阶段退出、回复即停）都是**业务规则**，
   BullMQ 一个也不提供，仍要自建。它能替我们做的只有「延迟队列 + 重试」，
   而那部分在 SQLite 里是 `WHERE next_action_at <= now` 一行 SQL。
3. Python 版已验证的五阶段 tick 形状可直接移植，风险低。

**OSS 等价物登记**：BullMQ。切换触发条件——单实例吞吐不够，或需要多实例水平扩展。
迁移路径：`SendOutbox` 接口保持不变，换一个 BullMQ 实现。

## 从 Python 版带过来的硬约束

这三条不是设计偏好，是**生产事故的修复**（见 research §4）：

### 1. drain 必须并发（教训 #2）

实测：真实 LLM 组稿单条约 40 秒。串行处理 50 条 = 33 分钟，
远超 300 秒的租约超时 → reaper 判定 worker 已死 → 回收租约 → **重复发送**
（同一客户被打两次）。

约束：
- drain 并发度可配（默认 8），`OPENCS_NURTURE_DRAIN_CONCURRENCY`
- 租约时长按 `单条耗时 × 批大小 ÷ 并发度 × 安全系数` 推算，写进配置注释
- `(cadence_run_id, step_order)` 唯一约束作为**最后一道防线**：
  即使租约逻辑出错，同一步也只可能有一条发件记录

### 2. 身份边界必须在 system prompt 里显式声明（教训 #1）

实测事故：LLM 把联系人的 `company` 字段读成自己的雇主，
给晨光电商的客户发消息时自称「我是晨光电商的小王」。

约束：
- `sender_persona` 贯穿 Cadence → Store → Engine → Composer → API 全链路
- composer 的 system prompt 必须有显式边界：「客户所在公司是客户的公司，不是你的公司」
- `sender_persona` 为空时，明确指示模型**不要虚构任何公司名或人名**

### 3. 大批量首触必须能走模板（教训 #6）

5000 联系人 × 40 秒 LLM 组稿 = 55 小时。
约束：step 保留 `template`（毫秒级）/ `goal`（LLM 组稿）双模式，
文档明确建议首触用 template，LLM 只留给高价值跟进步骤。

## 时区处理

| 候选 | License | 评分 | 备注 |
|---|---|---|---|
| `Intl.DateTimeFormat` + IANA 时区（Node 内置） | — | ✅ **复用** | 静默时段判断只需要「某 UTC 时刻在某时区是几点」，`formatToParts` 直接给出，零依赖 |
| [date-fns/tz](https://github.com/date-fns/tz) | MIT | ⏸ | 更好用但为一个小时数计算引入依赖不划算 |
| moment-timezone | MIT | ❌ | 已进入维护模式，且体积大 |

## 集成边界

```ts
interface NurtureEngine {
  tick(now: Date): Promise<TickReport>   // 五阶段：reap → exit → enrol → advance → drain
  start(): void                          // 按 pollInterval 循环
  stop(): Promise<void>
}
```

引擎不直接调渠道——它经 `OutboundPort` 投递，与 `channel.reply` 走同一条路径，
因此同样受 guard 治理（频控、审计）。

## 升级与停更预案

- SQLite schema 走编号 migration
- 切 BullMQ 时保留 `SendOutbox` 接口，新增 `BullmqSendOutbox` 实现
- `Intl` 是 ECMA 标准，无停更风险
