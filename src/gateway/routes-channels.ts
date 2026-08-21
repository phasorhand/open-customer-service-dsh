/**
 * 渠道入站 webhook 路由。
 *
 * 路径与 Python 版对齐并保留旧别名（spec §6），便于既有接入方平滑迁移。
 */

import type { FastifyInstance } from 'fastify'

import { ChannelParseError } from '../channel/adapter.js'
import { textOf } from '../channel/types.js'
import { WEBCHAT_CHANNEL_ID } from '../channel/webchat.js'
import type { OpenCsRuntime } from '../runtime.js'
import { InboundDispatcher } from './dispatcher.js'
import { replayFrames, type SessionEventLike } from './frames.js'

const WEBCHAT_BODY_SCHEMA = {
  type: 'object',
  required: ['conversation_id', 'customer_id', 'text'],
  properties: {
    conversation_id: { type: 'string', minLength: 1, maxLength: 200 },
    customer_id: { type: 'string', minLength: 1, maxLength: 200 },
    text: { type: 'string', minLength: 1, maxLength: 8000 },
    tenant_id: { type: 'string', maxLength: 100 },
    timestamp: { type: 'string' },
  },
  additionalProperties: false,
} as const

export function registerChannelRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  const dispatcher = new InboundDispatcher(runtime)

  const handler = async (request: { body: unknown }, reply: { status(code: number): unknown }) => {
    const adapter = runtime.channels.get(WEBCHAT_CHANNEL_ID)
    let message
    try {
      message = await adapter.parseInbound(request.body)
    } catch (error) {
      if (error instanceof ChannelParseError) {
        reply.status(400)
        return { error: 'invalid_payload', message: error.message }
      }
      throw error
    }

    if (message === undefined) {
      // 空白/非消息载荷：明确告知已忽略，而不是假装处理了
      reply.status(202)
      return { accepted: false, reason: '载荷不是一条用户消息，已忽略' }
    }

    const result = await dispatcher.dispatch(message)
    const agent = await runtime.harness.agentFor({
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      channelId: message.channelId,
      customerId: message.customerId,
    })
    const fresh = (agent.session.events as readonly SessionEventLike[]).filter(
      (event) => event.seq >= result.fromSeq && event.seq <= result.toSeq,
    )

    // 面向客户的回复走 channel.reply 工具（受 guard 治理），落在 webchat 的待取队列里。
    // `assistant/message` 是模型的内部叙述，不等于对客户说的话——两者都返回，
    // 让接入方能区分「给客户看的」与「给运营看的」。
    const delivered = runtime.webchat.drain(result.conversationId).map((action) => textOf(action.content))

    return {
      conversation_id: result.conversationId,
      reply: delivered.join('\n'),
      agent_narration: assistantText(fresh),
      delivered: delivered.length > 0,
      frames: replayFrames(fresh),
      trace: { from_seq: result.fromSeq, to_seq: result.toSeq },
    }
  }

  app.post('/channels/webchat', { schema: { body: WEBCHAT_BODY_SCHEMA } }, handler)
  // Python 版旧路径别名
  app.post('/chat/message', { schema: { body: WEBCHAT_BODY_SCHEMA } }, handler)
}

function assistantText(events: readonly SessionEventLike[]): string {
  const out: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly { type: string; text?: string }[] } }
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
}
