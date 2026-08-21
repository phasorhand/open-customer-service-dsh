/**
 * 风险分级 guard —— Python 版 `ActionGuard.evaluate()` 的框架级等价物。
 *
 * 裁决顺序：
 *   1. 档位 ≤ 自动放行上限 → `allow`（继续 waterfall）
 *   2. 否则 → `ask`（走 dsh 的 approval 通道 / HITL 队列）
 *
 * 频控在 {@link RateLimiter} 里独立表达：外呼类工具（ORANGE_A/B）即使档位允许，
 * 超过窗口配额也会 `deny`——这是 Python 版「租约超时重复发送」教训的护栏。
 *
 * 审计：deny/ask 由 dsh 自动写进 session 事件；跨会话可查询的投影另落 audit 表（P7）。
 */

import type { Context } from '@deepseek-ai/cordis'

import { RiskTier, TIER_LABEL, tierOf } from '../risk.js'

export const name = 'opencs-guard-risk'
export const inject = ['tools']

export interface RiskGuardConfig {
  /** 自动放行的档位集合；不在其中的走 `ask`。来自 `OPENCS_AUTO_APPROVE_TIERS`。 */
  readonly autoApproveTiers: readonly number[]
  /** 频控器；省略则不做频控（测试与离线冒烟）。 */
  readonly rateLimiter?: RateLimiter
  /** 审计回调；每次裁决都会调用一次。 */
  readonly onDecision?: (entry: RiskDecisionEntry) => void
}

/** 一次风险裁决的审计记录。 */
export interface RiskDecisionEntry {
  readonly toolName: string
  readonly tier: RiskTier
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason?: string
  readonly at: Date
}

/** 频控接口。实现方按 (工具, 目标) 维度限流。 */
export interface RateLimiter {
  /**
   * 是否允许本次调用。
   *
   * @param toolName - 工具名。
   * @param args - 已校验的调用参数（用于取出目标联系人/渠道）。
   * @returns 允许则 `undefined`，拒绝则返回原因文本。
   */
  check(toolName: string, args: Record<string, unknown> | undefined): string | undefined
}

export function apply(ctx: Context, config: RiskGuardConfig): void {
  const autoApprove = new Set(config.autoApproveTiers)

  ctx.on('tools/pre-execute', async (exec, next) => {
    const tier = tierOf(exec.name)
    const args = exec.arguments as Record<string, unknown> | undefined

    // 频控优先于档位：即使自动放行档，超配额也要拦
    if (tier >= RiskTier.ORANGE_A && config.rateLimiter !== undefined) {
      const blocked = config.rateLimiter.check(exec.name, args)
      if (blocked !== undefined) {
        config.onDecision?.({ toolName: exec.name, tier, decision: 'deny', reason: blocked, at: new Date() })
        return { kind: 'deny' as const, reason: blocked }
      }
    }

    if (!autoApprove.has(tier)) {
      const reason = `${exec.name} 属于 ${TIER_LABEL[tier]}，需人工确认后执行`
      config.onDecision?.({ toolName: exec.name, tier, decision: 'ask', reason, at: new Date() })
      return { kind: 'ask' as const, reason }
    }

    config.onDecision?.({ toolName: exec.name, tier, decision: 'allow', at: new Date() })
    return next()
  })
}

/**
 * 滑动窗口频控。
 *
 * 用途：`nurture.deliver` / `channel.send_template` 的每联系人触达上限。
 * 这是「并发 drain 导致重复发送」的最后一道护栏——即使上游租约逻辑出错，
 * 同一联系人在窗口内也不会被打爆。
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>()

  /**
   * @param windowMs - 窗口长度（毫秒）。
   * @param maxPerWindow - 窗口内最大触达次数。
   * @param now - 时钟注入，便于测试。
   */
  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
    const target = targetKey(args)
    if (target === undefined) return undefined
    const key = `${toolName}:${target}`
    const current = this.now()
    const recent = (this.hits.get(key) ?? []).filter((ts) => current - ts < this.windowMs)

    if (recent.length >= this.maxPerWindow) {
      this.hits.set(key, recent)
      return `触达频控：${target} 在 ${Math.round(this.windowMs / 3_600_000)} 小时内已触达 ${recent.length} 次，已达上限 ${this.maxPerWindow}`
    }

    recent.push(current)
    this.hits.set(key, recent)
    return undefined
  }

  /** 测试用：清空计数。 */
  reset(): void {
    this.hits.clear()
  }
}

function targetKey(args: Record<string, unknown> | undefined): string | undefined {
  for (const field of ['contact_id', 'customer_id', 'conversation_id'] as const) {
    const value = args?.[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}
