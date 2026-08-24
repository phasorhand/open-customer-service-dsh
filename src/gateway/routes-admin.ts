/**
 * 通用管理 API：知识库、技能、审计、会话回放。
 */

import type { FastifyInstance } from 'fastify'

import { replayFrames, type SessionEventLike } from './frames.js'
import type { OpenCsRuntime } from '../runtime.js'

const MAX_SEARCH_LIMIT = 50

export function registerAdminRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  // ── 知识库 ────────────────────────────────────────────────
  app.get(
    '/admin/knowledge/search',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            tenant_id: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, default: 10 },
          },
        },
      },
    },
    async (request) => {
      const { q, tenant_id: tenantId, limit = 10 } = request.query as { q: string; tenant_id?: string; limit?: number }
      const hits = runtime.knowledge.searchSync(tenantId ?? runtime.config.tenantId, q, limit)
      return { query: q, total: hits.length, items: hits }
    },
  )

  app.get('/admin/knowledge/sources', async (request) => {
    const { tenant_id: tenantId } = request.query as { tenant_id?: string }
    const tenant = tenantId ?? runtime.config.tenantId
    return { status: runtime.knowledge.status(tenant), sources: runtime.knowledge.listSources(tenant) }
  })

  // ── 技能 ──────────────────────────────────────────────────
  app.get('/admin/skills', async () => {
    const skills = await runtime.harness.skills.list()
    return {
      total: skills.length,
      items: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        priority: skill.priority,
        routing: skill.routing,
        intent_signals: skill.intentSignals,
      })),
    }
  })

  app.get('/admin/skills/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    const [skill] = await runtime.harness.skills.load([name])
    if (skill === undefined) {
      void reply.status(404)
      return { error: 'not_found', message: `技能 ${name} 不存在` }
    }
    return { skill }
  })

  // ── 审计（风险裁决） ──────────────────────────────────────
  app.get(
    '/admin/audit-log',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['allow', 'ask', 'deny'] },
            tool: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { decision, tool, limit = 100, offset = 0 } = request.query as {
        decision?: 'allow' | 'ask' | 'deny'
        tool?: string
        limit?: number
        offset?: number
      }
      const filter = {
        ...(decision === undefined ? {} : { decision }),
        ...(tool === undefined ? {} : { tool }),
      }
      // 持久化审计：跨重启可查，满足合规回溯
      const items = runtime.audit.list({ ...filter, limit, offset })
      return {
        total: runtime.audit.count(filter),
        items: items.map((entry) => ({
          seq: entry.seq,
          tool: entry.tool,
          tier: entry.tier,
          decision: entry.decision,
          reason: entry.reason ?? null,
          at: entry.at.toISOString(),
        })),
      }
    },
  )

  // ── 会话回放（dsh 原生能力，Python 版没有） ────────────────
  app.get('/admin/sessions/:conversationId/events', async (request, reply) => {
    const { conversationId } = request.params as { conversationId: string }
    const { tenant_id: tenantId } = request.query as { tenant_id?: string }

    const agent = await runtime.harness.agentFor({
      tenantId: tenantId ?? runtime.config.tenantId,
      conversationId,
      channelId: 'webchat',
      customerId: conversationId,
    })
    const events = agent.session.events as readonly SessionEventLike[]
    if (events.length === 0) {
      void reply.status(404)
      return { error: 'not_found', message: `会话 ${conversationId} 没有事件` }
    }
    return {
      conversation_id: conversationId,
      total: events.length,
      // 帧由同一个纯投影函数产生——与前端当时实时看到的逐帧一致
      frames: replayFrames(events),
    }
  })

  // ── 总览 ──────────────────────────────────────────────────
  app.get('/admin/stats', async (request) => {
    const { tenant_id: tenantId } = request.query as { tenant_id?: string }
    const tenant = tenantId ?? runtime.config.tenantId
    return {
      tenant_id: tenant,
      contacts: { total: runtime.contactStore.count(tenant), funnel: runtime.contactStore.funnel(tenant) },
      cadences: runtime.cadences.runStats(tenant),
      sends: runtime.outbox.countByStatus(tenant),
      approvals: runtime.approvals.countByStatus(tenant),
      proposals: runtime.proposals.countByStatus(tenant),
      knowledge: runtime.knowledge.status(tenant),
      llm: { provider: runtime.harness.provider, model: runtime.harness.model },
    }
  })
}

/**
 * 演进与评测的管理路由。
 *
 * 单独一个函数是因为它们只在 P6 装配存在时才有意义，
 * 便于未来做成可选挂载。
 */
export function registerEvolutionRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  app.get(
    '/admin/proposals',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tenant_id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'gated', 'approved', 'rejected', 'applied'] },
            dimension: { type: 'string', enum: ['skill', 'knowledge', 'memory', 'cadence'] },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        tenant_id?: string
        status?: 'pending' | 'gated' | 'approved' | 'rejected' | 'applied'
        dimension?: 'skill' | 'knowledge' | 'memory' | 'cadence'
        limit?: number
      }
      const tenant = query.tenant_id ?? runtime.config.tenantId
      return {
        counts: runtime.proposals.countByStatus(tenant),
        items: runtime.proposals.list(tenant, {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.dimension === undefined ? {} : { dimension: query.dimension }),
          limit: query.limit ?? 50,
        }).map((proposal) => ({
          ...proposal,
          // 影子验证证据（curate 写入 payload）提到顶层：审批者不必钻进 payload 才能看到
          // 「重跑是否真的修了坏例」。未验证时为 null（前端渲染「未验证」）。
          shadowVerdict: (proposal.payload.shadowVerdict as string | undefined) ?? null,
        })),
      }
    },
  )

  app.get('/admin/proposals/:proposalId', async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string }
    const proposal = runtime.proposals.get(proposalId)
    if (proposal === undefined) {
      void reply.status(404)
      return { error: 'not_found', message: `提案 ${proposalId} 不存在` }
    }
    return {
      proposal,
      // 影子验证证据提到顶层，与列表项一致
      shadowVerdict: (proposal.payload.shadowVerdict as string | undefined) ?? null,
      // 门禁结论的依据：来源会话的评测记录
      source_evaluations:
        proposal.sourceConversationId === undefined
          ? []
          : runtime.evals.byConversation(proposal.sourceConversationId),
    }
  })

  for (const action of ['approve', 'reject'] as const) {
    app.post(
      `/admin/proposals/:proposalId/${action}`,
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['reviewer'],
            properties: { reviewer: { type: 'string', minLength: 1 }, note: { type: 'string' } },
          },
        },
      },
      async (request, reply) => {
        const { proposalId } = request.params as { proposalId: string }
        const body = request.body as { reviewer: string; note?: string }
        try {
          const proposal = runtime.proposals.review(proposalId, action === 'approve', body.reviewer, body.note)
          return { proposal }
        } catch (error) {
          // 状态机拒绝是预期内的业务结果，用 422
          void reply.status(422)
          return { error: 'invalid_state', message: String(error instanceof Error ? error.message : error) }
        }
      },
    )
  }

  app.get('/admin/evaluations/summary', async (request) => {
    const { tenant_id: tenantId } = request.query as { tenant_id?: string }
    return runtime.evals.summary(tenantId ?? runtime.config.tenantId)
  })

  app.get(
    '/admin/evaluations/failing',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tenant_id: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const { tenant_id: tenantId, limit = 50 } = request.query as { tenant_id?: string; limit?: number }
      const items = runtime.evals.failing(tenantId ?? runtime.config.tenantId, limit)
      return { total: items.length, items }
    },
  )
}
