/**
 * 演进门禁：决定一条提案是自动生效、需人工确认、还是直接驳回。
 *
 * 核心立场：**改变 agent 行为准则的提案永远需要人工确认**。
 * 自动放行只留给「纯增量、不改变已有行为」的最低风险情形。
 *
 * 这不是保守——让模型自主改写自己的准则，等于把「不做超范围承诺」
 * 这类红线交给它自己决定要不要遵守。
 */

import type { EvalStore } from '../evaluation/store.js'
import type { GateVerdict, Proposal, ProposalDimension, ProposalStore } from './store.js'

/** 各维度的风险级别。数值越高越需要人工把关。 */
const DIMENSION_RISK: Readonly<Record<ProposalDimension, number>> = {
  // 技能是 agent 的行为准则，改它等于改 agent 的行为——永远人工
  skill: 3,
  // 节奏直接决定发给客户什么、发几次
  cadence: 3,
  // 知识是事实来源，错的知识会被当成政策讲给客户
  knowledge: 2,
  // 长期记忆只影响个别客户的画像
  memory: 1,
}

/** 自动放行的门槛：只有风险 ≤1 且置信度极高才可能自动生效。 */
const AUTO_PROMOTE_MAX_RISK = 1
const AUTO_PROMOTE_MIN_CONFIDENCE = 0.9

export interface GateResult {
  readonly verdict: GateVerdict
  readonly reason: string
}

export interface GateOptions {
  /**
   * 是否允许任何自动放行。默认 `false`——
   * 生产开启前应先积累一段人工审批数据，确认提案质量。
   */
  readonly allowAutoPromote?: boolean
  /** 提案证据不足的最低条数。 */
  readonly minEvidence?: number
}

export class EvolutionGate {
  constructor(
    private readonly proposals: ProposalStore,
    private readonly evals: EvalStore,
    private readonly options: GateOptions = {},
  ) {}

  /**
   * 评估一条提案并把判定写回存储。
   *
   * @param proposalId - 提案 id。
   * @returns 判定结果。
   */
  evaluate(proposalId: string): GateResult {
    const proposal = this.proposals.require(proposalId)
    const result = this.judge(proposal)
    this.proposals.recordGate(proposalId, result.verdict, result.reason)
    return result
  }

  /**
   * 纯判定逻辑，不写库。抽出来便于单测与「预览门禁结论」。
   *
   * @param proposal - 提案。
   * @returns 判定结果。
   */
  judge(proposal: Proposal): GateResult {
    const minEvidence = this.options.minEvidence ?? 1

    // ① 证据不足直接驳回：没有依据的改进不该占用人工时间
    if (proposal.evidence.length < minEvidence) {
      return {
        verdict: 'reject',
        reason: `证据不足（${proposal.evidence.length} < ${minEvidence} 条），无法判断改进是否成立`,
      }
    }

    // ② 理由过短同样驳回——审核者需要能独立判断
    if (proposal.rationale.trim().length < 10) {
      return { verdict: 'reject', reason: '改进理由过于简略，审核者无法据此判断' }
    }

    // ③ deprecate 永远人工：删除已有能力的破坏性大于新增
    if (proposal.action === 'deprecate') {
      return { verdict: 'needs_human', reason: '停用已有能力属于破坏性变更，必须人工确认' }
    }

    const risk = DIMENSION_RISK[proposal.dimension]

    // ④ 高风险维度永远人工
    if (risk > AUTO_PROMOTE_MAX_RISK) {
      return {
        verdict: 'needs_human',
        reason: `${proposal.dimension} 维度直接影响 agent 对客户的行为，必须人工确认`,
      }
    }

    // ⑤ 自动放行默认关闭
    if (this.options.allowAutoPromote !== true) {
      return { verdict: 'needs_human', reason: '当前未开启自动放行，全部提案走人工确认' }
    }

    if (proposal.confidence < AUTO_PROMOTE_MIN_CONFIDENCE) {
      return {
        verdict: 'needs_human',
        reason: `置信度 ${proposal.confidence} 低于自动放行门槛 ${AUTO_PROMOTE_MIN_CONFIDENCE}`,
      }
    }

    // ⑥ 来源会话本身评测未通过 → 不能自动放行
    if (proposal.sourceConversationId !== undefined) {
      const results = this.evals.byConversation(proposal.sourceConversationId)
      const failed = results.filter((entry) => !entry.passed)
      if (failed.length > 0) {
        return {
          verdict: 'needs_human',
          reason: `来源会话有 ${failed.length} 次评测未通过，不能据此自动放行`,
        }
      }
    }

    return {
      verdict: 'auto_promote',
      reason: `低风险维度 ${proposal.dimension}、置信度 ${proposal.confidence}、来源会话评测通过`,
    }
  }
}
