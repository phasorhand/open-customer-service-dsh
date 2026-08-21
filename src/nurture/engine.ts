/**
 * 节奏引擎：五阶段 tick。
 *
 * ```
 * reap（回收过期租约） → exit（退出条件） → enrol（自动入组）
 *   → advance（到期步骤物化进发件箱） → drain（并发投递）
 * ```
 *
 * 阶段顺序有语义：
 * - reap 在最前：先把死 worker 的活放回队列，否则本轮 drain 会漏掉它们
 * - exit 在 enrol 之前：已回复的人应先退出，避免同一 tick 内退出又入组
 * - advance 在 drain 之前：本轮物化的消息本轮就能发，减少一个 tick 的延迟
 *
 * **drain 必须并发**（research §4 教训 #2）：真实 LLM 组稿约 40 秒/条，
 * 串行 50 条 = 33 分钟 > 300 秒租约 → reaper 回收 → 重复发送。
 */

import { randomUUID } from 'node:crypto'

import type { ContactService } from '../crm/service.js'
import { isAddressable, type Contact } from '../crm/types.js'
import type { OutboundPort } from '../harness/ports.js'
import type { SendOutbox } from '../outreach/outbox.js'
import type { OutreachComposer } from './composer.js'
import { checkWeeklyCap, isQuietHour, nextOpenSlot, WEEK_MS, type QuietHours } from './pacing.js'
import type { CadenceStore } from './store.js'
import { EMPTY_TICK, type Cadence, type CadenceRun, type FinishReason, type TickReport } from './types.js'

export interface NurtureEngineOptions {
  readonly cadences: CadenceStore
  readonly outbox: SendOutbox
  readonly contacts: ContactService
  readonly composer: OutreachComposer
  readonly outbound: OutboundPort
  /** 并发投递数。**不要设成 1** —— 见文件头注释。 */
  readonly drainConcurrency: number
  readonly leaseSeconds: number
  readonly pollIntervalSeconds: number
  /** 每轮最多物化多少步，防止单 tick 过长。 */
  readonly batchSize?: number
  readonly onError?: (phase: string, error: unknown, context?: Record<string, unknown>) => void
}

const DEFAULT_BATCH = 200

export class NurtureEngine {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`
  private timer: NodeJS.Timeout | undefined
  private running = false
  private inFlight: Promise<unknown> | undefined

  constructor(private readonly options: NurtureEngineOptions) {}

  /** 启动周期性 tick。 */
  start(): void {
    if (this.timer !== undefined) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.inFlight = this.tick().catch((error: unknown) => {
        this.options.onError?.('tick', error)
      })
    }
    this.timer = setInterval(loop, this.options.pollIntervalSeconds * 1000)
    // 不阻塞进程退出：引擎是后台任务，不该让 CLI/测试挂住
    this.timer.unref?.()
  }

  /** 停止并等待在途 tick 结束。 */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.inFlight
    this.inFlight = undefined
  }

  /**
   * 执行一轮 tick。
   *
   * @param now - 当前时刻（注入便于测试）。
   * @returns 各阶段的处理计数。
   */
  async tick(now = new Date()): Promise<TickReport> {
    const reaped = this.reap(now)
    const exited = this.exitRuns(now)
    const enrolled = this.enrol(now)
    const materialized = await this.advance(now)
    const drained = await this.drain(now)

    return {
      ...EMPTY_TICK,
      reaped,
      exited,
      enrolled,
      materialized: materialized.materialized,
      deferred: materialized.deferred,
      skipped: materialized.skipped,
      sent: drained.sent,
      failed: drained.failed,
    }
  }

  /** ① 回收过期租约。 */
  private reap(now: Date): number {
    const reaped = this.options.outbox.reapExpiredLeases(now)
    if (reaped > 0) {
      // 持续回收到东西是告警信号：并发度不足或租约过短，正在制造重复发送风险
      this.options.onError?.('reap', new Error(`回收了 ${reaped} 条过期租约`), {
        hint: '并发度或租约时长可能设置不当',
      })
    }
    return reaped
  }

  /** ② 退出条件：已回复 / 已到目标阶段 / 已退订 / 联系人消失。 */
  private exitRuns(now: Date): number {
    let exited = 0
    for (const run of this.options.cadences.listActiveRuns()) {
      const cadence = this.options.cadences.get(run.cadenceId)
      if (cadence === undefined) {
        this.finish(run, 'contact_gone', now)
        exited += 1
        continue
      }
      const reason = this.exitReason(cadence, run)
      if (reason !== undefined) {
        this.finish(run, reason, now)
        exited += 1
      }
    }
    return exited
  }

  private exitReason(cadence: Cadence, run: CadenceRun): FinishReason | undefined {
    let contact: Contact
    try {
      contact = this.options.contacts.require(run.contactId)
    } catch {
      return 'contact_gone'
    }

    if (contact.leadStatus === 'opted_out') return 'opted_out'
    if (cadence.exitOnStage !== undefined && contact.lifecycleStage === cadence.exitOnStage) return 'stage_exit'
    // 客户主动回复即停：继续按节奏轰炸一个已经在对话的人是最伤体验的行为
    if (cadence.exitOnReply && hasRepliedSinceEnrolment(contact, run)) return 'replied'
    return undefined
  }

  /** ③ 自动入组：把命中 entryFilter 的联系人加入节奏。 */
  private enrol(now: Date): number {
    let enrolled = 0
    for (const cadence of this.options.cadences.listActive()) {
      if (!cadence.autoEnroll || cadence.entryFilter === undefined) continue
      try {
        const candidates = this.options.contacts.segment(cadence.tenantId, cadence.entryFilter)
        for (const contact of candidates) {
          // 不可触达的人不入组：入了也只会在 drain 阶段失败，白占运行记录
          if (!isAddressable(contact)) continue
          const { created } = this.options.cadences.enroll(cadence, contact.id, now)
          if (created) enrolled += 1
        }
      } catch (error) {
        this.options.onError?.('enrol', error, { cadenceId: cadence.id })
      }
    }
    return enrolled
  }

  /** ④ 物化：把到期的步骤组稿并写进发件箱。 */
  private async advance(now: Date): Promise<{ materialized: number; deferred: number; skipped: number }> {
    let materialized = 0
    let deferred = 0
    let skipped = 0

    const due = this.options.cadences.listDueRuns(now, this.options.batchSize ?? DEFAULT_BATCH)
    for (const run of due) {
      try {
        const result = await this.materializeOne(run, now)
        if (result === 'materialized') materialized += 1
        else if (result === 'deferred') deferred += 1
        else skipped += 1
      } catch (error) {
        this.options.onError?.('advance', error, { runId: run.id, contactId: run.contactId })
        this.finish(run, 'failed', now, String(error))
        skipped += 1
      }
    }
    return { materialized, deferred, skipped }
  }

  private async materializeOne(run: CadenceRun, now: Date): Promise<'materialized' | 'deferred' | 'skipped'> {
    const cadence = this.options.cadences.require(run.cadenceId)
    const step = cadence.steps.find((candidate) => candidate.stepOrder === run.currentStepOrder)
    if (step === undefined) {
      // 走完全部步骤
      this.finish(run, cadence.steps.length === 0 ? 'no_steps' : 'completed', now)
      return 'skipped'
    }

    const contact = this.options.contacts.require(run.contactId)
    if (!isAddressable(contact)) {
      // 显式失败并记录，绝不静默跳过（教训 #4）
      this.finish(run, 'unaddressable', now, '联系人没有任何渠道身份')
      return 'skipped'
    }

    const quiet: QuietHours = {
      start: cadence.quietHoursStart,
      end: cadence.quietHoursEnd,
      timezone: cadence.timezone,
    }
    if (isQuietHour(now, quiet)) {
      this.options.cadences.deferRun(run.id, nextOpenSlot(now, quiet), now)
      return 'deferred'
    }

    const capped = checkWeeklyCap(
      this.options.outbox.recentTouches(contact.id, new Date(now.getTime() - WEEK_MS)),
      now,
      cadence.maxTouchesPerWeek,
    )
    if (capped !== undefined) {
      // 推到下周窗口开启，而不是丢弃这一步
      this.options.cadences.deferRun(run.id, new Date(now.getTime() + WEEK_MS / 7), now)
      return 'deferred'
    }

    const composed = await this.options.composer.compose({
      step,
      contact,
      cadenceName: cadence.name,
      ...(cadence.senderPersona === undefined ? {} : { senderPersona: cadence.senderPersona }),
    })

    const identity = contact.identities.find((entry) => entry.channelId === cadence.channelId) ?? contact.identities[0]
    if (identity === undefined) {
      this.finish(run, 'unaddressable', now, '找不到可用的渠道身份')
      return 'skipped'
    }

    // enqueue 是幂等的：(run, step) 唯一约束保证重复物化不会产生第二条
    this.options.outbox.enqueue({
      tenantId: cadence.tenantId,
      cadenceRunId: run.id,
      stepOrder: step.stepOrder,
      contactId: contact.id,
      channelId: identity.channelId,
      customerId: identity.externalId,
      content: composed.text,
      scheduledAt: now,
    })

    // 推进到下一步。找不到下一步时 next 停在当前之后，下轮 materialize 会判 completed
    const next = cadence.steps.find((candidate) => candidate.stepOrder > step.stepOrder)
    this.options.cadences.advanceRun(
      run.id,
      next?.stepOrder ?? step.stepOrder + 1,
      new Date(now.getTime() + (next?.delaySeconds ?? 0) * 1000),
      now,
    )
    return 'materialized'
  }

  /**
   * ⑤ 并发投递。
   *
   * 并发度由 `drainConcurrency` 控制。**这不是优化，是正确性要求**——
   * 串行会让批处理时长超过租约，触发 reaper 回收并重复发送。
   */
  private async drain(now: Date): Promise<{ sent: number; failed: number }> {
    const batch = this.options.outbox.claim(
      this.workerId,
      this.options.drainConcurrency * 4,
      this.options.leaseSeconds,
      now,
    )
    if (batch.length === 0) return { sent: 0, failed: 0 }

    let sent = 0
    let failed = 0
    const queue = [...batch]

    const worker = async (): Promise<void> => {
      for (;;) {
        const send = queue.shift()
        if (send === undefined) return
        try {
          const result = await this.options.outbound.deliver(
            { channelId: send.channelId, conversationId: send.contactId, customerId: send.customerId },
            send.content,
          )
          if (result.ok) {
            this.options.outbox.markSent(send.id)
            this.options.contacts.onOutbound(send.contactId)
            sent += 1
          } else {
            this.options.outbox.markFailed(send.id, result.error, result.retryable)
            failed += 1
          }
        } catch (error) {
          // 未预期异常按可重试处理：可能是瞬时网络问题
          this.options.outbox.markFailed(send.id, String(error), true)
          this.options.onError?.('drain', error, { sendId: send.id, contactId: send.contactId })
          failed += 1
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(this.options.drainConcurrency, queue.length) }, () => worker()))
    return { sent, failed }
  }

  private finish(run: CadenceRun, reason: FinishReason, now: Date, errorReason?: string): void {
    this.options.cadences.finishRun(run.id, reason, now, errorReason)
    try {
      this.options.contacts.require(run.contactId)
      // 记进联系人时间线，让运营在客户档案里看得到「为什么退出了节奏」
    } catch {
      return
    }
  }
}

/** 入组之后是否有过入站消息。 */
function hasRepliedSinceEnrolment(contact: Contact, run: CadenceRun): boolean {
  if (contact.lastInboundAt === undefined) return false
  return contact.lastInboundAt.getTime() > run.createdAt.getTime()
}
