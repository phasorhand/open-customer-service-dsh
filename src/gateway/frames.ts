/**
 * SessionEvent → 前端帧的投影。
 *
 * 关键性质（research §2.3）：投影是**确定性**的。实时流式与历史回放走同一条
 * 代码路径——前端重连时把全部历史事件喂进来，得到的帧序列与当时实时收到的完全一致。
 * 因此不存在「实时渲染」和「历史渲染」两套逻辑不同步的经典 bug。
 *
 * 为什么是类而不是纯函数：`tool/result` 事件**不带工具名**（dsh 用 `callId` 与
 * `tool/call` 关联）。要给前端「xx 已完成」的提示就必须记住 callId → 工具名的映射。
 * 这份状态只在一次投影过程内有效，因此封装成一次性的 projector 而不是全局可变量。
 */

import { parseCard } from '../harness/cards.js'

/** 一个前端帧。`seq` 是产生它的 session 事件序号，用作回放锚点。 */
export type Frame =
  | { readonly type: 'text/delta'; readonly text: string; readonly seq: number }
  | { readonly type: 'tool/status'; readonly status: 'running' | 'done'; readonly tool: string; readonly label: string; readonly seq: number }
  | { readonly type: 'card/open'; readonly cardId: string; readonly card: { readonly type: string; readonly title: string; readonly scope?: string }; readonly seq: number }
  | { readonly type: 'card/item'; readonly cardId: string; readonly item: Record<string, unknown>; readonly seq: number }
  | { readonly type: 'card/close'; readonly cardId: string; readonly summary: string; readonly actions: readonly Record<string, unknown>[]; readonly traceRef: number; readonly seq: number }
  | { readonly type: 'turn/start'; readonly seq: number }
  | { readonly type: 'turn/done'; readonly seq: number }

/** 工具执行中的中文提示语。未登记的工具用兜底文案。 */
const TOOL_RUNNING_LABEL: Readonly<Record<string, string>> = {
  'knowledge.search': '正在检索知识库…',
  'crm.get_order': '正在查询订单…',
  'channel.reply': '正在发送回复…',
  'contact.get': '正在读取客户资料…',
  'contact.segment_preview': '正在筛选客户…',
  'nurture.deliver': '正在投递外呼消息…',
}

const TOOL_DONE_LABEL: Readonly<Record<string, string>> = {
  'knowledge.search': '知识库检索完成',
  'crm.get_order': '订单查询完成',
  'channel.reply': '回复处理完成',
  'contact.get': '客户资料读取完成',
  'contact.segment_preview': '客户筛选完成',
  'nurture.deliver': '外呼投递完成',
}

/** 最小化的 session 事件形状。只声明我们真正读取的字段，减少对 dsh 内部类型的耦合。 */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/**
 * 有状态的帧投影器。
 *
 * 一个 projector 对应一条会话的一段连续事件流。跨会话不要共用（callId 会串）。
 */
export class FrameProjector {
  /** callId → 工具名。`tool/result` 靠它还原自己属于哪个工具。 */
  private readonly pendingCalls = new Map<string, string>()

  /**
   * 投影一个 session 事件。
   *
   * 不认识的事件类型返回空数组——**不抛错**，让未来 dsh 新增事件类型不会打断前端。
   *
   * @param event - session 事件。
   * @returns 该事件对应的帧序列。
   */
  push(event: SessionEventLike): readonly Frame[] {
    switch (event.type) {
      case 'turn/start':
        return [{ type: 'turn/start', seq: event.seq }]

      case 'turn/end':
        return [{ type: 'turn/done', seq: event.seq }]

      case 'assistant/chunk': {
        const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk
        if (chunk?.type !== 'text-delta') return []
        const text = chunk.text
        if (typeof text !== 'string' || text === '') return []
        return [{ type: 'text/delta', text, seq: event.seq }]
      }

      case 'tool/call': {
        const data = event.data as { name?: string; callId?: string }
        const tool = data.name ?? ''
        if (typeof data.callId === 'string') this.pendingCalls.set(data.callId, tool)
        return [
          {
            type: 'tool/status',
            status: 'running',
            tool,
            label: TOOL_RUNNING_LABEL[tool] ?? `正在执行 ${tool}…`,
            seq: event.seq,
          },
        ]
      }

      case 'tool/result':
        return this.toolResultFrames(event)

      default:
        return []
    }
  }

  private toolResultFrames(event: SessionEventLike): readonly Frame[] {
    const callId = callIdOf(event.data)
    const tool = (callId === undefined ? undefined : this.pendingCalls.get(callId)) ?? ''
    if (callId !== undefined) this.pendingCalls.delete(callId)
    const data = event.data as { meta?: unknown }

    const frames: Frame[] = [
      {
        type: 'tool/status',
        status: 'done',
        tool,
        label: TOOL_DONE_LABEL[tool] ?? (tool === '' ? '工具执行完成' : `${tool} 完成`),
        seq: event.seq,
      },
    ]

    const card = parseCard(data.meta)
    if (card === undefined) return frames

    const cardId = `card-${event.seq}`
    frames.push({
      type: 'card/open',
      cardId,
      card: {
        type: card.type,
        title: card.title,
        ...('scope' in card && card.scope !== undefined ? { scope: card.scope } : {}),
      },
      seq: event.seq,
    })

    // 条目逐个下发，驱动前端渐进渲染；降级卡没有条目
    if ('items' in card) {
      for (const item of card.items) {
        frames.push({ type: 'card/item', cardId, item: { ...item }, seq: event.seq })
      }
    }

    // card/close 之前动作应置灰：动作只在这一帧里下发
    frames.push({
      type: 'card/close',
      cardId,
      summary: card.summary,
      actions: 'actions' in card ? (card.actions ?? []).map((a) => ({ ...a })) : [],
      traceRef: event.seq,
      seq: event.seq,
    })
    return frames
  }
}

/**
 * 从 `tool/result` 事件里取出 callId。
 *
 * dsh 在两处都放了它：`message.source.callId`（ToolMessageSource，权威来源）与
 * `message.content[0].toolCallId`（模型可见块）。优先读前者，后者作为兜底——
 * 任一处的字段改名都不会让工具名标签退化成空串。
 */
function callIdOf(data: unknown): string | undefined {
  const message = (data as { message?: { source?: { callId?: unknown }; content?: readonly { toolCallId?: unknown }[] } })
    .message
  const fromSource = message?.source?.callId
  if (typeof fromSource === 'string') return fromSource
  const fromBlock = message?.content?.[0]?.toolCallId
  return typeof fromBlock === 'string' ? fromBlock : undefined
}

/**
 * 把一整串 session 事件投影成帧序列（历史重放 / 单次 turn 的响应体）。
 *
 * @param events - 按 seq 升序的事件。
 * @returns 帧序列。
 */
export function replayFrames(events: readonly SessionEventLike[]): readonly Frame[] {
  const projector = new FrameProjector()
  return events.flatMap((event) => projector.push(event))
}
