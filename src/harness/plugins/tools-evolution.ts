/**
 * 演进工具：让 agent 把「我发现知识库缺了什么」提成提案。
 *
 * 风险档 YELLOW（自动放行）——提案本身不改变任何行为，
 * 它只是进了人工队列。真正的风险在**审批**环节，那是人做的。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { curate, type CuratorDeps } from '../../evolution/curator.js'
import type { DiffVerdict } from '../../evolution/differ.js'
import type { EvolutionGate } from '../../evolution/gate.js'
import type { LineageStore } from '../../evolution/lineage.js'
import type { ProposalDimension, ProposalStore } from '../../evolution/store.js'
import { cardToJson, makeCard } from '../cards.js'
import { requireScope, sessionIdOf } from '../session-scope.js'

export const name = 'opencs-tools-evolution'
export const inject = ['tools']

const DIMENSIONS: readonly ProposalDimension[] = ['skill', 'knowledge', 'memory', 'cadence']

export interface EvolutionToolDeps {
  readonly proposals: ProposalStore
  readonly gate: EvolutionGate
  /**
   * 闭环编排 curator：低分会话证据 → 影子重跑 → 差分，给人工审批看「重跑是否真的修了坏例」。
   *
   * 可选：未注入时 propose 跳过影子验证（shadowVerdict 记 `inconclusive`）。
   * 提案已入队成功，影子验证是尽力而为的证据——任何装配下都不允许它阻断 propose。
   */
  readonly curator?: CuratorDeps
  /**
   * 血缘追踪：提案 → 来源/效果的线性事件时间线（spec §3.6）。
   *
   * 可选：未注入时 propose 只跳过血缘记录，不改变任何既有行为。
   * 血缘与影子验证一样是尽力而为的旁路，绝不阻断 propose。
   */
  readonly lineage?: LineageStore
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
            shadowVerdict: { type: 'string', required: true, description: '影子验证结论：同输入重跑是否修复了坏例' },
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
                { id: 'shadow', title: '影子验证', evidence: value.shadowVerdict },
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

        // 血缘追踪：新提案落地即记 `proposed`，detail 记来源会话（权限事实，服务端注入）。
        // 与其余旁路一样尽力而为——血缘记录失败绝不阻断 propose。
        if (created) deps.lineage?.append(proposal.id, 'proposed', scope.conversationId)

        // 闭环编排：新提案跑一次影子验证（证据 → 同输入重跑 → 差分），给人工审批看
        // 「重跑是否真的修了坏例」。这是尽力而为：提案已入队成功，curate 失败
        // （影子运行异常 / 缺少坏例文本）只降级为 inconclusive，绝不阻断 propose。
        let shadowVerdict: DiffVerdict = 'inconclusive'
        if (created && deps.curator !== undefined) {
          try {
            const shadow = await curate(proposal, deps.curator)
            shadowVerdict = shadow.shadowVerdict
            // 持久化影子证据到提案 payload，管理端列表/详情直接展示「重跑是否真的修了坏例」。
            // 与 curate 同 try：写入失败也降级，绝不阻断 propose（证据是尽力而为的）。
            deps.proposals.setShadowVerdict(proposal.id, shadow.shadowVerdict, shadow.divergences)
            // 技能自策展：skill 提案的影子验证同时产出一份 SKILL.md 草案，持久化到 payload，
            // 管理端「演进提案」页签即可预览、后续 apply-flow 可据此晋升。
            if (shadow.skillDraft !== undefined) deps.proposals.setSkillDraft(proposal.id, shadow.skillDraft)
            // 血缘追踪：影子验证结论记 `shadow_verified`，detail 记 verdict 字符串。
            deps.lineage?.append(proposal.id, 'shadow_verified', shadow.shadowVerdict)
          } catch (error) {
            ctx.logger.warn(
              `[evolution] 影子验证失败，提案 ${proposal.id} 已入队，验证降级为 inconclusive：${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        }

        return {
          proposalId: proposal.id,
          created,
          verdict: String(gated.verdict),
          reason: gated.reason,
          shadowVerdict,
        }
      },
    }),
  )
}
