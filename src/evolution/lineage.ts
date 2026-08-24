/**
 * 血缘追踪：提案与其来源/效果的线性事件时间线（spec §3.6）。
 *
 * 轻量实现：不建独立 DAG，事件按时间线性追加（`lineage` 表随
 * EVOLUTION_MIGRATIONS id=2 迁移创建），够「看来源 + 看效果」即可。
 *
 * kind 取值：
 * - `proposed`       提案提出（detail 记来源会话）
 * - `shadow_verified` 影子 verdict
 * - `applied`        提案生效（detail 记 skill=<skillId>）
 * - `session_hit`    后续会话命中该技能
 * - `eval_feedback`  命中后的评测反馈
 */

import { randomUUID } from 'node:crypto'

import type { Db } from '../db/sqlite.js'

export type LineageKind = 'proposed' | 'shadow_verified' | 'applied' | 'session_hit' | 'eval_feedback'

export interface LineageEvent {
  readonly id: string
  readonly proposalId: string
  readonly kind: LineageKind
  readonly detail?: string
  readonly createdAt: Date
}

export class LineageStore {
  constructor(private readonly db: Db) {}

  /**
   * 追加一条血缘事件。
   *
   * @param proposalId - 提案 id。
   * @param kind - 事件类型。
   * @param detail - 附加信息（来源会话 id、`skill=<skillId>` 等，可省略）。
   * @returns 新写入的事件。
   */
  append(proposalId: string, kind: LineageKind, detail?: string): LineageEvent {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare('INSERT INTO lineage (id, proposal_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, proposalId, kind, detail ?? null, now)
    return { id, proposalId, kind, ...(detail === undefined ? {} : { detail }), createdAt: new Date(now) }
  }

  /** 给定提案 id → 事件时间线（按时间升序）。 */
  forProposal(proposalId: string): readonly LineageEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM lineage WHERE proposal_id = ? ORDER BY created_at ASC')
      .all(proposalId) as unknown as Row[]
    return rows.map(hydrate)
  }

  /** 给定技能 id → 反查所有相关事件（detail 携带 `skill=<skillId>` 的来源与命中）。 */
  forSkill(skillId: string): readonly LineageEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM lineage WHERE detail LIKE '%' || ? || '%' ORDER BY created_at ASC")
      .all(skillId) as unknown as Row[]
    return rows.map(hydrate)
  }
}

interface Row {
  readonly id: string
  readonly proposal_id: string
  readonly kind: string
  readonly detail: string | null
  readonly created_at: string
}

function hydrate(row: Row): LineageEvent {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    kind: row.kind as LineageKind,
    ...(row.detail === null ? {} : { detail: row.detail }),
    createdAt: new Date(row.created_at),
  }
}
