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
          },
        },
      },
    },
    async (request) => {
      const { decision, tool, limit = 100 } = request.query as { decision?: string; tool?: string; limit?: number }
      const filtered = runtime.riskDecisions
        .filter((entry) => decision === undefined || entry.decision === decision)
        .filter((entry) => tool === undefined || entry.toolName === tool)
        .slice(-limit)
        .reverse()
      return {
        total: filtered.length,
        // 内存投影，进程重启后清空；长期审计以 session 事件日志为准
        note: '当前为内存投影；完整审计以 session 事件日志为准',
        items: filtered.map((entry) => ({
          tool: entry.toolName,
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
      knowledge: runtime.knowledge.status(tenant),
      llm: { provider: runtime.harness.provider, model: runtime.harness.model },
    }
  })
}
