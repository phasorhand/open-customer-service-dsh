/**
 * 渠道消息的平台中立表示。
 *
 * 自建理由（research §3.1）：botpress 是整套平台不是 SDK；wechaty 偏个人微信且拉入
 * puppet 体系。渠道抽象本身只有三个方法，自建成本远低于封装成本。
 * 加解密等有明确边界的部分复用现成库（企微走 `@wecom/crypto`，P7）。
 */

/** 消息片段类型。 */
export type ContentKind = 'text' | 'image' | 'voice' | 'file' | 'card'

/** 一条消息里的一个原子片段。 */
export interface ContentPart {
  readonly kind: ContentKind
  readonly text?: string
  readonly mediaUrl?: string
  readonly mime?: string
  readonly extra?: Readonly<Record<string, string>>
}

/** 消息发送方身份。 */
export type SenderKind = 'customer' | 'agent_human' | 'system'

/** 平台中立的入站消息。 */
export interface InboundMessage {
  readonly channelId: string
  readonly conversationId: string
  /** 渠道侧的用户标识（企微 external_userid / webchat 访客 id）。 */
  readonly customerId: string
  readonly senderKind: SenderKind
  readonly content: readonly ContentPart[]
  readonly timestamp: Date
  readonly tenantId: string
  /** 厂商原始载荷，保留用于排障与回放。 */
  readonly rawPayload?: Readonly<Record<string, unknown>>
}

/** 出站动作类型。 */
export type OutboundKind = 'reply' | 'proactive_send' | 'add_tag' | 'transfer_to_human'

/** 平台中立的出站动作。 */
export interface OutboundAction {
  readonly channelId: string
  readonly conversationId: string
  readonly customerId: string
  readonly kind: OutboundKind
  readonly content: readonly ContentPart[]
  /** `add_tag` 等动作的目标（标签名等）。 */
  readonly target?: string
  readonly metadata?: Readonly<Record<string, string>>
}

/** 渠道能力声明。用于在调度前判断动作是否可行，而不是发出去才失败。 */
export interface ChannelCapabilities {
  /** 是否允许主动发起会话（企微客服有 48 小时窗口限制 → false）。 */
  readonly canSendProactive: boolean
  readonly supportsMedia: boolean
  /** 单条消息最大字符数；超长需要自行分片。 */
  readonly maxTextLength: number
}

/** 一次投递的结果。失败用返回值表达，不用异常（异常留给「不该发生」的情况）。 */
export type SendResult =
  | { readonly ok: true; readonly externalMessageId?: string }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean }

/** 从消息片段里拼出纯文本。媒体片段被跳过。 */
export function textOf(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.kind === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
}

/** 构造一条纯文本片段列表。 */
export function textContent(text: string): readonly ContentPart[] {
  return [{ kind: 'text', text }]
}
