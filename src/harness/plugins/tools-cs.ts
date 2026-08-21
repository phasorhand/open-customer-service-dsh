/**
 * 客服工具集：知识检索、订单查询、面向客户的回复。
 *
 * 三段式输出纪律（research §2.3）：
 * - `output.schema` 是 canonical value，**每个字段都要标 `required: true`**
 *   （契约测试 ② 锁定：不标会推成可选，presentationMeta 无法通过 JsonValue 类型）
 * - `render()` 只给模型摘要，不塞完整正文——省 context 是首要目的
 * - `presentationMeta()` 是纯函数，给 UI 的完整投影，随 tool/result 持久化
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { cardToJson, makeCard, type CardItem } from '../cards.js'
import type { HarnessPorts } from '../ports.js'
import { requireScope, sessionIdOf } from '../session-scope.js'

export const name = 'opencs-tools-cs'
export const inject = ['tools']

/** 单次检索返回给模型的最大命中数。超过会显著抬高 context 成本。 */
const SEARCH_LIMIT = 5
/** 给模型看的正文截断长度。完整正文在 presentationMeta 里，UI 仍可展开。 */
const RENDER_EXCERPT = 200

export function apply(ctx: Context, ports: HarnessPorts): void {
  registerReply(ctx, ports)

  ctx.tools.register(
    defineTool({
      name: 'knowledge.search',
      description: '在企业知识库中检索与客户问题相关的条款、政策与操作说明。回答政策类问题前必须先调用。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词，用客户问题里的实际措辞' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  chunkId: { type: 'string', required: true },
                  sourceFile: { type: 'string', required: true },
                  headingPath: { type: 'string', required: true },
                  content: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.total === 0) {
            return [{ type: 'text', text: `知识库中没有找到与「${value.query}」相关的条款。不要编造政策，请如实告知客户并转人工。` }]
          }
          const lines = value.hits.map(
            (hit, i) => `${i + 1}. [${hit.headingPath}] ${excerpt(hit.content, RENDER_EXCERPT)}`,
          )
          return [{ type: 'text', text: `找到 ${value.total} 条相关条款：\n${lines.join('\n')}` }]
        },
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'knowledge_hit',
              title: `知识库命中 ${value.total} 条`,
              summary: value.total === 0 ? `未找到与「${value.query}」相关的条款` : `「${value.query}」的相关条款`,
              items: value.hits.map(
                (hit): CardItem => ({
                  id: hit.chunkId,
                  title: hit.headingPath,
                  evidence: hit.content,
                  extra: { sourceFile: hit.sourceFile },
                }),
              ),
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        const hits = await ports.knowledge.search(scope.tenantId, args.query, SEARCH_LIMIT)
        return {
          query: args.query,
          total: hits.length,
          hits: hits.map((hit) => ({
            chunkId: hit.chunkId,
            sourceFile: hit.sourceFile,
            headingPath: hit.headingPath,
            content: hit.content,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'crm.get_order',
      description: '按订单号查询订单状态与金额。客户提到订单号时调用；不要凭记忆回答订单状态。',
      parameters: {
        order_id: { type: 'string', required: true, description: '订单号，通常形如 ord-xxxxx' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            orderId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            amount: { type: 'number', required: true },
            currency: { type: 'string', required: true },
            placedAt: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          value.found
            ? [
                {
                  type: 'text',
                  text: `订单 ${value.orderId}：状态 ${value.status}，金额 ${value.amount} ${value.currency}，下单时间 ${value.placedAt}`,
                },
              ]
            : [{ type: 'text', text: `订单 ${value.orderId} 不存在。请向客户确认订单号，不要臆测订单状态。` }],
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'contact_profile',
              title: value.found ? `订单 ${value.orderId}` : `订单 ${value.orderId}（未找到）`,
              summary: value.found ? `${value.status} · ${value.amount} ${value.currency}` : '未找到该订单',
              items: value.found
                ? [
                    { id: `${value.orderId}:status`, title: '状态', evidence: value.status },
                    { id: `${value.orderId}:amount`, title: '金额', evidence: `${value.amount} ${value.currency}` },
                    { id: `${value.orderId}:placed`, title: '下单时间', evidence: value.placedAt },
                  ]
                : [],
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        const order = await ports.orders.getOrder(scope.tenantId, args.order_id)
        if (order === undefined) {
          // 失败也返回 canonical value（dsh 反模式 §B）：throw 会被转成 isError，
          // 而「订单不存在」是正常业务结果，模型需要看到它并据此回复。
          return { found: false, orderId: args.order_id, status: 'not_found', amount: 0, currency: '', placedAt: '' }
        }
        return {
          found: true,
          orderId: order.orderId,
          status: order.status,
          amount: order.amount,
          currency: order.currency,
          placedAt: order.placedAt,
        }
      },
    }),
  )
}

/**
 * 面向客户的自由文本回复。
 *
 * 风险档 ORANGE_C（默认走人工确认）——这是「LLM 永不直接执行不可逆动作」原则的
 * 主要落点：把话说出去是不可撤回的。放开自动回复靠调 `OPENCS_AUTO_APPROVE_TIERS`，
 * 是一个**显式的运营决策**，不是代码默认值。
 */
function registerReply(ctx: Context, ports: HarnessPorts): void {
  ctx.tools.register(
    defineTool({
      name: 'channel.reply',
      description:
        '把最终答复发送给客户。只有在已经查证过必要信息（知识库、订单）之后才调用；一次回复一条，不要拆成多条。',
      parameters: {
        text: { type: 'string', required: true, description: '发送给客户的完整回复正文' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
            error: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          value.delivered
            ? [{ type: 'text', text: '回复已送达客户。' }]
            : [{ type: 'text', text: `回复未能送达：${value.error}。不要重复发送，请说明情况或转人工。` }],
        presentationMeta: (_args, value) =>
          cardToJson(
            makeCard({
              type: 'cs_reply',
              title: value.delivered ? '已回复客户' : '回复投递失败',
              summary: value.text,
              items: [{ id: 'body', title: '回复正文', evidence: value.text }],
              ...(value.delivered
                ? {}
                : { items: [{ id: 'error', title: '失败原因', evidence: value.error }] }),
            }),
          ),
      },
      async execute(args, exec) {
        const scope = requireScope(sessionIdOf(exec))
        const result = await ports.outbound.deliver(
          { channelId: scope.channelId, conversationId: scope.conversationId, customerId: scope.customerId },
          args.text,
        )
        return result.ok
          ? { delivered: true, text: args.text, error: '' }
          : { delivered: false, text: args.text, error: result.error }
      },
    }),
  )
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}
