/**
 * 节奏管理 API。
 */

import type { FastifyInstance } from 'fastify'

import type { AudienceFilter } from '../crm/types.js'
import type { Cadence } from '../nurture/types.js'
import type { OpenCsRuntime } from '../runtime.js'

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['step_order'],
  properties: {
    step_order: { type: 'integer', minimum: 0 },
    delay_seconds: { type: 'integer', minimum: 0, default: 0 },
    goal: { type: 'string' },
    template: { type: 'string' },
  },
} as const

const CREATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'channel_id', 'steps'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    channel_id: { type: 'string', minLength: 1 },
    sender_persona: { type: 'string', maxLength: 200 },
    auto_enroll: { type: 'boolean', default: false },
    entry_filter: { type: 'object' },
    exit_on_reply: { type: 'boolean', default: true },
    exit_on_stage: {
      type: 'string',
      enum: ['new', 'engaged', 'qualified', 'opportunity', 'customer', 'disqualified', 'churned'],
    },
    quiet_hours_start: { type: 'integer', minimum: 0, maximum: 23 },
    quiet_hours_end: { type: 'integer', minimum: 0, maximum: 23 },
    timezone: { type: 'string' },
    max_touches_per_week: { type: 'integer', minimum: 0, maximum: 50 },
    steps: { type: 'array', minItems: 1, items: STEP_SCHEMA },
  },
} as const

interface CreateBody {
  name: string
  description?: string
  channel_id: string
  sender_persona?: string
  auto_enroll?: boolean
  entry_filter?: AudienceFilter
  exit_on_reply?: boolean
  exit_on_stage?: string
  quiet_hours_start?: number
  quiet_hours_end?: number
  timezone?: string
  max_touches_per_week?: number
  steps: { step_order: number; delay_seconds?: number; goal?: string; template?: string }[]
}

export function registerCadenceRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  // stats 必须在 /:cadenceId 之前注册
  app.get('/admin/tenants/:tenantId/cadences/stats', async (request) => {
    const { tenantId } = request.params as { tenantId: string }
    return {
      runs: runtime.cadences.runStats(tenantId),
      sends: runtime.outbox.countByStatus(tenantId),
    }
  })

  app.get('/admin/tenants/:tenantId/cadences', async (request) => {
    const { tenantId } = request.params as { tenantId: string }
    return { items: runtime.cadences.list(tenantId).map(toDto) }
  })

  app.post('/admin/tenants/:tenantId/cadences', { schema: { body: CREATE_SCHEMA } }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string }
    const body = request.body as CreateBody

    // 每一步必须至少有 template 或 goal，否则物化时才会失败——太晚了
    const invalid = body.steps.filter(
      (step) => (step.template ?? '').trim() === '' && (step.goal ?? '').trim() === '',
    )
    if (invalid.length > 0) {
      void reply.status(400)
      return {
        error: 'invalid_step',
        message: `第 ${invalid.map((step) => step.step_order).join(', ')} 步既没有 template 也没有 goal`,
      }
    }

    const cadence = runtime.cadences.create({
      tenantId,
      name: body.name,
      channelId: body.channel_id,
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.sender_persona === undefined ? {} : { senderPersona: body.sender_persona }),
      ...(body.auto_enroll === undefined ? {} : { autoEnroll: body.auto_enroll }),
      ...(body.entry_filter === undefined ? {} : { entryFilter: body.entry_filter }),
      ...(body.exit_on_reply === undefined ? {} : { exitOnReply: body.exit_on_reply }),
      ...(body.exit_on_stage === undefined ? {} : { exitOnStage: body.exit_on_stage as NonNullable<Cadence['exitOnStage']> }),
      ...(body.quiet_hours_start === undefined ? {} : { quietHoursStart: body.quiet_hours_start }),
      ...(body.quiet_hours_end === undefined ? {} : { quietHoursEnd: body.quiet_hours_end }),
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      ...(body.max_touches_per_week === undefined ? {} : { maxTouchesPerWeek: body.max_touches_per_week }),
      steps: body.steps.map((step) => ({
        stepOrder: step.step_order,
        delaySeconds: step.delay_seconds ?? 0,
        ...(step.goal === undefined ? {} : { goal: step.goal }),
        ...(step.template === undefined ? {} : { template: step.template }),
      })),
    })
    void reply.status(201)
    return { cadence: toDto(cadence) }
  })

  app.get('/admin/tenants/:tenantId/cadences/:cadenceId', async (request, reply) => {
    const { cadenceId } = request.params as { cadenceId: string }
    const cadence = runtime.cadences.get(cadenceId)
    if (cadence === undefined) {
      void reply.status(404)
      return { error: 'not_found', message: `节奏 ${cadenceId} 不存在` }
    }
    return { cadence: toDto(cadence) }
  })

  for (const [action, status] of [
    ['activate', 'active'],
    ['pause', 'paused'],
  ] as const) {
    app.post(`/admin/tenants/:tenantId/cadences/:cadenceId/${action}`, async (request, reply) => {
      const { cadenceId } = request.params as { cadenceId: string }
      const cadence = runtime.cadences.get(cadenceId)
      if (cadence === undefined) {
        void reply.status(404)
        return { error: 'not_found', message: `节奏 ${cadenceId} 不存在` }
      }
      if (action === 'activate' && cadence.steps.length === 0) {
        void reply.status(422)
        return { error: 'no_steps', message: '没有步骤的节奏无法激活' }
      }
      runtime.cadences.setStatus(cadenceId, status)
      return { cadence: toDto(runtime.cadences.require(cadenceId)) }
    })
  }

  app.post(
    '/admin/tenants/:tenantId/cadences/:cadenceId/enroll',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contact_ids'],
          properties: { contact_ids: { type: 'array', minItems: 1, items: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { cadenceId } = request.params as { cadenceId: string }
      const cadence = runtime.cadences.get(cadenceId)
      if (cadence === undefined) {
        void reply.status(404)
        return { error: 'not_found', message: `节奏 ${cadenceId} 不存在` }
      }
      const { contact_ids: contactIds } = request.body as { contact_ids: string[] }
      const now = new Date()

      let enrolled = 0
      let alreadyEnrolled = 0
      const unaddressable: string[] = []
      for (const contactId of contactIds) {
        const contact = runtime.contactStore.get(contactId)
        if (contact === undefined || contact.identities.length === 0) {
          // 显式报告而不是静默跳过（教训 #4）
          unaddressable.push(contactId)
          continue
        }
        const { created } = runtime.cadences.enroll(cadence, contactId, now)
        if (created) enrolled += 1
        else alreadyEnrolled += 1
      }
      return { enrolled, already_enrolled: alreadyEnrolled, unaddressable }
    },
  )

  /** 手动触发一次 tick，便于运营在管理端立即看到效果而不必等轮询。 */
  app.post('/admin/tenants/:tenantId/cadences/tick', async () => {
    return { report: await runtime.nurture.tick() }
  })
}

function toDto(cadence: Cadence) {
  return {
    id: cadence.id,
    tenant_id: cadence.tenantId,
    name: cadence.name,
    description: cadence.description ?? null,
    channel_id: cadence.channelId,
    sender_persona: cadence.senderPersona ?? null,
    auto_enroll: cadence.autoEnroll,
    entry_filter: cadence.entryFilter ?? null,
    exit_on_reply: cadence.exitOnReply,
    exit_on_stage: cadence.exitOnStage ?? null,
    quiet_hours_start: cadence.quietHoursStart,
    quiet_hours_end: cadence.quietHoursEnd,
    timezone: cadence.timezone,
    max_touches_per_week: cadence.maxTouchesPerWeek,
    status: cadence.status,
    steps: cadence.steps.map((step) => ({
      step_order: step.stepOrder,
      delay_seconds: step.delaySeconds,
      goal: step.goal ?? null,
      template: step.template ?? null,
      mode: (step.template ?? '').trim() === '' ? 'llm' : 'template',
    })),
    created_at: cadence.createdAt.toISOString(),
  }
}
