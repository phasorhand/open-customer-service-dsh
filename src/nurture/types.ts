/**
 * 节奏（cadence）领域模型。
 */

import type { AudienceFilter, LifecycleStage } from '../crm/types.js'

export type CadenceStatus = 'draft' | 'active' | 'paused'
export type RunState = 'active' | 'paused' | 'finished'

/** 运行结束的原因。用于漏斗分析——「为什么停的」比「停了」重要得多。 */
export type FinishReason =
  | 'completed'
  | 'replied'
  | 'opted_out'
  | 'stage_exit'
  | 'manual'
  | 'no_steps'
  | 'contact_gone'
  | 'unaddressable'
  | 'failed'

/**
 * 节奏中的一步。
 *
 * **双模式**（research §4 教训 #6）：
 * - `template` 非空 → 直接用，毫秒级。**大批量首触必须用这个**
 * - 否则用 `goal` 走 LLM 组稿，约 40 秒/条。留给高价值跟进步骤
 */
export interface CadenceStep {
  readonly id: string
  readonly cadenceId: string
  readonly stepOrder: number
  /** 进入本步后等待多久才发送（秒）。 */
  readonly delaySeconds: number
  /** LLM 组稿的目标描述。`template` 为空时使用。 */
  readonly goal?: string
  /** 固定文案。支持 `{{name}}` `{{company}}` 占位符。 */
  readonly template?: string
}

export interface Cadence {
  readonly id: string
  readonly tenantId: string
  readonly name: string
  readonly description?: string
  readonly channelId: string
  /**
   * 发件人身份。
   *
   * 教训 #1：为空时 composer 会明确指示模型**不要虚构任何公司名或人名**；
   * 非空时把模型约束到这个身份。绝不能让模型把客户的公司当成自己的雇主。
   */
  readonly senderPersona?: string
  readonly autoEnroll: boolean
  readonly entryFilter?: AudienceFilter
  readonly exitOnReply: boolean
  /** 到达该阶段即退出（例如到 `customer` 就不再打扰）。 */
  readonly exitOnStage?: LifecycleStage
  /** 静默时段起止（本地小时，0-23）。`22 → 9` 表示晚 10 点到早 9 点不发。 */
  readonly quietHoursStart: number
  readonly quietHoursEnd: number
  /** IANA 时区，如 `Asia/Shanghai`。 */
  readonly timezone: string
  readonly maxTouchesPerWeek: number
  readonly status: CadenceStatus
  readonly steps: readonly CadenceStep[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CadenceRun {
  readonly id: string
  readonly tenantId: string
  readonly cadenceId: string
  readonly contactId: string
  /** 下一个待执行的步骤序号。 */
  readonly currentStepOrder: number
  readonly state: RunState
  /** 到达此时刻才执行下一步。 */
  readonly nextActionAt: Date
  readonly stepEnteredAt: Date
  readonly finishReason?: FinishReason
  readonly errorReason?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** 一次 tick 的执行报告。每个数字对应五阶段中的一环，便于运维定位卡在哪。 */
export interface TickReport {
  /** 回收的过期租约数。持续 > 0 说明并发度或租约时长设置不当。 */
  readonly reaped: number
  readonly exited: number
  readonly enrolled: number
  /** 物化进发件箱的步骤数。 */
  readonly materialized: number
  readonly sent: number
  readonly failed: number
  /** 因静默时段/频控推迟的数量。 */
  readonly deferred: number
  readonly skipped: number
}

export const EMPTY_TICK: TickReport = Object.freeze({
  reaped: 0,
  exited: 0,
  enrolled: 0,
  materialized: 0,
  sent: 0,
  failed: 0,
  deferred: 0,
  skipped: 0,
})

/** 节奏的默认值。全部可在创建时覆盖。 */
export const CADENCE_DEFAULTS = Object.freeze({
  quietHoursStart: 22,
  quietHoursEnd: 9,
  timezone: 'Asia/Shanghai',
  maxTouchesPerWeek: 3,
})
