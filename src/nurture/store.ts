/**
 * 节奏与运行的持久化。
 */

import { randomUUID } from 'node:crypto'

import type { AudienceFilter, LifecycleStage } from '../crm/types.js'
import { fromJsonColumn, toJsonColumn } from '../db/json.js'
import { type Db, type Migration, transaction } from '../db/sqlite.js'
import {
  CADENCE_DEFAULTS,
  type Cadence,
  type CadenceRun,
  type CadenceStatus,
  type CadenceStep,
  type FinishReason,
  type RunState,
} from './types.js'

export const NURTURE_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_cadences',
    sql: `
      CREATE TABLE cadences (
        id                  TEXT PRIMARY KEY,
        tenant_id           TEXT NOT NULL,
        name                TEXT NOT NULL,
        description         TEXT,
        channel_id          TEXT NOT NULL,
        sender_persona      TEXT,
        auto_enroll         INTEGER NOT NULL DEFAULT 0,
        entry_filter        TEXT,
        exit_on_reply       INTEGER NOT NULL DEFAULT 1,
        exit_on_stage       TEXT,
        quiet_hours_start   INTEGER NOT NULL DEFAULT 22,
        quiet_hours_end     INTEGER NOT NULL DEFAULT 9,
        timezone            TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        max_touches_per_week INTEGER NOT NULL DEFAULT 3,
        status              TEXT NOT NULL DEFAULT 'draft',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
      CREATE INDEX idx_cadences_tenant ON cadences (tenant_id, status);

      CREATE TABLE cadence_steps (
        id            TEXT PRIMARY KEY,
        cadence_id    TEXT NOT NULL REFERENCES cadences (id) ON DELETE CASCADE,
        step_order    INTEGER NOT NULL,
        delay_seconds INTEGER NOT NULL DEFAULT 0,
        goal          TEXT,
        template      TEXT,
        UNIQUE (cadence_id, step_order)
      );

      CREATE TABLE cadence_runs (
        id                 TEXT PRIMARY KEY,
        tenant_id          TEXT NOT NULL,
        cadence_id         TEXT NOT NULL REFERENCES cadences (id) ON DELETE CASCADE,
        contact_id         TEXT NOT NULL,
        current_step_order INTEGER NOT NULL DEFAULT 0,
        state              TEXT NOT NULL DEFAULT 'active',
        next_action_at     TEXT NOT NULL,
        step_entered_at    TEXT NOT NULL,
        finish_reason      TEXT,
        error_reason       TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      -- 一个联系人在一个节奏里最多一条运行：防止重复入组导致重复触达
      CREATE UNIQUE INDEX idx_runs_unique ON cadence_runs (cadence_id, contact_id);
      CREATE INDEX idx_runs_due ON cadence_runs (state, next_action_at);
    `,
  },
]

export interface CadenceInput {
  readonly tenantId: string
  readonly name: string
  readonly channelId: string
  readonly description?: string
  readonly senderPersona?: string
  readonly autoEnroll?: boolean
  readonly entryFilter?: AudienceFilter
  readonly exitOnReply?: boolean
  readonly exitOnStage?: LifecycleStage
  readonly quietHoursStart?: number
  readonly quietHoursEnd?: number
  readonly timezone?: string
  readonly maxTouchesPerWeek?: number
  readonly steps: readonly Omit<CadenceStep, 'id' | 'cadenceId'>[]
}

export class CadenceStore {
  constructor(private readonly db: Db) {}

  /** 创建节奏（含步骤）。默认 `draft` 状态，需显式激活才会运行。 */
  create(input: CadenceInput): Cadence {
    return transaction(this.db, () => {
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO cadences
             (id, tenant_id, name, description, channel_id, sender_persona, auto_enroll, entry_filter,
              exit_on_reply, exit_on_stage, quiet_hours_start, quiet_hours_end, timezone,
              max_touches_per_week, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          id,
          input.tenantId,
          input.name,
          input.description ?? null,
          input.channelId,
          input.senderPersona ?? null,
          input.autoEnroll === true ? 1 : 0,
          toJsonColumn(input.entryFilter),
          input.exitOnReply === false ? 0 : 1,
          input.exitOnStage ?? null,
          input.quietHoursStart ?? CADENCE_DEFAULTS.quietHoursStart,
          input.quietHoursEnd ?? CADENCE_DEFAULTS.quietHoursEnd,
          input.timezone ?? CADENCE_DEFAULTS.timezone,
          input.maxTouchesPerWeek ?? CADENCE_DEFAULTS.maxTouchesPerWeek,
          now,
          now,
        )
      this.replaceSteps(id, input.steps)
      return this.require(id)
    })
  }

  /** 替换节奏的全部步骤。 */
  replaceSteps(cadenceId: string, steps: readonly Omit<CadenceStep, 'id' | 'cadenceId'>[]): void {
    this.db.prepare('DELETE FROM cadence_steps WHERE cadence_id = ?').run(cadenceId)
    const insert = this.db.prepare(
      'INSERT INTO cadence_steps (id, cadence_id, step_order, delay_seconds, goal, template) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const step of steps) {
      insert.run(randomUUID(), cadenceId, step.stepOrder, step.delaySeconds, step.goal ?? null, step.template ?? null)
    }
  }

  /** 变更节奏状态。 */
  setStatus(id: string, status: CadenceStatus): void {
    this.db
      .prepare('UPDATE cadences SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
  }

  /** 更新发件人身份。 */
  setSenderPersona(id: string, persona: string | undefined): void {
    this.db
      .prepare('UPDATE cadences SET sender_persona = ?, updated_at = ? WHERE id = ?')
      .run(persona ?? null, new Date().toISOString(), id)
  }

  get(id: string): Cadence | undefined {
    const row = this.db.prepare('SELECT * FROM cadences WHERE id = ?').get(id) as unknown as CadenceRow | undefined
    return row === undefined ? undefined : this.hydrate(row)
  }

  require(id: string): Cadence {
    const cadence = this.get(id)
    if (cadence === undefined) throw new Error(`节奏 ${id} 不存在`)
    return cadence
  }

  list(tenantId: string): readonly Cadence[] {
    const rows = this.db
      .prepare('SELECT * FROM cadences WHERE tenant_id = ? ORDER BY created_at DESC')
      .all(tenantId) as unknown as CadenceRow[]
    return rows.map((row) => this.hydrate(row))
  }

  /** 列出全部已激活的节奏（跨租户，供引擎轮询）。 */
  listActive(): readonly Cadence[] {
    const rows = this.db
      .prepare(`SELECT * FROM cadences WHERE status = 'active' ORDER BY created_at`)
      .all() as unknown as CadenceRow[]
    return rows.map((row) => this.hydrate(row))
  }

  /**
   * 把联系人加入节奏。
   *
   * **幂等**：同一 (节奏, 联系人) 重复入组返回已有运行，不会产生第二条。
   * 这是唯一索引 `idx_runs_unique` 保证的。
   *
   * @returns 运行记录与是否新建。
   */
  enroll(cadence: Cadence, contactId: string, now: Date): { run: CadenceRun; created: boolean } {
    return transaction(this.db, () => {
      const existing = this.findRun(cadence.id, contactId)
      if (existing !== undefined) return { run: existing, created: false }

      const firstStep = [...cadence.steps].sort((a, b) => a.stepOrder - b.stepOrder)[0]
      const delay = firstStep?.delaySeconds ?? 0
      const id = randomUUID()
      const iso = now.toISOString()
      this.db
        .prepare(
          `INSERT INTO cadence_runs
             (id, tenant_id, cadence_id, contact_id, current_step_order, state, next_action_at,
              step_entered_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          id,
          cadence.tenantId,
          cadence.id,
          contactId,
          firstStep?.stepOrder ?? 0,
          new Date(now.getTime() + delay * 1000).toISOString(),
          iso,
          iso,
          iso,
        )
      return { run: this.requireRun(id), created: true }
    })
  }

  findRun(cadenceId: string, contactId: string): CadenceRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM cadence_runs WHERE cadence_id = ? AND contact_id = ?')
      .get(cadenceId, contactId) as unknown as RunRow | undefined
    return row === undefined ? undefined : hydrateRun(row)
  }

  getRun(id: string): CadenceRun | undefined {
    const row = this.db.prepare('SELECT * FROM cadence_runs WHERE id = ?').get(id) as unknown as RunRow | undefined
    return row === undefined ? undefined : hydrateRun(row)
  }

  requireRun(id: string): CadenceRun {
    const run = this.getRun(id)
    if (run === undefined) throw new Error(`节奏运行 ${id} 不存在`)
    return run
  }

  /** 列出所有活跃运行。 */
  listActiveRuns(tenantId?: string): readonly CadenceRun[] {
    const rows = (
      tenantId === undefined
        ? this.db.prepare(`SELECT * FROM cadence_runs WHERE state = 'active' ORDER BY next_action_at`).all()
        : this.db
            .prepare(`SELECT * FROM cadence_runs WHERE state = 'active' AND tenant_id = ? ORDER BY next_action_at`)
            .all(tenantId)
    ) as unknown as RunRow[]
    return rows.map((row) => hydrateRun(row))
  }

  /** 列出到期待执行的运行。 */
  listDueRuns(now: Date, limit = 500): readonly CadenceRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM cadence_runs WHERE state = 'active' AND next_action_at <= ? ORDER BY next_action_at LIMIT ?`)
      .all(now.toISOString(), limit) as unknown as RunRow[]
    return rows.map((row) => hydrateRun(row))
  }

  /** 推进到下一步。 */
  advanceRun(id: string, nextStepOrder: number, nextActionAt: Date, now: Date): void {
    this.db
      .prepare(
        `UPDATE cadence_runs SET current_step_order = ?, next_action_at = ?, step_entered_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(nextStepOrder, nextActionAt.toISOString(), now.toISOString(), now.toISOString(), id)
  }

  /** 推迟当前步（静默时段/频控）。不改步骤序号。 */
  deferRun(id: string, nextActionAt: Date, now: Date): void {
    this.db
      .prepare('UPDATE cadence_runs SET next_action_at = ?, updated_at = ? WHERE id = ?')
      .run(nextActionAt.toISOString(), now.toISOString(), id)
  }

  /** 结束运行。 */
  finishRun(id: string, reason: FinishReason, now: Date, errorReason?: string): void {
    this.db
      .prepare(
        `UPDATE cadence_runs SET state = 'finished', finish_reason = ?, error_reason = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(reason, errorReason ?? null, now.toISOString(), id)
  }

  /** 设置运行状态（暂停/恢复）。 */
  setRunState(id: string, state: RunState, now: Date): void {
    this.db.prepare('UPDATE cadence_runs SET state = ?, updated_at = ? WHERE id = ?').run(state, now.toISOString(), id)
  }

  /** 运行状态统计，供运维面板。 */
  runStats(tenantId: string): { readonly byState: Record<string, number>; readonly byFinishReason: Record<string, number> } {
    const states = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM cadence_runs WHERE tenant_id = ? GROUP BY state')
      .all(tenantId) as unknown as { state: string; n: number }[]
    const reasons = this.db
      .prepare(
        'SELECT finish_reason AS reason, COUNT(*) AS n FROM cadence_runs WHERE tenant_id = ? AND finish_reason IS NOT NULL GROUP BY finish_reason',
      )
      .all(tenantId) as unknown as { reason: string; n: number }[]
    return {
      byState: Object.fromEntries(states.map((row) => [row.state, Number(row.n)])),
      byFinishReason: Object.fromEntries(reasons.map((row) => [row.reason, Number(row.n)])),
    }
  }

  private stepsOf(cadenceId: string): readonly CadenceStep[] {
    const rows = this.db
      .prepare('SELECT * FROM cadence_steps WHERE cadence_id = ? ORDER BY step_order')
      .all(cadenceId) as unknown as {
      id: string
      cadence_id: string
      step_order: number
      delay_seconds: number
      goal: string | null
      template: string | null
    }[]
    return rows.map((row) => ({
      id: row.id,
      cadenceId: row.cadence_id,
      stepOrder: Number(row.step_order),
      delaySeconds: Number(row.delay_seconds),
      ...(row.goal === null ? {} : { goal: row.goal }),
      ...(row.template === null ? {} : { template: row.template }),
    }))
  }

  private hydrate(row: CadenceRow): Cadence {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      channelId: row.channel_id,
      ...(row.sender_persona === null ? {} : { senderPersona: row.sender_persona }),
      autoEnroll: row.auto_enroll === 1,
      ...(row.entry_filter === null ? {} : { entryFilter: fromJsonColumn<AudienceFilter>(row.entry_filter, {}) }),
      exitOnReply: row.exit_on_reply === 1,
      ...(row.exit_on_stage === null ? {} : { exitOnStage: row.exit_on_stage as LifecycleStage }),
      quietHoursStart: Number(row.quiet_hours_start),
      quietHoursEnd: Number(row.quiet_hours_end),
      timezone: row.timezone,
      maxTouchesPerWeek: Number(row.max_touches_per_week),
      status: row.status as CadenceStatus,
      steps: this.stepsOf(row.id),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }
  }
}

interface CadenceRow {
  readonly id: string
  readonly tenant_id: string
  readonly name: string
  readonly description: string | null
  readonly channel_id: string
  readonly sender_persona: string | null
  readonly auto_enroll: number
  readonly entry_filter: string | null
  readonly exit_on_reply: number
  readonly exit_on_stage: string | null
  readonly quiet_hours_start: number
  readonly quiet_hours_end: number
  readonly timezone: string
  readonly max_touches_per_week: number
  readonly status: string
  readonly created_at: string
  readonly updated_at: string
}

interface RunRow {
  readonly id: string
  readonly tenant_id: string
  readonly cadence_id: string
  readonly contact_id: string
  readonly current_step_order: number
  readonly state: string
  readonly next_action_at: string
  readonly step_entered_at: string
  readonly finish_reason: string | null
  readonly error_reason: string | null
  readonly created_at: string
  readonly updated_at: string
}

function hydrateRun(row: RunRow): CadenceRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    cadenceId: row.cadence_id,
    contactId: row.contact_id,
    currentStepOrder: Number(row.current_step_order),
    state: row.state as RunState,
    nextActionAt: new Date(row.next_action_at),
    stepEnteredAt: new Date(row.step_entered_at),
    ...(row.finish_reason === null ? {} : { finishReason: row.finish_reason as FinishReason }),
    ...(row.error_reason === null ? {} : { errorReason: row.error_reason }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}
