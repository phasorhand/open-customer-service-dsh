/**
 * HITL 审批队列。
 *
 * 存在的理由（P8 缺口 #2）：默认风险档下 `channel.reply` 走 `ask`，
 * 而 headless 环境没有 answerer → dsh 直接 deny，**回复就没了**。
 * 这让「安全默认值」等于「产品不可用」，客户被迫开自动回复。
 *
 * 模型：guard 在 ask 分支落一条**待批草稿**（工具、参数、scope 快照）。
 * 运营批准后，系统**确定性地执行**该动作（经渠道投递）——不再过模型，
 * 批准的就是看到的那句话，不会批 A 发 B。
 *
 * 状态机：
 * ```
 * pending ──approve──> delivering ──ok──> delivered
 *    │                      └──fail──> failed
 *    └──reject──> rejected
 * ```
 */

import { randomUUID } from 'node:crypto'

import { fromJsonColumn, toJsonColumn } from '../db/json.js'
import type { Db, Migration } from '../db/sqlite.js'

export const APPROVAL_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_approvals',
    sql: `
      CREATE TABLE approvals (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        customer_id     TEXT NOT NULL,
        contact_id      TEXT,
        tool            TEXT NOT NULL,
        args            TEXT NOT NULL,
        preview         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        reviewer        TEXT,
        review_note     TEXT,
        error_reason    TEXT,
        requested_at    TEXT NOT NULL,
        decided_at      TEXT,
        delivered_at    TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals (tenant_id, status, requested_at);
      CREATE INDEX idx_approvals_conversation ON approvals (conversation_id, requested_at);
    `,
  },
]

export type ApprovalStatus = 'pending' | 'rejected' | 'delivering' | 'delivered' | 'failed'

export interface ApprovalItem {
  readonly id: string
  readonly tenantId: string
  readonly conversationId: string
  readonly channelId: string
  readonly customerId: string
  readonly contactId?: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  /** 给审核者看的动作摘要（对 channel.reply 就是将发送的正文）。 */
  readonly preview: string
  readonly status: ApprovalStatus
  readonly reviewer?: string
  readonly reviewNote?: string
  readonly errorReason?: string
  readonly requestedAt: Date
  readonly decidedAt?: Date
  readonly deliveredAt?: Date
}

export interface EnqueueApproval {
  readonly tenantId: string
  readonly conversationId: string
  readonly channelId: string
  readonly customerId: string
  readonly contactId?: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly preview: string
}

export class ApprovalQueue {
  constructor(private readonly db: Db) {}

  /**
   * 落一条待批项。
   *
   * **去重**：同一会话已有**同工具同预览**的 pending 项时不再新建——
   * 模型重试同一句回复不该在队列里堆出三条一样的待办。
   */
  enqueue(input: EnqueueApproval): { item: ApprovalItem; created: boolean } {
    const existing = this.db
      .prepare(
        `SELECT id FROM approvals
          WHERE conversation_id = ? AND tool = ? AND preview = ? AND status = 'pending'`,
      )
      .get(input.conversationId, input.tool, input.preview) as unknown as { id: string } | undefined
    if (existing !== undefined) return { item: this.require(existing.id), created: false }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, tenant_id, conversation_id, channel_id, customer_id, contact_id, tool, args, preview, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.conversationId,
        input.channelId,
        input.customerId,
        input.contactId ?? null,
        input.tool,
        toJsonColumn(input.args),
        input.preview,
        new Date().toISOString(),
      )
    return { item: this.require(id), created: true }
  }

  /**
   * 认领一条待批项进入投递中。
   *
   * 原子状态跃迁：并发点两次「批准」只有一次会成功，另一次拿到 `undefined`。
   */
  claimForDelivery(id: string, reviewer: string, note?: string): ApprovalItem | undefined {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'delivering', reviewer = ?, review_note = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(reviewer, note ?? null, new Date().toISOString(), id)
    return Number(result.changes) > 0 ? this.require(id) : undefined
  }

  /** 驳回。 */
  reject(id: string, reviewer: string, note?: string): ApprovalItem | undefined {
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = 'rejected', reviewer = ?, review_note = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(reviewer, note ?? null, new Date().toISOString(), id)
    return Number(result.changes) > 0 ? this.require(id) : undefined
  }

  /** 标记投递结果。 */
  markDelivered(id: string): void {
    this.db
      .prepare(`UPDATE approvals SET status = 'delivered', delivered_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
  }

  markFailed(id: string, reason: string): void {
    this.db.prepare(`UPDATE approvals SET status = 'failed', error_reason = ? WHERE id = ?`).run(reason, id)
  }

  get(id: string): ApprovalItem | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as Row | undefined
    return row === undefined ? undefined : hydrate(row)
  }

  require(id: string): ApprovalItem {
    const item = this.get(id)
    if (item === undefined) throw new Error(`审批项 ${id} 不存在`)
    return item
  }

  /** 列表（默认只看 pending，新在前）。 */
  list(tenantId: string, status: ApprovalStatus = 'pending', limit = 100): readonly ApprovalItem[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE tenant_id = ? AND status = ? ORDER BY requested_at DESC LIMIT ?')
      .all(tenantId, status, limit) as unknown as Row[]
    return rows.map(hydrate)
  }

  /** 各状态计数，供控制台徽标。 */
  countByStatus(tenantId: string): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM approvals WHERE tenant_id = ? GROUP BY status')
      .all(tenantId) as unknown as { status: string; n: number }[]
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]))
  }
}

interface Row {
  readonly id: string
  readonly tenant_id: string
  readonly conversation_id: string
  readonly channel_id: string
  readonly customer_id: string
  readonly contact_id: string | null
  readonly tool: string
  readonly args: string
  readonly preview: string
  readonly status: string
  readonly reviewer: string | null
  readonly review_note: string | null
  readonly error_reason: string | null
  readonly requested_at: string
  readonly decided_at: string | null
  readonly delivered_at: string | null
}

function hydrate(row: Row): ApprovalItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    customerId: row.customer_id,
    ...(row.contact_id === null ? {} : { contactId: row.contact_id }),
    tool: row.tool,
    args: fromJsonColumn<Record<string, unknown>>(row.args, {}),
    preview: row.preview,
    status: row.status as ApprovalStatus,
    ...(row.reviewer === null ? {} : { reviewer: row.reviewer }),
    ...(row.review_note === null ? {} : { reviewNote: row.review_note }),
    ...(row.error_reason === null ? {} : { errorReason: row.error_reason }),
    requestedAt: new Date(row.requested_at),
    ...(row.decided_at === null ? {} : { decidedAt: new Date(row.decided_at) }),
    ...(row.delivered_at === null ? {} : { deliveredAt: new Date(row.delivered_at) }),
  }
}
