/**
 * 持久化审计：每一次风险裁决都落库。
 *
 * 为什么不能只靠内存投影：合规客户（金融/医疗/教育）的安全评审会问
 * 「三个月前那条外呼是谁批的、依据什么」——重启即失的内存数组答不上来。
 *
 * 为什么不能只靠 session 日志：session 按会话组织，跨会话查询
 * （「昨天全部 deny 了哪些」）需要扫全部文件；且 `SESSION_FORMAT_VERSION = 0`
 * 无兼容承诺，不能把合规责任押在 pre-release 格式上。
 */

import type { Db, Migration } from '../db/sqlite.js'

export const AUDIT_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_audit_entries',
    sql: `
      -- seq 是插入序：同毫秒多条裁决不乱序（与 contact_events 同理）
      CREATE TABLE audit_entries (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id       TEXT,
        conversation_id TEXT,
        tool            TEXT NOT NULL,
        tier            INTEGER NOT NULL,
        decision        TEXT NOT NULL,
        reason          TEXT,
        at              TEXT NOT NULL
      );
      CREATE INDEX idx_audit_at ON audit_entries (at);
      CREATE INDEX idx_audit_decision ON audit_entries (decision, at);
      CREATE INDEX idx_audit_tool ON audit_entries (tool, at);
    `,
  },
]

export interface AuditEntry {
  readonly seq: number
  readonly tenantId?: string
  readonly conversationId?: string
  readonly tool: string
  readonly tier: number
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly at: Date
}

export interface AuditAppend {
  readonly tenantId?: string
  readonly conversationId?: string
  readonly tool: string
  readonly tier: number
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly at: Date
}

export interface AuditFilter {
  readonly decision?: 'allow' | 'ask' | 'deny'
  readonly tool?: string
  readonly since?: Date
  readonly limit?: number
  readonly offset?: number
}

export class AuditStore {
  constructor(private readonly db: Db) {}

  /** 追加一条裁决记录。审计是旁路——它自身出错不该打断工具执行，由调用方兜。 */
  append(entry: AuditAppend): void {
    this.db
      .prepare(
        `INSERT INTO audit_entries (tenant_id, conversation_id, tool, tier, decision, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tenantId ?? null,
        entry.conversationId ?? null,
        entry.tool,
        entry.tier,
        entry.decision,
        entry.reason ?? null,
        entry.at.toISOString(),
      )
  }

  /** 查询审计记录（新在前）。 */
  list(filter: AuditFilter = {}): readonly AuditEntry[] {
    const conditions: string[] = ['1=1']
    const params: (string | number)[] = []
    if (filter.decision !== undefined) {
      conditions.push('decision = ?')
      params.push(filter.decision)
    }
    if (filter.tool !== undefined) {
      conditions.push('tool = ?')
      params.push(filter.tool)
    }
    if (filter.since !== undefined) {
      conditions.push('at >= ?')
      params.push(filter.since.toISOString())
    }
    params.push(filter.limit ?? 100, filter.offset ?? 0)

    const rows = this.db
      .prepare(`SELECT * FROM audit_entries WHERE ${conditions.join(' AND ')} ORDER BY seq DESC LIMIT ? OFFSET ?`)
      .all(...params) as unknown as {
      seq: number
      tenant_id: string | null
      conversation_id: string | null
      tool: string
      tier: number
      decision: string
      reason: string | null
      at: string
    }[]
    return rows.map((row) => ({
      seq: Number(row.seq),
      ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
      ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
      tool: row.tool,
      tier: Number(row.tier),
      decision: row.decision as AuditEntry['decision'],
      ...(row.reason === null ? {} : { reason: row.reason }),
      at: new Date(row.at),
    }))
  }

  /** 总数（分页用）。 */
  count(filter: Pick<AuditFilter, 'decision' | 'tool'> = {}): number {
    const conditions: string[] = ['1=1']
    const params: string[] = []
    if (filter.decision !== undefined) {
      conditions.push('decision = ?')
      params.push(filter.decision)
    }
    if (filter.tool !== undefined) {
      conditions.push('tool = ?')
      params.push(filter.tool)
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_entries WHERE ${conditions.join(' AND ')}`)
      .get(...params) as unknown as { n: number }
    return Number(row.n)
  }
}
