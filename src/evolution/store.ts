/**
 * 演进提案：agent 自己提出的改进，经人工门禁后生效。
 *
 * 这是 OpenCS 的核心差异化——agent 不是静态配置，而是从每次对话里
 * 学到东西并提出改进。但**所有自提改进都必须过人工门禁**：
 * 让模型自主改写自己的行为准则是不可接受的风险。
 *
 * 状态机：
 * ```
 * pending ──eval──> gated ──approve──> approved ──apply──> applied
 *                     │                     │
 *                     └──reject──> rejected └──reject──> rejected
 * ```
 */

import { randomUUID } from 'node:crypto'

import { fromJsonColumn, toJsonColumn } from '../db/json.js'
import type { Db, Migration } from '../db/sqlite.js'
import type { DiffVerdict, Divergence } from './differ.js'
import type { SkillDraft } from './handlers/skill.js'

export const EVOLUTION_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'create_proposals',
    sql: `
      CREATE TABLE proposals (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        dimension     TEXT NOT NULL,
        action        TEXT NOT NULL,
        title         TEXT NOT NULL,
        rationale     TEXT NOT NULL,
        payload       TEXT NOT NULL,
        evidence      TEXT,
        confidence    REAL NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'pending',
        gate_verdict  TEXT,
        gate_reason   TEXT,
        reviewer      TEXT,
        review_note   TEXT,
        source_conversation_id TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_proposals_status ON proposals (tenant_id, status, created_at);
      -- 同一维度同一标题只允许一条未决提案：防止同一问题反复刷屏人工队列
      CREATE UNIQUE INDEX idx_proposals_dedup
        ON proposals (tenant_id, dimension, title)
        WHERE status IN ('pending', 'gated', 'approved');
    `,
  },
  {
    id: 2,
    name: 'create_lineage',
    sql: `
      -- 血缘事件表（spec §3.6）：按时间线性追加，够「看来源 + 看效果」，不建独立 DAG
      CREATE TABLE lineage (
        id          TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        kind        TEXT NOT NULL,
        detail      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_lineage_proposal ON lineage (proposal_id, created_at);
      -- 反查技能走 detail LIKE '%skill=<id>%'，前导通配符无法走索引，低流量表全扫即可，故不建额外索引
    `,
  },
]

/** 可演进的维度。 */
export type ProposalDimension = 'skill' | 'knowledge' | 'memory' | 'cadence'
export type ProposalAction = 'create' | 'update' | 'deprecate'
export type ProposalStatus = 'pending' | 'gated' | 'approved' | 'rejected' | 'applied'
/** 门禁判定。`auto_promote` 仅用于最低风险的维度。 */
export type GateVerdict = 'needs_human' | 'auto_promote' | 'reject'

export interface Proposal {
  readonly id: string
  readonly tenantId: string
  readonly dimension: ProposalDimension
  readonly action: ProposalAction
  readonly title: string
  /** 为什么提这个改进。必须能让审核者独立判断。 */
  readonly rationale: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly evidence: readonly string[]
  readonly confidence: number
  readonly status: ProposalStatus
  readonly gateVerdict?: GateVerdict
  readonly gateReason?: string
  readonly reviewer?: string
  readonly reviewNote?: string
  readonly sourceConversationId?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface ProposeInput {
  readonly tenantId: string
  readonly dimension: ProposalDimension
  readonly action: ProposalAction
  readonly title: string
  readonly rationale: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly evidence?: readonly string[]
  readonly confidence?: number
  readonly sourceConversationId?: string
}

export class ProposalStore {
  constructor(private readonly db: Db) {}

  /**
   * 提出一个改进提案。
   *
   * **去重**：同一 (租户, 维度, 标题) 已有未决提案时不新建，返回已有的那条。
   * 没有这个约束，同一个知识缺口会在每次命中时都提一条，把人工队列刷爆。
   *
   * @param input - 提案内容。
   * @returns 提案与是否新建。
   */
  propose(input: ProposeInput): { proposal: Proposal; created: boolean } {
    const existing = this.findOpen(input.tenantId, input.dimension, input.title)
    if (existing !== undefined) return { proposal: existing, created: false }

    const id = randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO proposals
           (id, tenant_id, dimension, action, title, rationale, payload, evidence, confidence,
            status, source_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.tenantId,
        input.dimension,
        input.action,
        input.title,
        input.rationale,
        toJsonColumn(input.payload),
        toJsonColumn(input.evidence ?? []),
        input.confidence ?? 0.5,
        input.sourceConversationId ?? null,
        now,
        now,
      )
    return { proposal: this.require(id), created: true }
  }

  /** 记录门禁判定。 */
  recordGate(id: string, verdict: GateVerdict, reason: string): Proposal {
    const status: ProposalStatus = verdict === 'reject' ? 'rejected' : verdict === 'auto_promote' ? 'approved' : 'gated'
    this.db
      .prepare('UPDATE proposals SET status = ?, gate_verdict = ?, gate_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, verdict, reason, new Date().toISOString(), id)
    return this.require(id)
  }

  /**
   * 人工审批。
   *
   * @param id - 提案 id。
   * @param approved - 通过或拒绝。
   * @param reviewer - 审核人。
   * @param note - 审核意见。
   * @throws {Error} 提案不在可审批状态。
   */
  review(id: string, approved: boolean, reviewer: string, note?: string): Proposal {
    const proposal = this.require(id)
    if (proposal.status !== 'gated' && proposal.status !== 'pending') {
      throw new Error(`提案 ${id} 当前状态是 ${proposal.status}，不可审批`)
    }
    this.db
      .prepare('UPDATE proposals SET status = ?, reviewer = ?, review_note = ?, updated_at = ? WHERE id = ?')
      .run(approved ? 'approved' : 'rejected', reviewer, note ?? null, new Date().toISOString(), id)
    return this.require(id)
  }

  /** 标记已应用。 */
  markApplied(id: string): Proposal {
    const proposal = this.require(id)
    if (proposal.status !== 'approved') {
      throw new Error(`提案 ${id} 未获批准（当前 ${proposal.status}），不能应用`)
    }
    this.db
      .prepare(`UPDATE proposals SET status = 'applied', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
    return this.require(id)
  }

  /**
   * 记录影子验证结论（curate 的产出，propose 时尽力而为地写入）。
   *
   * 存在 payload 里而不是单开一列：管理端只是**展示**这个证据，从不按它查询，
   * 不值得为一个展示字段加迁移；payload 本就是提案附加元数据的桶（如 suggestion）。
   * 只覆盖 `shadowVerdict`/`shadowDivergences` 两个键，其余 payload 保留。
   *
   * @param id - 提案 id。
   * @param verdict - 差分判定：坏例是否被影子重跑修复。
   * @param divergences - baseline vs replay 的差异记录（可省略，落空数组）。
   * @returns 更新后的提案。
   */
  setShadowVerdict(id: string, verdict: DiffVerdict, divergences?: readonly Divergence[]): Proposal {
    const proposal = this.require(id)
    this.db
      .prepare('UPDATE proposals SET payload = ?, updated_at = ? WHERE id = ?')
      .run(
        toJsonColumn({
          ...proposal.payload,
          shadowVerdict: verdict,
          shadowDivergences: divergences ?? [],
        }),
        new Date().toISOString(),
        id,
      )
    return this.require(id)
  }

  /**
   * 记录技能自策展草案（curate 对 skill 维度提案产出的 SKILL.md 草案）。
   *
   * 与 setShadowVerdict 同风格：存 payload 而不是单开一列——管理端只是**展示**
   * 这份草案，后续 apply-flow 晋升时再真正写 skills/ 目录。只覆盖
   * `skillDraftName`/`skillDraftContent` 两个键，其余 payload 保留。
   *
   * @param id - 提案 id。
   * @param draft - buildSkillDraft 的产出（dsh 可加载的 SKILL.md 草案）。
   * @returns 更新后的提案。
   */
  setSkillDraft(id: string, draft: SkillDraft): Proposal {
    const proposal = this.require(id)
    this.db
      .prepare('UPDATE proposals SET payload = ?, updated_at = ? WHERE id = ?')
      .run(
        toJsonColumn({
          ...proposal.payload,
          skillDraftName: draft.name,
          skillDraftContent: draft.content,
        }),
        new Date().toISOString(),
        id,
      )
    return this.require(id)
  }

  get(id: string): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as unknown as Row | undefined
    return row === undefined ? undefined : hydrate(row)
  }

  require(id: string): Proposal {
    const proposal = this.get(id)
    if (proposal === undefined) throw new Error(`提案 ${id} 不存在`)
    return proposal
  }

  /** 列出提案，可按状态与维度过滤。 */
  list(
    tenantId: string,
    filter: { readonly status?: ProposalStatus; readonly dimension?: ProposalDimension; readonly limit?: number } = {},
  ): readonly Proposal[] {
    const conditions = ['tenant_id = ?']
    const params: (string | number)[] = [tenantId]
    if (filter.status !== undefined) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.dimension !== undefined) {
      conditions.push('dimension = ?')
      params.push(filter.dimension)
    }
    params.push(filter.limit ?? 100)

    const rows = this.db
      .prepare(`SELECT * FROM proposals WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as unknown as Row[]
    return rows.map(hydrate)
  }

  /** 按状态计数，供管理端徽标。 */
  countByStatus(tenantId: string): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM proposals WHERE tenant_id = ? GROUP BY status')
      .all(tenantId) as unknown as { status: string; n: number }[]
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]))
  }

  private findOpen(tenantId: string, dimension: string, title: string): Proposal | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM proposals
          WHERE tenant_id = ? AND dimension = ? AND title = ?
            AND status IN ('pending', 'gated', 'approved')`,
      )
      .get(tenantId, dimension, title) as unknown as Row | undefined
    return row === undefined ? undefined : hydrate(row)
  }
}

interface Row {
  readonly id: string
  readonly tenant_id: string
  readonly dimension: string
  readonly action: string
  readonly title: string
  readonly rationale: string
  readonly payload: string
  readonly evidence: string | null
  readonly confidence: number
  readonly status: string
  readonly gate_verdict: string | null
  readonly gate_reason: string | null
  readonly reviewer: string | null
  readonly review_note: string | null
  readonly source_conversation_id: string | null
  readonly created_at: string
  readonly updated_at: string
}

function hydrate(row: Row): Proposal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    dimension: row.dimension as ProposalDimension,
    action: row.action as ProposalAction,
    title: row.title,
    rationale: row.rationale,
    payload: fromJsonColumn<Record<string, unknown>>(row.payload, {}),
    evidence: fromJsonColumn<string[]>(row.evidence, []),
    confidence: Number(row.confidence),
    status: row.status as ProposalStatus,
    ...(row.gate_verdict === null ? {} : { gateVerdict: row.gate_verdict as GateVerdict }),
    ...(row.gate_reason === null ? {} : { gateReason: row.gate_reason }),
    ...(row.reviewer === null ? {} : { reviewer: row.reviewer }),
    ...(row.review_note === null ? {} : { reviewNote: row.review_note }),
    ...(row.source_conversation_id === null ? {} : { sourceConversationId: row.source_conversation_id }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}
