/**
 * 会话 WebSocket：实时帧推送 + 重连历史重放。
 *
 * 帧的产生只有一处实现（`framesOf`），实时与历史共用——因此「重连后看到的内容」
 * 与「当时实时看到的内容」在构造上必然一致，不需要额外的一致性测试来兜底。
 */

import type { FastifyInstance } from 'fastify'

import type { OpenCsRuntime } from '../runtime.js'
import { InboundDispatcher } from './dispatcher.js'
import { FrameProjector, replayFrames, type Frame, type SessionEventLike } from './frames.js'

interface ClientMessage {
  readonly type?: string
  readonly text?: string
  readonly customer_id?: string
  readonly tenant_id?: string
}

/** 一个 WS 连接需要的最小接口，便于测试替身。 */
interface SocketLike {
  send(data: string): void
  on(event: 'message' | 'close', listener: (payload: Buffer) => void): void
  close(): void
}

export async function registerWsRoutes(app: FastifyInstance, runtime: OpenCsRuntime): Promise<void> {
  const dispatcher = new InboundDispatcher(runtime)
  /** conversationId → 在线连接集合。 */
  const subscribers = new Map<string, Set<SocketLike>>()
  /**
   * conversationId → 实时投影器。
   *
   * 必须是**长期存在**的：`tool/result` 靠 callId 关联回 `tool/call` 才知道工具名，
   * 而这两个事件跨多次 `session/event` 回调到达。每次新建 projector 会丢掉映射。
   */
  const projectors = new Map<string, FrameProjector>()

  // 每个 agent 的 session 事件 → 订阅者。dsh 的 session/event 是全局事件，按 session 分发。
  runtime.harness.ctx.on('session/event', (session: { id: unknown }, event: SessionEventLike) => {
    const conversationId = conversationOf(String(session.id))
    if (conversationId === undefined) return

    let projector = projectors.get(conversationId)
    if (projector === undefined) projectors.set(conversationId, (projector = new FrameProjector()))
    const frames = projector.push(event)

    const sockets = subscribers.get(conversationId)
    if (sockets === undefined || sockets.size === 0) return
    for (const frame of frames) broadcast(sockets, frame)
  })

  app.get('/ws/conversations/:conversationId', { websocket: true }, async (socket, request) => {
    const { conversationId } = request.params as { conversationId: string }
    const query = request.query as { customer_id?: string; tenant_id?: string }
    const customerId = query.customer_id ?? conversationId
    const tenantId = query.tenant_id ?? runtime.config.tenantId

    const client = socket as unknown as SocketLike
    let set = subscribers.get(conversationId)
    if (set === undefined) subscribers.set(conversationId, (set = new Set()))
    set.add(client)
    client.on('close', () => {
      set.delete(client)
      if (set.size === 0) {
        subscribers.delete(conversationId)
        // 没人在看就丢掉投影器状态；重连时用 replayFrames 从头重建，不会丢信息
        projectors.delete(conversationId)
      }
    })

    // 重连：先把历史帧一次性回放，前端据此重建整个时间线
    const agent = await runtime.harness.agentFor({
      tenantId,
      conversationId,
      channelId: 'webchat',
      customerId,
    })
    client.send(
      JSON.stringify({
        type: 'history',
        conversationId,
        frames: replayFrames(agent.session.events as readonly SessionEventLike[]),
      }),
    )

    client.on('message', (raw: Buffer) => {
      const parsed = parseClientMessage(raw)
      if (parsed === undefined) return
      void dispatcher
        .dispatch({
          channelId: 'webchat',
          conversationId,
          customerId: parsed.customer_id ?? customerId,
          senderKind: 'customer',
          content: [{ kind: 'text', text: parsed.text as string }],
          timestamp: new Date(),
          tenantId: parsed.tenant_id ?? tenantId,
        })
        .catch((error: unknown) => {
          client.send(JSON.stringify({ type: 'error', message: String(error) }))
        })
    })
  })
}

/** session id 形如 `conv-<tenant>-<conversationId>`（见 assemble.ts）。 */
function conversationOf(sessionId: string): string | undefined {
  const match = /^conv-[^-]+-(.+)$/.exec(sessionId)
  return match?.[1]
}

function broadcast(sockets: Iterable<SocketLike>, frame: Frame): void {
  const payload = JSON.stringify(frame)
  for (const socket of sockets) {
    try {
      socket.send(payload)
    } catch {
      // 坏连接不能打断其他订阅者（dsh defensive-patterns §6）
    }
  }
}

function parseClientMessage(raw: Buffer): ClientMessage | undefined {
  let message: ClientMessage
  try {
    message = JSON.parse(raw.toString('utf8')) as ClientMessage
  } catch {
    return undefined
  }
  if (message.type !== 'user') return undefined
  if (typeof message.text !== 'string' || message.text.trim() === '') return undefined
  return message
}
