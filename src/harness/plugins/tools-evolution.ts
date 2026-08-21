/**
 * 演进工具：让 agent 把「我发现知识库缺了什么」提成提案。
 *
 * 风险档 YELLOW（自动放行）——提案本身不改变任何行为，
 * 它只是进了人工队列。真正的风险在**审批**环节，那是人做的。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { EvolutionGate } from '../../evolution/gate.js'
import type { ProposalDimension, ProposalStore } from '../../evolution/store.js'
import { cardToJson, makeCard } from '../cards.js'
import { requireScope, sessionIdOf } from '../session-scope.js'

export const name = 'opencs-tools-evolution'
export const inject = ['tools']

const DIMENSIONS: readonly ProposalDimension[] = ['skill', 'knowledge', 'memory', 'cadence']

export interface EvolutionToolDeps {
  readonly proposals: ProposalStore
  readonly gate: EvolutionGate
}

export function apply(ctx: Context, deps: EvolutionToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'evolution.propose',
      description:
        '当你发现知识库缺失、话术不适用或客户提出了现有能力覆盖不到的诉求时，提出一条改进提案。' +
        '提案会进入人工审核队列，不会立即生效——所以放心提，但要写清依据。',
      parameters: {
        dimension: {
          type: 'string',
          required: true,
          enum: [...DIMENSIONS],
          description: 'knowledge=知识缺失；skill=话术需调整；cadence=外呼节奏；memory=客户画像',
        },
        title: { type: 'string', required: true, description: '一句话概括要改什么，同一问题请用一致的措辞' },
        rationale: { type: 'string', required: true, description: '为什么需要这个改进，引用客户的原话作为依据' },
        suggestion: { type: 'string', required: true, description: '具体建议的内容' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposalId: { type: 'string', required: true },
            created: { type: 'boolean', required: true },
            verdict: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.created
              ? `改进提案已提交（${value.reason}）。不要向客户承诺这个改进会实现。`
              : `同类提案已存在，未重复提交。不要向客户承诺这个改进会实现。`,
          },
        ],
        presentationMeta: (args, value) =>
          cardToJson(
            makeCard({
              type: 'proposal_review',
              title: `改进提案：${args.title}`,
              summary: value.reason,
              items: [
                { id: 'dimension', title: '维度', evidence: args.dimension },
                { id: 'rationale', title: '依据', evidence: args.rationale },
                { id: 'suggestion', title: '建议', evidence: args.suggestion },
                { id: 'verdict', title: '门禁判定', evidence: value.verdict },
              ],
              actions: [
                { id: 'approve', label: '批准', kind: 'per_item', requiresConfirm: true },
                { id: 'reject', label: '驳回', kind: 'per_item', requiresConfirm: false },
              ],
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        const { proposal, created } = deps.proposals.propose({
          tenantId: scope.tenantId,
          dimension: args.dimension as ProposalDimension,
          action: 'create',
          title: args.title,
          rationale: args.rationale,
          payload: { suggestion: args.suggestion },
          evidence: [args.rationale],
          confidence: 0.6,
          sourceConversationId: scope.conversationId,
        })

        // 新提案立即过一次门禁，让管理端看到的就是最终待办状态
        const gated = created ? deps.gate.evaluate(proposal.id) : { verdict: proposal.gateVerdict ?? 'needs_human', reason: proposal.gateReason ?? '已有同类提案' }
        return {
          proposalId: proposal.id,
          created,
          verdict: String(gated.verdict),
          reason: gated.reason,
        }
      },
    }),
  )
}
