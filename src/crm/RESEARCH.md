# crm · OSS 调研

## 目标
联系人档案 + 生命周期漏斗 + 意向打分 + 分群筛选 + CSV 批量导入，
作为「入站客服」与「主动外呼」共用的客户主数据。

## 候选对比

| 候选 | License | 最近 commit | Stars | 体量 | 评分 | 备注 |
|---|---|---|---|---|---|---|
| [twentyhq/twenty](https://github.com/twentyhq/twenty) | **AGPL-3.0** | 活跃 | 27k+ | 很大 | ❌ | **License 否决**（CLAUDE.md：AGPL 默认禁用，网络服务也触发传染，商业自托管客户可能拒绝采用） |
| [espocrm/espocrm](https://github.com/espocrm/espocrm) | **GPL-3.0** | 活跃 | 2k+ | 大 | ❌ | License 否决；且是 PHP 整站，无法嵌入 Node 进程 |
| [erxes/erxes](https://github.com/erxes/erxes) | 自定义受限 | 活跃 | 3k+ | 很大 | ❌ | 非 OSI 认证开源，限制商业部署 |
| [SuiteCRM](https://github.com/salesagility/SuiteCRM) | AGPL-3.0 | 活跃 | 4k+ | 很大 | ❌ | License 否决 |
| [Atomic CRM](https://github.com/marmelab/atomic-crm) | MIT | 活跃 | 1k+ | 中 | ❌ | 是 react-admin 前端模板 + Supabase 后端，不是可嵌库；强绑 Supabase |
| 自建 SQLite store + 状态机 | — | — | ~700 行 | ✅ **自建** | 见下方决策 |

## 决策

**自建**。逐个排除的量化理由：

1. **三个主流 OSS CRM 全部 copyleft/受限**（AGPL×2、GPL×1、自定义×1）。
   OpenCS 定位是「企业自托管 + 开源」，AGPL 会传染整个产品，
   直接违反 CLAUDE.md 的 License 兼容性策略。
2. **它们都是「整套产品」而非「可嵌库」**。即使 license 允许，
   集成方式也只能是「跑一个独立 CRM 服务 + 通过 REST 同步」——
   那等于给自托管用户增加一个重型依赖（Postgres + Redis + 一整个 Web 应用），
   而我们真正需要的只是 5 张表和一个单调状态机。
   封装成本估计 ≥ 1500 行（API 客户端 + 字段映射 + 同步冲突处理 + 部署编排），
   远大于自建的 ~700 行。
3. 我们的核心需求——**渠道身份与业务身份分离**（见下）——是客服场景特有的，
   通用 CRM 的数据模型里没有对应概念，接进来仍要自建一层映射。

**OSS 等价物登记**：`twentyhq/twenty`。若未来其 license 变更为宽松协议，
可评估「用 twenty 作为主数据、OpenCS 只读镜像」的架构。

## 复用的小件

| 用途 | 复用 | License | 理由 |
|---|---|---|---|
| CSV 解析 | `csv-parse @ ^5` | MIT | 正确处理引号内逗号/换行、BOM、多种编码；手写 split(',') 必错 |
| 持久化 | SQLite（`node:sqlite`） | Public Domain | 与其他模块同库同事务 |

## 数据模型的关键取舍

### 身份三分（Python 版实测教训 #3 / #4）

Python 版曾出现两个生产 bug：入站回复按手机号建了重复联系人；
没有渠道身份的联系人在外呼时被静默丢弃。根因是把三种身份混为一谈。

| 身份 | 字段 | 唯一性 | 语义 |
|---|---|---|---|
| 业务身份 | `dedup_key`（email/phone 归一化） | 租户内唯一 | 「这是同一个人」 |
| 渠道身份 | `(channel_id, external_id)` | **独立唯一索引** | 「在这个渠道上怎么找到他」 |
| 会话身份 | `conversation_id` | 无 | 「这次对话」 |

一个联系人可挂多个渠道身份（企微 + webchat）。
**没有任何渠道身份 = `unaddressable`**，外呼时**显式失败并记事件**，绝不静默跳过。

### 生命周期单调性

`new < engaged < qualified < opportunity < customer`，
`disqualified` / `churned` 为终态出口。回退需显式 `force` 且属 RED 风险档。

理由：漏斗指标依赖单调性。允许随意回退会让「转化率」失去意义，
也会让节奏引擎的 `exit_on_stage` 判定反复触发。

## 集成边界

```ts
interface ContactPort {          // 给 dsh 工具层
  get(tenantId, contactId): Promise<Contact | undefined>
  findByChannel(tenantId, channelId, externalId): Promise<Contact | undefined>
  segment(tenantId, filter, now): Promise<readonly Contact[]>
}
```

`ContactService` 的写入方法（`onInbound` / `updateStage` / `linkIdentity`）
不直接暴露给模型——它们经 `defineTool` 收口并受 guard 治理。

## 升级与停更预案

- SQLite schema 变更走 `src/db/sqlite.ts` 的编号 migration，向前兼容
- `csv-parse` 停更时可换 `papaparse`（MIT），接口相近
- 若切换到外部 CRM 作为主数据：保留 `ContactPort` 接口，
  新增 `ExternalCrmContactStore` 实现，`runtime.ts` 换一行装配
