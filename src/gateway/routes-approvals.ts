/**
 * HITL 审批队列路由。
 *
 * 关键语义：**批准 = 确定性执行**。审核者看到的 preview 就是将要发出的内容，
 * 批准后系统直接经渠道投递——不再过模型，不存在「批 A 发 B」。
 */

import type { FastifyInstance } from 'fastify'

import type { ApprovalItem } from '../approval/queue.js'
import type { OpenCsRuntime } from '../runtime.js'

const DECISION_SCHEMA = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['reviewer'],
    properties: {
      reviewer: { type: 'string', minLength: 1, maxLength: 100 },
      note: { type: 'string', maxLength: 2000 },
    },
  },
} as const

export function registerApprovalRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  app.get(
    '/admin/approvals',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tenant_id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'rejected', 'delivering', 'delivered', 'failed'] },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as { tenant_id?: string; status?: ApprovalItem['status']; limit?: number }
      const tenant = query.tenant_id ?? runtime.config.tenantId
      return {
        counts: runtime.approvals.countByStatus(tenant),
        items: runtime.approvals.list(tenant, query.status ?? 'pending', query.limit ?? 50).map(toDto),
      }
    },
  )

  app.post('/admin/approvals/:approvalId/approve', { schema: DECISION_SCHEMA }, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string }
    const body = request.body as { reviewer: string; note?: string }

    // 原子认领：并发点两次批准只有一次成功
    const item = runtime.approvals.claimForDelivery(approvalId, body.reviewer, body.note)
    if (item === undefined) {
      const current = runtime.approvals.get(approvalId)
      void reply.status(current === undefined ? 404 : 409)
      return current === undefined
        ? { error: 'not_found', message: `审批项 ${approvalId} 不存在` }
        : { error: 'already_decided', message: `审批项已是 ${current.status} 状态`, item: toDto(current) }
    }

    // 确定性投递：审核者批准的 preview 就是发出的内容
    const delivered = await deliver(runtime, item)
    if (delivered.ok) {
      runtime.approvals.markDelivered(item.id)
      // 触达计入客户档案（有联系人时）
      if (item.contactId !== undefined) {
        try {
          runtime.contacts.onOutbound(item.contactId)
        } catch {
          // 联系人不可触达等业务异常不回滚投递——消息已经发出去了
        }
      }
      return { item: toDto(runtime.approvals.require(item.id)) }
    }

    runtime.approvals.markFailed(item.id, delivered.error)
    void reply.status(502)
    return { error: 'delivery_failed', message: delivered.error, item: toDto(runtime.approvals.require(item.id)) }
  })

  app.post('/admin/approvals/:approvalId/reject', { schema: DECISION_SCHEMA }, async (request, reply) => {
    const { approvalId } = request.params as { approvalId: string }
    const body = request.body as { reviewer: string; note?: string }
    const item = runtime.approvals.reject(approvalId, body.reviewer, body.note)
    if (item === undefined) {
      const current = runtime.approvals.get(approvalId)
      void reply.status(current === undefined ? 404 : 409)
      return current === undefined
        ? { error: 'not_found', message: `审批项 ${approvalId} 不存在` }
        : { error: 'already_decided', message: `审批项已是 ${current.status} 状态`, item: toDto(current) }
    }
    return { item: toDto(item) }
  })
}

/** 按工具类型执行被批准的动作。目前只有发消息类；新增工具类型在此登记。 */
async function deliver(
  runtime: OpenCsRuntime,
  item: ApprovalItem,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (item.tool === 'channel.reply' || item.tool === 'channel.send_template' || item.tool === 'nurture.deliver') {
    const text = typeof item.args['text'] === 'string' ? (item.args['text'] as string) : item.preview
    const result = await runtime.outbound.deliver(
      { channelId: item.channelId, conversationId: item.conversationId, customerId: item.customerId },
      text,
    )
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }
  return { ok: false, error: `工具 ${item.tool} 尚不支持审批后执行，请在 deliver() 里登记执行方式` }
}

function toDto(item: ApprovalItem) {
  return {
    id: item.id,
    tenant_id: item.tenantId,
    conversation_id: item.conversationId,
    channel_id: item.channelId,
    customer_id: item.customerId,
    contact_id: item.contactId ?? null,
    tool: item.tool,
    preview: item.preview,
    status: item.status,
    reviewer: item.reviewer ?? null,
    review_note: item.reviewNote ?? null,
    error_reason: item.errorReason ?? null,
    requested_at: item.requestedAt.toISOString(),
    decided_at: item.decidedAt?.toISOString() ?? null,
    delivered_at: item.deliveredAt?.toISOString() ?? null,
  }
}
