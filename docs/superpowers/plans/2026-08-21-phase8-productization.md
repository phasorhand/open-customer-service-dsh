# P8 · 产品化：从工程验证到可售卖的 2B 产品

- 上游：`2026-08-21-rewrite-master-plan.md`（P0–P7a 已完成，424 tests）
- 目标：补齐客户采购视角下的阻断项，让系统能真正部署给付费客户

## 缺口分析（按客户采购流程排序）

| # | 缺口 | 为什么是阻断项 | 优先级 |
|---|---|---|---|
| 1 | 管理 API 无鉴权 | 任何安全评审第一轮就否决；管理面能改生命周期/发外呼 | P0 |
| 2 | HITL 审批不可操作 | 默认 ORANGE_C 下回复被 ask 拦住就没了，**没有队列可批**——安全默认值等于产品不可用，客户只能被迫开自动回复 | P0 |
| 3 | 审计只在内存 | 重启即失；合规客户（金融/医疗）要求审计可回溯 | P0 |
| 4 | 无企微渠道 | 国内 2B 客户的真实触点就是企微客服；webchat 只是演示 | P1 |
| 5 | 无管理界面 | 无法给客户演示，运营无法自助操作 | P1 |
| 6 | 无 OpenAI 兼容网关 | 客户普遍有自建/代理网关，只支持 DeepSeek 官方直连不够 | P1 |
| 7 | 公网 webhook 无频控 | 被刷会直接打爆 LLM 账单 | P2 |

## Task 列表

### T8.1 管理面鉴权（P0）
- [x] `OPENCS_ADMIN_TOKEN`：生产必填（≥16 字节），开发缺省时警告并放行
- [x] Fastify onRequest hook：`/admin/*` 要求 `Authorization: Bearer <token>`
- [x] 健康检查与渠道 webhook 不受影响（前者是探针，后者是客户触点）
- [x] e2e：无 token 401、错 token 401、对 token 200、健康检查不需要 token

### T8.2 持久化审计（P0）
- [x] `src/audit/store.ts`：SQLite audit.db，记录每次风险裁决（tool/tier/decision/reason/scope/at）
- [x] runtime 把 `onRiskDecision` 从内存数组换成落库（内存投影保留为快速视图）
- [x] `/admin/audit-log` 改读 SQLite，支持分页与过滤

### T8.3 HITL 审批队列（P0）
- [x] `src/approval/queue.ts`：pending/approved/rejected/delivered 状态机
- [x] guard-risk 在 `ask` 分支落一条审批项（工具、参数、scope 快照）
- [x] `GET /admin/approvals` `POST /admin/approvals/:id/approve|reject`
- [x] approve 对 `channel.reply` 类动作**直接经渠道投递**（确定性执行，不再过模型）
- [x] e2e：默认档位下回复进队列 → 批准 → 客户真的收到

### T8.4 企微客服渠道（P1）
- [x] `src/channel/wecom-crypto.ts`：签名校验 + AES-256-CBC 加解密（node:crypto 自建，无外部依赖）
- [x] `src/channel/wecom.ts`：URL 验证（GET echostr）、事件回调解密、sync_msg 拉取、send_msg 发送
- [x] access_token 管理（gettoken + 提前刷新），HTTP 客户端可注入（测试用桩）
- [x] `POST /channels/wecom/callback` + `GET`（验证）
- [x] 单测：加解密往返、签名、PKCS7；集成：stub HTTP 的收发闭环

### T8.5 管理控制台（P1）
- [x] `src/gateway/console.ts`：自包含单页（无构建步骤），`GET /console`
- [x] 页签：总览 / 联系人（导入/漏斗）/ 节奏（创建/激活/统计）/ 审批队列 / 审计 / 对话测试
- [x] token 存 localStorage，所有请求带 Bearer

### T8.6 OpenAI 兼容网关（P1）
- [x] 挂 `dsh-llm-pi-ai`，手声明 `opencs-gateway` 路由（baseURL + OPENAI_API_KEY + OPENCS_MODEL）
- [x] config.llm.kind === 'openai-compatible' 时启用

### T8.7 Webhook 频控（P2）
- [x] 每会话滑动窗口（复用 SlidingWindowRateLimiter），超限 429
- [x] `OPENCS_WEBHOOK_RATE_LIMIT`（默认 20 条/分钟/会话）

### T8.8 交付资料
- [x] README：安全模型、部署清单、备份说明（SQLite 文件清单）
- [x] .env.example 补齐新变量

## 验收
1. 无 token 打管理 API 一律 401；生产缺 OPENCS_ADMIN_TOKEN 启动失败
2. 默认风险档下：客户提问 → 回复进审批队列 → 运营在控制台批准 → 客户收到回复（全链路实测）
3. 审计跨重启可查
4. 企微加解密单测与官方算法一致（往返 + 签名）
5. `/console` 打开即可演示：导入 → 建节奏 → 审批 → 看统计


## 实施记录（2026-08-22）

全部 task 完成。实测发现：

- **Fastify async 钩子里 `send()` 后必须 `return reply`**，否则请求生命周期停摆
  （全量测试卡死 8 分钟才定位到）。鉴权 401 与频控 429 两处都踩到
- 频控维度选 conversation_id 而非 IP：客户触点常经反代/小程序网关，源 IP 坍缩；
  刷账单的真实模式是「同一会话高频灌消息」
- 审批队列的去重键是 (conversation, tool, preview)：模型重试同一句话
  不会在队列里堆出三条一样的待办
- 企微加解密无官方测试向量（样例密钥不公开），用往返一致性 + 结构逐项断言验证；
  receiveid 校验防跨企业密文重放
- 企微客服是**拉模型**：回调只有事件通知，消息本体走 sync_msg 游标拉取；
  回调必须 5 秒内返回 → 拉取与 agent 处理在响应后异步进行
