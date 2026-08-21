import { describe, expect, it } from 'vitest'

import { SlidingWindowRateLimiter } from '../../src/harness/plugins/guard-risk.js'
import { DEFAULT_TIER, RISK_TIERS, RiskTier, TIER_LABEL, tierOf } from '../../src/harness/risk.js'

describe('风险档登记表', () => {
  it('只读工具在 GREEN 档', () => {
    expect(tierOf('knowledge.search')).toBe(RiskTier.GREEN)
    expect(tierOf('crm.get_order')).toBe(RiskTier.GREEN)
  })

  it('面向客户的自由文本回复在 ORANGE_C 档', () => {
    expect(tierOf('channel.reply')).toBe(RiskTier.ORANGE_C)
  })

  it('不可逆商业动作在 RED 档', () => {
    expect(tierOf('contact.update_stage')).toBe(RiskTier.RED)
    expect(tierOf('contact.mark_won')).toBe(RiskTier.RED)
  })

  it('未登记工具落到保守兜底档，而不是被放行', () => {
    expect(tierOf('some.unregistered.tool')).toBe(DEFAULT_TIER)
    expect(DEFAULT_TIER).toBe(RiskTier.ORANGE_C)
  })

  it('每个档位都有中文标签', () => {
    for (const tier of [0, 1, 2, 3, 4, 5] as RiskTier[]) {
      expect(TIER_LABEL[tier]).toBeTypeOf('string')
      expect(TIER_LABEL[tier].length).toBeGreaterThan(0)
    }
  })

  it('登记表里的档位都是合法枚举值', () => {
    for (const [tool, tier] of Object.entries(RISK_TIERS)) {
      expect(RiskTier[tier], `${tool} 的档位 ${tier} 不是合法枚举`).toBeTypeOf('string')
    }
  })
})

describe('SlidingWindowRateLimiter', () => {
  it('窗口内超过配额即拒绝', () => {
    let now = 0
    const limiter = new SlidingWindowRateLimiter(1000, 2, () => now)
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toMatch(/频控/)
  })

  it('窗口滑过后重新放行', () => {
    let now = 0
    const limiter = new SlidingWindowRateLimiter(1000, 1, () => now)
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toMatch(/频控/)
    now = 1001
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
  })

  it('不同联系人各自计数', () => {
    const limiter = new SlidingWindowRateLimiter(1000, 1, () => 0)
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
    expect(limiter.check('nurture.deliver', { contact_id: 'c2' })).toBeUndefined()
  })

  it('不同工具各自计数', () => {
    const limiter = new SlidingWindowRateLimiter(1000, 1, () => 0)
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
    expect(limiter.check('channel.send_template', { contact_id: 'c1' })).toBeUndefined()
  })

  it('无目标标识时不限流（限流是按目标的）', () => {
    const limiter = new SlidingWindowRateLimiter(1000, 1, () => 0)
    expect(limiter.check('nurture.deliver', {})).toBeUndefined()
    expect(limiter.check('nurture.deliver', undefined)).toBeUndefined()
    expect(limiter.check('nurture.deliver', {})).toBeUndefined()
  })

  it('按 customer_id / conversation_id 兜底取目标', () => {
    const limiter = new SlidingWindowRateLimiter(1000, 1, () => 0)
    expect(limiter.check('nurture.deliver', { customer_id: 'u1' })).toBeUndefined()
    expect(limiter.check('nurture.deliver', { customer_id: 'u1' })).toMatch(/频控/)
  })

  it('reset 清空计数', () => {
    const limiter = new SlidingWindowRateLimiter(1000, 1, () => 0)
    limiter.check('nurture.deliver', { contact_id: 'c1' })
    limiter.reset()
    expect(limiter.check('nurture.deliver', { contact_id: 'c1' })).toBeUndefined()
  })
})
