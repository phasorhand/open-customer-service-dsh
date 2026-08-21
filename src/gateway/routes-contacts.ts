/**
 * 联系人管理 API。
 *
 * 路径与 Python 版逐一对齐（spec §6），让 Admin UI 只改 API base 即可迁移。
 */

import type { FastifyInstance } from 'fastify'

import type { AudienceFilter, Contact } from '../crm/types.js'
import type { OpenCsRuntime } from '../runtime.js'

/** 列表分页上限。防止一次拉爆内存与响应体。 */
const MAX_LIMIT = 500

const FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'operator'],
        properties: {
          field: { type: 'string' },
          operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists'] },
          value: {},
        },
      },
    },
    contactIds: { type: 'array', items: { type: 'string' } },
  },
} as const

export function registerContactRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  // 漏斗必须注册在 /:contactId 之前，否则 "funnel" 会被当成 contactId
  app.get('/admin/tenants/:tenantId/contacts/funnel', async (request) => {
    const { tenantId } = request.params as { tenantId: string }
    return { tenant_id: tenantId, funnel: runtime.contactStore.funnel(tenantId) }
  })

  app.get(
    '/admin/tenants/:tenantId/contacts',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string }
      const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number }
      return {
        total: runtime.contactStore.count(tenantId),
        items: runtime.contactStore.list(tenantId, limit, offset).map(toDto),
      }
    },
  )

  app.get('/admin/tenants/:tenantId/contacts/:contactId', async (request, reply) => {
    const { contactId } = request.params as { contactId: string }
    const contact = runtime.contactStore.get(contactId)
    if (contact === undefined) {
      void reply.status(404)
      return { error: 'not_found', message: `联系人 ${contactId} 不存在` }
    }
    return { contact: toDto(contact), timeline: runtime.contactStore.timeline(contactId).map(toEventDto) }
  })

  app.post(
    '/admin/tenants/:tenantId/contacts/segment-preview',
    { schema: { body: FILTER_SCHEMA } },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string }
      const matched = runtime.contacts.segment(tenantId, request.body as AudienceFilter)
      return {
        total: matched.length,
        addressable: matched.filter((contact) => contact.identities.length > 0).length,
        items: matched.slice(0, 100).map(toDto),
      }
    },
  )

  app.post(
    '/admin/tenants/:tenantId/contacts/import',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['csv'],
          properties: {
            csv: { type: 'string', minLength: 1, maxLength: 5_000_000 },
            channel_id: { type: 'string' },
            source: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string }
      const body = request.body as { csv: string; channel_id?: string; source?: string }
      return runtime.importer.import(body.csv, {
        tenantId,
        ...(body.channel_id === undefined ? {} : { channelId: body.channel_id }),
        ...(body.source === undefined ? {} : { source: body.source }),
      })
    },
  )

  app.post(
    '/admin/tenants/:tenantId/contacts/:contactId/link-identity',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['channel_id', 'external_id'],
          properties: { channel_id: { type: 'string' }, external_id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { contactId } = request.params as { contactId: string }
      const body = request.body as { channel_id: string; external_id: string }
      try {
        return { contact: toDto(runtime.contacts.linkIdentity(contactId, body.channel_id, body.external_id)) }
      } catch (error) {
        // 身份冲突是业务结果而非服务错误：返回 409 让调用方知道要人工合并
        void reply.status(409)
        return { error: 'identity_conflict', message: String(error instanceof Error ? error.message : error) }
      }
    },
  )

  app.patch(
    '/admin/tenants/:tenantId/contacts/:contactId/stage',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['stage'],
          properties: {
            stage: {
              type: 'string',
              enum: ['new', 'engaged', 'qualified', 'opportunity', 'customer', 'disqualified', 'churned'],
            },
            reason: { type: 'string' },
            force: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request, reply) => {
      const { contactId } = request.params as { contactId: string }
      const body = request.body as { stage: string; reason?: string; force?: boolean }
      try {
        const contact = runtime.contacts.updateStage(contactId, body.stage as Contact['lifecycleStage'], {
          ...(body.reason === undefined ? {} : { reason: body.reason }),
          force: body.force ?? false,
        })
        return { contact: toDto(contact) }
      } catch (error) {
        // 违反单调性是**预期内**的业务拒绝，用 422 而不是 500
        void reply.status(422)
        return { error: 'invalid_transition', message: String(error instanceof Error ? error.message : error) }
      }
    },
  )
}

function toDto(contact: Contact) {
  return {
    id: contact.id,
    tenant_id: contact.tenantId,
    dedup_key: contact.dedupKey,
    name: contact.name ?? null,
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    company: contact.company ?? null,
    lifecycle_stage: contact.lifecycleStage,
    lead_status: contact.leadStatus,
    score: contact.score,
    tags: contact.tags,
    attributes: contact.attributes,
    addressable: contact.identities.length > 0,
    identities: contact.identities.map((identity) => ({
      channel_id: identity.channelId,
      external_id: identity.externalId,
    })),
    last_inbound_at: contact.lastInboundAt?.toISOString() ?? null,
    last_outbound_at: contact.lastOutboundAt?.toISOString() ?? null,
    converted_at: contact.convertedAt?.toISOString() ?? null,
    created_at: contact.createdAt.toISOString(),
  }
}

function toEventDto(event: { kind: string; payload: unknown; at: Date }) {
  return { kind: event.kind, payload: event.payload, at: event.at.toISOString() }
}
