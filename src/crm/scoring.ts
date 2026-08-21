/**
 * 意向打分：0-100。
 *
 * 权重沿用 Python 版已调过的配比。四个维度刻意都是**可观测行为**，
 * 不含模型主观判断——主观判断走 lead_qualifier subagent，
 * 那里的结论会体现为阶段跃迁而不是分数。
 */

import type { LifecycleStage } from './types.js'
import { stageRank } from './lifecycle.js'

/** 各维度权重，合计 1。 */
export const WEIGHTS = Object.freeze({
  /** 互动频次：说了多少轮。 */
  frequency: 0.25,
  /** 漏斗深度：走到了哪一阶段。 */
  stage: 0.35,
  /** 回复率：触达后是否回应。 */
  responsiveness: 0.25,
  /** 新鲜度：最近是否还活跃。 */
  recency: 0.15,
})

/** 分数衰减的半衰期（天）。超过这个时长不活跃，新鲜度分减半。 */
export const RECENCY_HALF_LIFE_DAYS = 14

/** 互动频次的饱和点：超过这个轮数不再加分。 */
const FREQUENCY_SATURATION = 10

export interface ScoreInput {
  readonly lifecycleStage: LifecycleStage
  /** 入站消息轮数。 */
  readonly inboundCount: number
  /** 外呼触达次数。 */
  readonly outboundCount: number
  readonly lastInboundAt?: Date
  readonly now: Date
}

/**
 * 计算综合意向分。
 *
 * @param input - 可观测行为指标。
 * @returns 0-100 的整数分。
 */
export function computeScore(input: ScoreInput): number {
  const frequency = Math.min(input.inboundCount / FREQUENCY_SATURATION, 1)

  const maxRank = stageRank('customer')
  const rank = stageRank(input.lifecycleStage)
  // 终态 disqualified/churned 的 rank 是 -1 —— 归零而不是当成负分
  const stage = rank < 0 ? 0 : rank / maxRank

  // 从未触达过的联系人不该因为「没回复」而扣分——回复率按未知处理，给中性 0.5
  const responsiveness =
    input.outboundCount === 0 ? 0.5 : Math.min(input.inboundCount / input.outboundCount, 1)

  const recency = computeRecency(input.lastInboundAt, input.now)

  const raw =
    frequency * WEIGHTS.frequency +
    stage * WEIGHTS.stage +
    responsiveness * WEIGHTS.responsiveness +
    recency * WEIGHTS.recency

  return Math.round(Math.max(0, Math.min(1, raw)) * 100)
}

/**
 * 新鲜度：按半衰期指数衰减。
 *
 * @param lastInboundAt - 最后一次入站时间；从未入站为 `undefined`。
 * @param now - 当前时间。
 * @returns 0-1 的新鲜度。
 */
export function computeRecency(lastInboundAt: Date | undefined, now: Date): number {
  if (lastInboundAt === undefined) return 0
  const days = (now.getTime() - lastInboundAt.getTime()) / 86_400_000
  if (days <= 0) return 1
  return 2 ** (-days / RECENCY_HALF_LIFE_DAYS)
}
