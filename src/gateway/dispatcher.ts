/**
 * 入站消息调度：把渠道消息交给 agent，并保证**同一会话串行**。
 *
 * 为什么必须串行（教训来自 Python 版并发问题）：同一会话并发跑两个 turn 会让
 * session 事件交错、上下文错乱。dsh 的 agent 本身是单 turn 串行的，但多个 HTTP
 * 请求可以同时到达——这里用 per-conversation 的 promise 链把它们排队。
 */

import type { InboundMessage } from '../channel/types.js'
import { textOf } from '../channel/types.js'
import { evaluateAll } from '../evaluation/cs-metrics.js'
import type { TenantScope } from '../harness/session-scope.js'
import type { OpenCsRuntime } from '../runtime.js'
import type { SessionEventLike } from './frames.js'

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
    // 先落 CRM：识别/建档、推进阶段、重新打分。这一步在 agent 之前完成，
    // 因为 contactId 要作为权限事实注入 scope，供 CRM 工具反查。
    const contact = this.resolveContact(message)

    const scope: TenantScope = {
      tenantId: message.tenantId,
      conversationId: message.conversationId,
      channelId: message.channelId,
      customerId: message.customerId,
      ...(contact === undefined ? {} : { contactId: contact.id }),
    }
    const agent = await this.runtime.harness.agentFor(scope)
    const fromSeq = lastSeq(agent) + 1
    const inputText = textOf(message.content)
    await this.runtime.harness.runTurn(agent, inputText)
    const toSeq = lastSeq(agent)

    this.evaluateTurn(message, inputText, agent, fromSeq, toSeq)
    return { conversationId: message.conversationId, fromSeq, toSeq }
  }

  /**
   * 对本轮回复做实时评测。
   *
   * 只跑确定性规则（越权承诺、语气、推进度），不调模型——
   * 每轮都调 LLM 评分会让成本翻倍且拖慢回复。主观质量判断留给 gate 阶段。
   *
   * 评测失败**不阻断回复**：话已经发出去了，评测的作用是留下证据供演进，
   * 而不是事后拦截。
   */
  private evaluateTurn(
    message: InboundMessage,
    inputText: string,
    agent: { readonly session: { readonly events: readonly SessionEventLike[] } },
    fromSeq: number,
    toSeq: number,
  ): void {
    try {
      const fresh = agent.session.events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq)
      const outputText = this.runtime.webchat.peek(message.conversationId)
      if (outputText === '') return

      const toolsUsed = fresh
        .filter((event) => event.type === 'tool/call')
        .map((event) => (event.data as { name?: string }).name ?? '')
      const knowledgeHits = knowledgeHitCount(fresh)

      const { results, passed } = evaluateAll({
        input: inputText,
        output: outputText,
        toolsUsed,
        ...(knowledgeHits === undefined ? {} : { knowledgeHits }),
      })
      this.runtime.evals.save({
        tenantId: message.tenantId,
        conversationId: message.conversationId,
        mode: 'realtime',
        passed,
        metrics: results,
        inputText,
        outputText,
      })
    } catch {
      // 评测是旁路：它出问题不该影响客户已经收到的回复
    }
  }

  private resolveContact(message: InboundMessage): { readonly id: string } | undefined {
    try {
      return this.runtime.contacts.onInbound(message)
    } catch (error) {
      // CRM 识别失败不阻断客服回复：客户仍应得到答复，只是这轮没有画像
      this.onContactError(message, error)
      return undefined
    }
  }

  /** CRM 识别失败的处理钩子。默认静默；P7 接到审计日志。 */
  private onContactError(_message: InboundMessage, _error: unknown): void {
    // 有意为空：失败已由 resolveContact 降级处理，此处只是扩展点
  }
}

/** 从本轮事件里取知识库命中数，供「零命中却给确定答复」的合规判定。 */
function knowledgeHitCount(events: readonly SessionEventLike[]): number | undefined {
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const meta = (event.data as { meta?: { type?: string; items?: unknown[] } }).meta
    if (meta?.type === 'knowledge_hit') return Array.isArray(meta.items) ? meta.items.length : 0
  }
  return undefined
}

function lastSeq(agent: { readonly session: { readonly events: readonly { readonly seq: number }[] } }): number {
  return agent.session.events.at(-1)?.seq ?? 0
}
