/**
 * 发件箱：持久化的待发队列 + 租约 + 投递回执。
 *
 * 三层防重复发送（research §4 教训 #2）：
 * 1. `(cadence_run_id, step_order)` **唯一约束** —— 最后一道防线，
 *    即使上层逻辑全错，同一步也只可能有一条发件记录
 * 2. **租约**：worker 领取时写 `worker_id` + `lease_until`，其他 worker 看不到
 * 3. **状态机**：`pending → sending → sent|failed`，只有 `pending` 可被领取
 */

import { randomUUID } from 'node:crypto'

import { type Db, type Migration, transaction } from '../db/sqlite.js'

export const OUTREACH_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_sends',
    sql: `
      CREATE TABLE sends (
        id             TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL,
        cadence_run_id TEXT NOT NULL,
        step_order     INTEGER NOT NULL,
        contact_id     TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        customer_id    TEXT NOT NULL,
        content        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        scheduled_at   TEXT NOT NULL,
        sent_at        TEXT,
        failed_at      TEXT,
        error_reason   TEXT,
        worker_id      TEXT,
        lease_until    TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      -- 幂等的最后防线：同一次运行的同一步只可能有一条发件记录
      CREATE UNIQUE INDEX idx_sends_run_step ON sends (cadence_run_id, step_order);
      CREATE INDEX idx_sends_claimable ON sends (status, scheduled_at);
      CREATE INDEX idx_sends_contact ON sends (contact_id, created_at);

      CREATE TABLE delivery_receipts (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        send_id    TEXT NOT NULL REFERENCES sends (id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        detail     TEXT,
        at         TEXT NOT NULL
      );
      CREATE INDEX idx_receipts_send ON delivery_receipts (send_id, seq);
    `,
  },
]

export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed'

export interface SendRequest {
  readonly tenantId: string
  readonly cadenceRunId: string
  readonly stepOrder: number
  readonly contactId: string
  readonly channelId: string
  readonly customerId: string
  readonly content: string
  readonly scheduledAt: Date
}

export interface Send {
  readonly id: string
  readonly tenantId: string
  readonly cadenceRunId: string
  readonly stepOrder: number
  readonly contactId: string
  readonly channelId: string
  readonly customerId: string
  readonly content: string
  readonly status: SendStatus
  readonly scheduledAt: Date
  readonly sentAt?: Date
  readonly failedAt?: Date
  readonly errorReason?: string
  readonly attempts: number
}

interface SendRow {
  readonly id: string
  readonly tenant_id: string
  readonly cadence_run_id: string
  readonly step_order: number
  readonly contact_id: string
  readonly channel_id: string
  readonly customer_id: string
  readonly content: string
  readonly status: string
  readonly scheduled_at: string
  readonly sent_at: string | null
  readonly failed_at: string | null
  readonly error_reason: string | null
  readonly attempts: number
}

/** 重试上限。超过后标记为最终失败，不再领取——避免坏消息无限占用并发槽。 */
export const MAX_ATTEMPTS = 3

export class SendOutbox {
  constructor(private readonly db: Db) {}

  /**
   * 入队一条待发消息。
   *
   * **幂等**：同一 `(cadenceRunId, stepOrder)` 重复入队不会产生第二条，
   * 返回已存在的那条。这让「materialize 阶段重跑」完全安全。
   *
   * @param request - 发件请求。
   * @returns 入队后的发件记录。
   */
  enqueue(request: SendRequest): Send {
    return transaction(this.db, () => {
      const existing = this.findByRunStep(request.cadenceRunId, request.stepOrder)
      if (existing !== undefined) return existing

      const now = new Date().toISOString()
      const id = randomUUID()
      this.db
        .prepare(
          `INSERT INTO sends
             (id, tenant_id, cadence_run_id, step_order, contact_id, channel_id, customer_id,
              content, status, scheduled_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          request.tenantId,
          request.cadenceRunId,
          request.stepOrder,
          request.contactId,
          request.channelId,
          request.customerId,
          request.content,
          request.scheduledAt.toISOString(),
          now,
          now,
        )
      this.appendReceipt(id, 'queued')
      return this.require(id)
    })
  }

  /**
   * 领取一批到期的待发消息。
   *
   * 领取即写租约：其他 worker 在 `leaseUntil` 之前看不到这批。
   *
   * **租约时长怎么定**（教训 #2）：`单条投递耗时 × 批大小 ÷ 并发度 × 安全系数`。
   * LLM 组稿约 40 秒/条，批 50、并发 8 → 40 × 50 ÷ 8 × 1.2 ≈ 300 秒。
   * 设得太短会让还在处理的消息被别的 worker 重新领走 → **重复发送**。
   *
   * @param workerId - 领取者标识。
   * @param batchSize - 批大小。
   * @param leaseSeconds - 租约时长。
   * @param now - 当前时刻。
   * @returns 领取到的发件记录。
   */
  claim(workerId: string, batchSize: number, leaseSeconds: number, now = new Date()): readonly Send[] {
    return transaction(this.db, () => {
      const nowIso = now.toISOString()
      const rows = this.db
        .prepare(
          `SELECT * FROM sends
            WHERE status = 'pending' AND scheduled_at <= ? AND attempts < ?
            ORDER BY scheduled_at, id
            LIMIT ?`,
        )
        .all(nowIso, MAX_ATTEMPTS, batchSize) as unknown as SendRow[]

      const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString()
      const update = this.db.prepare(
        `UPDATE sends SET status = 'sending', worker_id = ?, lease_until = ?,
           attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`,
      )
      const claimed: Send[] = []
      for (const row of rows) {
        const result = update.run(workerId, leaseUntil, nowIso, row.id)
        // changes === 0 表示被别的事务抢先了——跳过而不是报错
        if (Number(result.changes) > 0) claimed.push(this.require(row.id))
      }
      return claimed
    })
  }

  /**
   * 回收过期租约：把 `sending` 且租约已过的消息放回 `pending`。
   *
   * 持续回收到东西是**告警信号**——说明并发度不足或租约时长过短，
   * 正在制造重复发送的风险。
   *
   * @param now - 当前时刻。
   * @returns 回收的条数。
   */
  reapExpiredLeases(now = new Date()): number {
    const result = this.db
      .prepare(
        `UPDATE sends SET status = 'pending', worker_id = NULL, lease_until = NULL, updated_at = ?
          WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until < ?`,
      )
      .run(now.toISOString(), now.toISOString())
    return Number(result.changes)
  }

  /** 标记发送成功。 */
  markSent(id: string, now = new Date()): void {
    this.db
      .prepare(
        `UPDATE sends SET status = 'sent', sent_at = ?, worker_id = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now.toISOString(), now.toISOString(), id)
    this.appendReceipt(id, 'sent')
  }

  /**
   * 标记发送失败。
   *
   * @param id - 发件 id。
   * @param reason - 失败原因。
   * @param retryable - 是否可重试。可重试且未超次数则放回 `pending`。
   * @param now - 当前时刻。
   */
  markFailed(id: string, reason: string, retryable: boolean, now = new Date()): void {
    const send = this.get(id)
    const exhausted = send === undefined || send.attempts >= MAX_ATTEMPTS
    const finalFailure = !retryable || exhausted

    this.db
      .prepare(
        `UPDATE sends SET status = ?, failed_at = ?, error_reason = ?,
           worker_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(finalFailure ? 'failed' : 'pending', now.toISOString(), reason, now.toISOString(), id)
    this.appendReceipt(id, finalFailure ? 'failed' : 'retry', reason)
  }

  /** 按 id 取发件记录。 */
  get(id: string): Send | undefined {
    const row = this.db.prepare('SELECT * FROM sends WHERE id = ?').get(id) as unknown as SendRow | undefined
    return row === undefined ? undefined : hydrate(row)
  }

  /** 按 (运行, 步骤) 取发件记录。 */
  findByRunStep(cadenceRunId: string, stepOrder: number): Send | undefined {
    const row = this.db
      .prepare('SELECT * FROM sends WHERE cadence_run_id = ? AND step_order = ?')
      .get(cadenceRunId, stepOrder) as unknown as SendRow | undefined
    return row === undefined ? undefined : hydrate(row)
  }

  /** 某联系人最近的成功触达时刻，用于周频控。 */
  recentTouches(contactId: string, since: Date): readonly Date[] {
    const rows = this.db
      .prepare(`SELECT sent_at FROM sends WHERE contact_id = ? AND status = 'sent' AND sent_at >= ?`)
      .all(contactId, since.toISOString()) as unknown as { sent_at: string }[]
    return rows.map((row) => new Date(row.sent_at))
  }

  /** 按状态统计，供运维面板。 */
  countByStatus(tenantId: string): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM sends WHERE tenant_id = ? GROUP BY status')
      .all(tenantId) as unknown as { status: string; n: number }[]
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]))
  }

  /** 读取投递回执。 */
  receipts(sendId: string): readonly { readonly eventType: string; readonly detail?: string; readonly at: Date }[] {
    const rows = this.db
      .prepare('SELECT event_type, detail, at FROM delivery_receipts WHERE send_id = ? ORDER BY seq')
      .all(sendId) as unknown as { event_type: string; detail: string | null; at: string }[]
    return rows.map((row) => ({
      eventType: row.event_type,
      ...(row.detail === null ? {} : { detail: row.detail }),
      at: new Date(row.at),
    }))
  }

  private appendReceipt(sendId: string, eventType: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO delivery_receipts (send_id, event_type, detail, at) VALUES (?, ?, ?, ?)')
      .run(sendId, eventType, detail ?? null, new Date().toISOString())
  }

  private require(id: string): Send {
    const send = this.get(id)
    if (send === undefined) throw new Error(`发件记录 ${id} 刚写入却读不到——数据库状态异常`)
    return send
  }
}

function hydrate(row: SendRow): Send {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cadenceRunId: row.cadence_run_id,
    stepOrder: Number(row.step_order),
    contactId: row.contact_id,
    channelId: row.channel_id,
    customerId: row.customer_id,
    content: row.content,
    status: row.status as SendStatus,
    scheduledAt: new Date(row.scheduled_at),
    ...(row.sent_at === null ? {} : { sentAt: new Date(row.sent_at) }),
    ...(row.failed_at === null ? {} : { failedAt: new Date(row.failed_at) }),
    ...(row.error_reason === null ? {} : { errorReason: row.error_reason }),
    attempts: Number(row.attempts),
  }
}
