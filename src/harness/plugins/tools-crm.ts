/**
 * CRM 工具集：客户资料读取、备注、阶段变更、分群预览。
 *
 * 风险分级（`src/harness/risk.ts`）：
 * - `contact.get` / `contact.segment_preview` → GREEN（只读）
 * - `contact.add_note` → YELLOW（低风险写入）
 * - `contact.update_stage` → **RED**（不可逆商业动作，默认需人工确认）
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { ContactService } from '../../crm/service.js'
import type { AudienceFilter, Contact, LifecycleStage } from '../../crm/types.js'
import { isAddressable } from '../../crm/types.js'
import { cardToJson, makeCard, type CardItem } from '../cards.js'
import { requireScope, sessionIdOf } from '../session-scope.js'

export const name = 'opencs-tools-crm'
export const inject = ['tools']

/** 分群预览返回给模型的最大条数。完整名单在卡片里，UI 可翻页。 */
const PREVIEW_LIMIT = 20

const STAGES: readonly LifecycleStage[] = [
  'new',
  'engaged',
  'qualified',
  'opportunity',
  'customer',
  'disqualified',
  'churned',
]

export function apply(ctx: Context, contacts: ContactService): void {
  ctx.tools.register(
    defineTool({
      name: 'contact.get',
      description: '读取当前对话客户的档案：漏斗阶段、意向分、标签、可触达渠道。回答与客户状态有关的问题前先调用。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            contactId: { type: 'string', required: true },
            name: { type: 'string', required: true },
            lifecycleStage: { type: 'string', required: true },
            leadStatus: { type: 'string', required: true },
            score: { type: 'integer', required: true },
            tags: { type: 'array', required: true, items: { type: 'string' } },
            addressable: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) =>
          value.found
            ? [
                {
                  type: 'text',
                  text: `客户 ${value.name || value.contactId}：阶段 ${value.lifecycleStage}，状态 ${value.leadStatus}，意向分 ${value.score}${value.tags.length === 0 ? '' : `，标签 ${value.tags.join('、')}`}`,
                },
              ]
            : [{ type: 'text', text: '当前对话尚未关联到客户档案。' }],
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'contact_profile',
              title: value.found ? `客户档案：${value.name || value.contactId}` : '未关联客户档案',
              summary: value.found ? `${value.lifecycleStage} · 意向分 ${value.score}` : '当前对话尚未关联客户',
              items: value.found
                ? [
                    { id: 'stage', title: '漏斗阶段', evidence: value.lifecycleStage },
                    { id: 'status', title: '触达状态', evidence: value.leadStatus },
                    { id: 'score', title: '意向分', evidence: String(value.score) },
                    { id: 'tags', title: '标签', evidence: value.tags.join('、') || '（无）' },
                    { id: 'reach', title: '可触达', evidence: value.addressable ? '是' : '否（无渠道身份）' },
                  ]
                : [],
            }),
          ),
      },
      async execute(_args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        const contact = scope.contactId === undefined ? undefined : safeGet(contacts, scope.contactId)
        return contact === undefined ? notFound() : toValue(contact)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'contact.add_note',
      description: '在客户时间线上记一条备注。用于记录口头承诺、特殊诉求等后续需要人工跟进的信息。',
      parameters: {
        note: { type: 'string', required: true, description: '备注正文，写清楚事实而非推测' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'boolean', required: true },
            note: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          value.recorded
            ? [{ type: 'text', text: '备注已记入客户时间线。' }]
            : [{ type: 'text', text: `备注未能记录：${value.reason}` }],
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'contact_profile',
              title: value.recorded ? '已记录备注' : '备注记录失败',
              summary: value.recorded ? value.note : value.reason,
              items: [{ id: 'note', title: '备注', evidence: value.note }],
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        if (scope.contactId === undefined) {
          return { recorded: false, note: args.note, reason: '当前对话尚未关联客户档案' }
        }
        contacts.addNote(scope.contactId, args.note)
        return { recorded: true, note: args.note, reason: '' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'contact.update_stage',
      description:
        '推进客户的漏斗阶段。只在有明确证据时调用（例如客户明确表达购买意向或已成交）。阶段只能前进，不能回退。',
      parameters: {
        stage: { type: 'string', required: true, enum: [...STAGES], description: '目标阶段' },
        reason: { type: 'string', required: true, description: '推进依据，引用客户的原话' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            updated: { type: 'boolean', required: true },
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            reason: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          value.updated
            ? [{ type: 'text', text: `客户阶段已从 ${value.from} 推进到 ${value.to}。` }]
            : [{ type: 'text', text: `阶段未变更：${value.reason}。不要重复尝试。` }],
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'contact_profile',
              title: value.updated ? `阶段推进：${value.from} → ${value.to}` : '阶段未变更',
              summary: value.reason,
              items: [
                { id: 'from', title: '原阶段', evidence: value.from },
                { id: 'to', title: '目标阶段', evidence: value.to },
                { id: 'reason', title: '依据', evidence: value.reason },
              ],
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        if (scope.contactId === undefined) {
          return { updated: false, from: '', to: args.stage, reason: '当前对话尚未关联客户档案' }
        }
        const before = contacts.require(scope.contactId)
        const blocked = contacts.canTransition(scope.contactId, args.stage as LifecycleStage)
        if (blocked !== undefined) {
          // 失败也返回 canonical value：这是正常业务结果，模型需要看到并据此回复
          return { updated: false, from: before.lifecycleStage, to: args.stage, reason: blocked }
        }
        const after = contacts.updateStage(scope.contactId, args.stage as LifecycleStage, { reason: args.reason })
        return { updated: true, from: before.lifecycleStage, to: after.lifecycleStage, reason: args.reason }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'contact.segment_preview',
      description: '按条件预览命中的客户名单。用于运营侧的受众圈选，不会向任何人发送消息。',
      parameters: {
        filter: { type: 'json', required: true, description: 'AudienceFilter：{ rules: [{field, operator, value}] }' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            addressable: { type: 'integer', required: true },
            preview: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  contactId: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  lifecycleStage: { type: 'string', required: true },
                  score: { type: 'integer', required: true },
                  addressable: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.total === 0
                ? '没有客户命中这个条件。'
                : `命中 ${value.total} 位客户，其中 ${value.addressable} 位可触达（有渠道身份）。`,
          },
        ],
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'contact_segment',
              title: `命中 ${value.total} 位客户`,
              summary: `可触达 ${value.addressable} / ${value.total}`,
              items: value.preview.map(
                (row): CardItem => ({
                  id: row.contactId,
                  title: row.name || row.contactId,
                  evidence: `${row.lifecycleStage} · 意向分 ${row.score}`,
                  status: row.addressable ? '可触达' : '无渠道身份',
                }),
              ),
              actions: [{ id: 'enroll', label: '加入节奏', kind: 'batch', requiresConfirm: true }],
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        const matched = contacts.segment(scope.tenantId, args.filter as AudienceFilter)
        return {
          total: matched.length,
          addressable: matched.filter((contact) => isAddressable(contact)).length,
          preview: matched.slice(0, PREVIEW_LIMIT).map((contact) => ({
            contactId: contact.id,
            name: contact.name ?? '',
            lifecycleStage: contact.lifecycleStage,
            score: contact.score,
            addressable: isAddressable(contact),
          })),
        }
      },
    }),
  )
}

function safeGet(contacts: ContactService, contactId: string): Contact | undefined {
  try {
    return contacts.require(contactId)
  } catch {
    return undefined
  }
}

function toValue(contact: Contact) {
  return {
    found: true,
    contactId: contact.id,
    name: contact.name ?? '',
    lifecycleStage: contact.lifecycleStage,
    leadStatus: contact.leadStatus,
    score: contact.score,
    tags: [...contact.tags],
    addressable: isAddressable(contact),
  }
}

function notFound() {
  return {
    found: false,
    contactId: '',
    name: '',
    lifecycleStage: '',
    leadStatus: '',
    score: 0,
    tags: [] as string[],
    addressable: false,
  }
}
