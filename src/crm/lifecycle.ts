/**
 * 生命周期状态机。
 *
 * 为什么强制单调（RESEARCH.md）：漏斗指标依赖单调性。允许随意回退会让
 * 「转化率」失去意义，也会让节奏引擎的 `exit_on_stage` 判定反复触发
 * （联系人被反复退出/重新入组，产生重复触达）。
 */

import { STAGE_ORDER, TERMINAL_STAGES, type LifecycleStage } from './types.js'

export class LifecycleError extends Error {
  override readonly name = 'LifecycleError'
}

/** 阶段在单调序列里的位置；终态返回 -1（不参与前进比较）。 */
export function stageRank(stage: LifecycleStage): number {
  return STAGE_ORDER.indexOf(stage)
}

/**
 * 校验一次阶段跃迁。
 *
 * 规则：
 * - 同阶段 → 允许（幂等）
 * - 前进 → 允许
 * - 进入终态（customer / disqualified / churned）→ 允许（从任意阶段）
 * - 从终态离开 → 拒绝，除非 `force`
 * - 回退 → 拒绝，除非 `force`
 *
 * @param from - 当前阶段。
 * @param to - 目标阶段。
 * @param force - 是否强制（RED 风险档，需人工确认）。
 * @returns 允许则 `undefined`，拒绝则返回原因文本。
 */
export function checkTransition(from: LifecycleStage, to: LifecycleStage, force = false): string | undefined {
  if (from === to) return undefined
  if (force) return undefined

  if (TERMINAL_STAGES.has(from)) {
    return `联系人已处于终态 ${from}，不能改为 ${to}；如确需调整请走强制变更（需人工确认）`
  }
  if (TERMINAL_STAGES.has(to)) return undefined

  const fromRank = stageRank(from)
  const toRank = stageRank(to)
  if (toRank > fromRank) return undefined

  return `生命周期只能前进：${from} → ${to} 是回退；如确需调整请走强制变更（需人工确认）`
}

/**
 * 校验并返回跃迁后的阶段。
 *
 * @param from - 当前阶段。
 * @param to - 目标阶段。
 * @param force - 是否强制。
 * @returns 目标阶段。
 * @throws {LifecycleError} 跃迁非法。
 */
export function applyTransition(from: LifecycleStage, to: LifecycleStage, force = false): LifecycleStage {
  const rejection = checkTransition(from, to, force)
  if (rejection !== undefined) throw new LifecycleError(rejection)
  return to
}

/**
 * 根据入站行为推进阶段。
 *
 * 只做**最小推进**：客户主动说话 → 至少到 `engaged`。
 * 更深的阶段（qualified / opportunity）由 lead_qualifier subagent 判定，
 * 不由「有没有说话」这种弱信号决定。
 *
 * @param current - 当前阶段。
 * @returns 推进后的阶段；不该推进时原样返回。
 */
export function advanceOnInbound(current: LifecycleStage): LifecycleStage {
  if (TERMINAL_STAGES.has(current)) return current
  return stageRank(current) < stageRank('engaged') ? 'engaged' : current
}
