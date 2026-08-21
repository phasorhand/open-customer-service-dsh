/**
 * WebChat 渠道：浏览器内嵌聊天窗。
 *
 * 投递方式：进程内订阅者（WS 连接）。这个渠道**支持主动发起**——
 * 它是节奏外呼（P5）在没有企微资质时的默认演示渠道。
 */

import type { ChannelAdapter } from './adapter.js'
import { ChannelParseError } from './adapter.js'
import type { ChannelCapabilities, InboundMessage, OutboundAction, SendResult } from './types.js'

export const WEBCHAT_CHANNEL_ID = 'webchat'

/** 出站消息的进程内订阅者。WS 层注册它以把消息推给浏览器。 */
export type WebChatSink = (action: OutboundAction) => void

export interface WebChatInboundPayload {
  readonly conversation_id: string
  readonly customer_id: string
  readonly text: string
  readonly tenant_id?: string
  readonly timestamp?: string
}

export class WebChatAdapter implements ChannelAdapter {
  readonly channelId = WEBCHAT_CHANNEL_ID
  private readonly sinks = new Set<WebChatSink>()
  /** conversationId → 尚未被 HTTP 响应取走的出站消息。 */
  private readonly pending = new Map<string, OutboundAction[]>()

  /**
   * @param defaultTenantId - 载荷未带 tenant_id 时使用的租户。
   */
  constructor(private readonly defaultTenantId: string) {}

  /**
   * 订阅出站消息。
   *
   * @param sink - 回调。
   * @returns 取消订阅函数。
   */
  subscribe(sink: WebChatSink): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  async parseInbound(payload: unknown): Promise<InboundMessage | undefined> {
    if (payload === null || typeof payload !== 'object') {
      throw new ChannelParseError('webchat 载荷必须是对象')
    }
    const raw = payload as Partial<WebChatInboundPayload>
    const missing = (['conversation_id', 'customer_id', 'text'] as const).filter(
      (field) => typeof raw[field] !== 'string' || raw[field] === '',
    )
    if (missing.length > 0) {
      throw new ChannelParseError(`webchat 载荷缺少必填字段：${missing.join(', ')}`)
    }

    const text = raw.text as string
    // 空白消息不是一条用户消息，不应触发一次 agent turn
    if (text.trim() === '') return undefined

    return {
      channelId: this.channelId,
      conversationId: raw.conversation_id as string,
      customerId: raw.customer_id as string,
      senderKind: 'customer',
      content: [{ kind: 'text', text }],
      timestamp: parseTimestamp(raw.timestamp),
      tenantId: raw.tenant_id ?? this.defaultTenantId,
      rawPayload: payload as Record<string, unknown>,
    }
  }

  /**
   * 投递出站消息。
   *
   * WebChat 有两种消费形态，都必须支持：
   * - **WS 长连接**：实时推给在线订阅者
   * - **HTTP 请求/响应**：没有长连接，回复是 POST 的响应体
   *
   * 因此这里总是先写入 per-conversation 的待取队列（供 HTTP 处理器 `drain()`），
   * 再推给在线订阅者。没有订阅者**不是失败**——否则纯 HTTP 接入方每次都会收到
   * 「投递失败」，模型据此道歉，用户体验完全错乱（这是 P2 实测发现的问题）。
   */
  async send(action: OutboundAction): Promise<SendResult> {
    const queue = this.pending.get(action.conversationId) ?? []
    queue.push(action)
    this.pending.set(action.conversationId, queue)

    for (const sink of this.sinks) {
      try {
        sink(action)
      } catch {
        // 坏订阅者不能破坏投递（dsh defensive-patterns §6）
      }
    }
    return { ok: true }
  }

  /**
   * 查看某会话待取的出站文本，**不消费队列**。
   *
   * 用于评测等旁路观察——它不能把消息从队列里拿走，
   * 否则 HTTP 响应就拿不到回复了。
   *
   * @param conversationId - 会话 id。
   * @returns 拼接后的文本；无待发消息时为空串。
   */
  peek(conversationId: string): string {
    return (this.pending.get(conversationId) ?? [])
      .flatMap((action) => action.content.map((part) => part.text ?? ''))
      .join('\n')
  }

  /**
   * 取走某会话累积的出站消息（HTTP 请求/响应模式）。
   *
   * @param conversationId - 会话 id。
   * @returns 自上次取走以来产生的出站动作，按产生顺序。
   */
  drain(conversationId: string): readonly OutboundAction[] {
    const queue = this.pending.get(conversationId) ?? []
    this.pending.delete(conversationId)
    return queue
  }

  capabilities(): ChannelCapabilities {
    return { canSendProactive: true, supportsMedia: false, maxTextLength: 4000 }
  }
}

function parseTimestamp(raw: string | undefined): Date {
  if (raw === undefined) return new Date()
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}
