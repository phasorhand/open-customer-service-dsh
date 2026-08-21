/**
 * 评测结果存储。
 *
 * 用途有二：
 * 1. 找出低分会话 → 触发演进提案（`src/evolution/`）
 * 2. 给运营一个「质量随时间的趋势」而不是只有单点告警
 */

import { randomUUID } from 'node:crypto'

import { fromJsonColumn, toJsonColumn } from '../db/json.js'
import type { Db, Migration } from '../db/sqlite.js'
import type { MetricResult } from './cs-metrics.js'

export const EVAL_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_eval_results',
    sql: `
      CREATE TABLE eval_results (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        mode            TEXT NOT NULL,
        passed          INTEGER NOT NULL,
        overall_score   REAL NOT NULL,
        metrics         TEXT NOT NULL,
        input_text      TEXT,
        output_text     TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_eval_conversation ON eval_results (conversation_id, created_at);
      CREATE INDEX idx_eval_failing ON eval_results (tenant_id, passed, created_at);
    `,
  },
]

/** 触发时机。 */
export type EvalMode = 'realtime' | 'gate' | 'batch'

export interface EvalResult {
  readonly id: string
  readonly tenantId: string
  readonly conversationId: string
  readonly mode: EvalMode
  readonly passed: boolean
  readonly overallScore: number
  readonly metrics: readonly MetricResult[]
  readonly inputText?: string
  readonly outputText?: string
  readonly createdAt: Date
}

export interface SaveEvalInput {
  readonly tenantId: string
  readonly conversationId: string
  readonly mode: EvalMode
  readonly passed: boolean
  readonly metrics: readonly MetricResult[]
  readonly inputText?: string
  readonly outputText?: string
}

export class EvalStore {
  constructor(private readonly db: Db) {}

  /** 保存一次评测结果。 */
  save(input: SaveEvalInput): EvalResult {
    const id = randomUUID()
    const now = new Date()
    const overall =
      input.metrics.length === 0
        ? 0
        : input.metrics.reduce((sum, metric) => sum + metric.score, 0) / input.metrics.length

    this.db
      .prepare(
        `INSERT INTO eval_results
           (id, tenant_id, conversation_id, mode, passed, overall_score, metrics, input_text, output_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.conversationId,
        input.mode,
        input.passed ? 1 : 0,
        overall,
        toJsonColumn(input.metrics),
        input.inputText ?? null,
        input.outputText ?? null,
        now.toISOString(),
      )

    return {
      id,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      mode: input.mode,
      passed: input.passed,
      overallScore: overall,
      metrics: input.metrics,
      ...(input.inputText === undefined ? {} : { inputText: input.inputText }),
      ...(input.outputText === undefined ? {} : { outputText: input.outputText }),
      createdAt: now,
    }
  }

  /** 某会话的全部评测结果。 */
  byConversation(conversationId: string, limit = 100): readonly EvalResult[] {
    return this.query('SELECT * FROM eval_results WHERE conversation_id = ? ORDER BY created_at LIMIT ?', [
      conversationId,
      limit,
    ])
  }

  /**
   * 未通过的评测结果。
   *
   * 这是演进提案的**输入源**——低分会话正是需要改进技能/知识的地方。
   */
  failing(tenantId: string, limit = 50): readonly EvalResult[] {
    return this.query(
      'SELECT * FROM eval_results WHERE tenant_id = ? AND passed = 0 ORDER BY created_at DESC LIMIT ?',
      [tenantId, limit],
    )
  }

  /** 质量汇总，供运营看趋势。 */
  summary(tenantId: string): {
    readonly total: number
    readonly passed: number
    readonly passRate: number
    readonly averageScore: number
    readonly failuresByMetric: Readonly<Record<string, number>>
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(passed) AS passed, AVG(overall_score) AS avg
           FROM eval_results WHERE tenant_id = ?`,
      )
      .get(tenantId) as unknown as { total: number; passed: number | null; avg: number | null }

    const total = Number(row.total)
    const passed = Number(row.passed ?? 0)

    const failuresByMetric: Record<string, number> = {}
    for (const result of this.query('SELECT * FROM eval_results WHERE tenant_id = ? AND passed = 0', [tenantId])) {
      for (const metric of result.metrics) {
        if (metric.passed) continue
        failuresByMetric[metric.name] = (failuresByMetric[metric.name] ?? 0) + 1
      }
    }

    return {
      total,
      passed,
      passRate: total === 0 ? 1 : Number((passed / total).toFixed(3)),
      averageScore: Number((row.avg ?? 0).toFixed(3)),
      failuresByMetric,
    }
  }

  private query(sql: string, params: readonly (string | number)[]): readonly EvalResult[] {
    const rows = this.db.prepare(sql).all(...params) as unknown as {
      id: string
      tenant_id: string
      conversation_id: string
      mode: string
      passed: number
      overall_score: number
      metrics: string
      input_text: string | null
      output_text: string | null
      created_at: string
    }[]
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      mode: row.mode as EvalMode,
      passed: row.passed === 1,
      overallScore: Number(row.overall_score),
      metrics: fromJsonColumn<MetricResult[]>(row.metrics, []),
      ...(row.input_text === null ? {} : { inputText: row.input_text }),
      ...(row.output_text === null ? {} : { outputText: row.output_text }),
      createdAt: new Date(row.created_at),
    }))
  }
}
