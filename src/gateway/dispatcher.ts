/**
 * 入站消息调度：把渠道消息交给 agent，并保证**同一会话串行**。
 *
 * 为什么必须串行（教训来自 Python 版并发问题）：同一会话并发跑两个 turn 会让
 * session 事件交错、上下文错乱。dsh 的 agent 本身是单 turn 串行的，但多个 HTTP
 * 请求可以同时到达——这里用 per-conversation 的 promise 链把它们排队。
 */

import type { InboundMessage } from '../channel/types.js'
import { textOf } from '../channel/types.js'
import type { TenantScope } from '../harness/session-scope.js'
import type { OpenCsRuntime } from '../runtime.js'

export interface DispatchResult {
  readonly conversationId: string
  /** 本次 turn 新产生的 session 事件序号区间（前端可据此拉取帧）。 */
  readonly fromSeq: number
  readonly toSeq: number
}

export class InboundDispatcher {
  /** conversationId → 尾部 promise。新请求接在尾部，实现 FIFO 串行。 */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly runtime: OpenCsRuntime) {}

  /**
   * 处理一条入站消息。同一 `conversationId` 的调用严格串行。
   *
   * @param message - 已解析的入站消息。
   * @returns 本次 turn 的事件区间。
   */
  async dispatch(message: InboundMessage): Promise<DispatchResult> {
    const key = message.conversationId
    const previous = this.queues.get(key) ?? Promise.resolve()
    // 前一个 turn 失败不应阻塞后续消息，因此 catch 掉再排队
    const next = previous.catch(() => undefined).then(() => this.runOne(message))
    this.queues.set(key, next)
    try {
      return await next
    } finally {
      // 只有当自己仍是队尾时才清理，避免误删后来者
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }

  private async runOne(message: InboundMessage): Promise<DispatchResult> {
    const scope: TenantScope = {
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      channelId: message.channelId,
      customerId: message.customerId,
    }
    const agent = await this.runtime.harness.agentFor(scope)
    const fromSeq = lastSeq(agent) + 1
    await this.runtime.harness.runTurn(agent, textOf(message.content))
    return { conversationId: message.conversationId, fromSeq, toSeq: lastSeq(agent) }
  }
}

function lastSeq(agent: { readonly session: { readonly events: readonly { readonly seq: number }[] } }): number {
  return agent.session.events.at(-1)?.seq ?? 0
}
