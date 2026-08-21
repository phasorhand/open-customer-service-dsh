import { afterEach, describe, expect, it } from 'vitest'

import type { Contact } from '../../src/crm/types.js'
import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'
import {
  OutreachComposer,
  buildSystemPrompt,
  buildUserPrompt,
  renderTemplate,
  type ComposerLlm,
} from '../../src/nurture/composer.js'
import { checkWeeklyCap, isQuietHour, localHour, nextOpenSlot } from '../../src/nurture/pacing.js'
import { MAX_ATTEMPTS, OUTREACH_MIGRATIONS, SendOutbox } from '../../src/outreach/outbox.js'

let db: Db
afterEach(() => db?.close())

const CONTACT: Contact = {
  id: 'c1',
  tenantId: 'default',
  dedupKey: 'email:a@b.com',
  name: '张三',
  company: '晨光电商',
  lifecycleStage: 'engaged',
  leadStatus: 'contacted',
  score: 60,
  tags: ['vip'],
  attributes: {},
  identities: [{ channelId: 'webchat', externalId: 'u1', linkedAt: new Date() }],
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('pacing · 静默时段', () => {
  const quiet = { start: 22, end: 9, timezone: 'Asia/Shanghai' }

  it('跨午夜区间：深夜属于静默', () => {
    // 2026-08-21T18:00Z = 次日 02:00 上海时间
    expect(isQuietHour(new Date('2026-08-21T18:00:00Z'), quiet)).toBe(true)
  })

  it('跨午夜区间：白天不属于静默', () => {
    // 2026-08-21T06:00Z = 14:00 上海时间
    expect(isQuietHour(new Date('2026-08-21T06:00:00Z'), quiet)).toBe(false)
  })

  it('start === end 表示不设静默', () => {
    expect(isQuietHour(new Date(), { start: 0, end: 0, timezone: 'Asia/Shanghai' })).toBe(false)
  })

  it('非跨午夜区间也正确', () => {
    const lunch = { start: 12, end: 14, timezone: 'UTC' }
    expect(isQuietHour(new Date('2026-08-21T13:00:00Z'), lunch)).toBe(true)
    expect(isQuietHour(new Date('2026-08-21T15:00:00Z'), lunch)).toBe(false)
  })

  it('时区确实生效：同一 UTC 时刻在不同时区结论不同', () => {
    const at = new Date('2026-08-21T18:00:00Z')
    expect(localHour(at, 'Asia/Shanghai')).toBe(2)
    expect(localHour(at, 'UTC')).toBe(18)
  })

  it('非法时区不抛错，退回 UTC（一个写错的时区不该让投递停摆）', () => {
    expect(() => localHour(new Date(), '不存在/时区')).not.toThrow()
  })

  it('nextOpenSlot 在非静默时原样返回', () => {
    const at = new Date('2026-08-21T06:00:00Z')
    expect(nextOpenSlot(at, quiet).getTime()).toBe(at.getTime())
  })

  it('nextOpenSlot 推进到静默结束后', () => {
    const at = new Date('2026-08-21T18:00:00Z')
    const slot = nextOpenSlot(at, quiet)
    expect(slot.getTime()).toBeGreaterThan(at.getTime())
    expect(isQuietHour(slot, quiet)).toBe(false)
  })
})

describe('pacing · 周频控', () => {
  const now = new Date('2026-08-21T00:00:00Z')

  it('未达上限放行', () => {
    expect(checkWeeklyCap([now], now, 3)).toBeUndefined()
  })

  it('达到上限拒绝', () => {
    const touches = [now, now, now]
    expect(checkWeeklyCap(touches, now, 3)).toMatch(/上限/)
  })

  it('窗口外的触达不计入', () => {
    const old = new Date(now.getTime() - 8 * 24 * 3600 * 1000)
    expect(checkWeeklyCap([old, old, old], now, 3)).toBeUndefined()
  })

  it('上限为 0 直接拒绝', () => {
    expect(checkWeeklyCap([], now, 0)).toMatch(/上限为 0/)
  })
})

describe('composer · 身份边界（教训 #1 的回归防线）', () => {
  it('system prompt 明确「客户的公司不是你的公司」', () => {
    const prompt = buildSystemPrompt('OpenCS 的客户成功顾问小林')
    expect(prompt).toContain('客户所在的公司')
    expect(prompt).toContain('不要把客户的公司当成自己的雇主')
  })

  it('给定 persona 时把模型约束到该身份', () => {
    expect(buildSystemPrompt('OpenCS 的小林')).toContain('你的身份是且仅是：OpenCS 的小林')
  })

  it('persona 为空时明确禁止虚构公司与姓名', () => {
    const prompt = buildSystemPrompt(undefined)
    expect(prompt).toMatch(/绝对不要.*自称属于任何公司/)
    expect(prompt).toMatch(/不要虚构姓名/)
  })

  it('空串 persona 等同于未提供', () => {
    expect(buildSystemPrompt('   ')).toMatch(/绝对不要.*自称属于任何公司/)
  })

  it('user prompt 里的公司字段标明归属（第二层保险）', () => {
    expect(buildUserPrompt('跟进', CONTACT, '首触节奏')).toContain('客户所在公司（不是你的公司）：晨光电商')
  })

  it('缺姓名时明确指示不要编造', () => {
    const anonymous: Contact = { ...CONTACT, name: undefined as never }
    expect(buildUserPrompt('跟进', anonymous, 'x')).toContain('不要编造姓名')
  })
})

describe('composer · 模板模式', () => {
  it('替换占位符', () => {
    expect(renderTemplate('{{name}}你好，来自{{company}}的订单已处理。', CONTACT)).toBe(
      '张三你好，来自晨光电商的订单已处理。',
    )
  })

  it('缺失字段替换为空串，绝不把 {{name}} 原样发出去', () => {
    const anonymous: Contact = { ...CONTACT, name: undefined as never, company: undefined as never }
    const text = renderTemplate('{{name}}你好，{{company}}的订单已处理。', anonymous)
    expect(text).not.toContain('{{')
  })

  it('未知占位符也被清掉', () => {
    expect(renderTemplate('你好{{unknown_field}}。', CONTACT)).not.toContain('{{')
  })

  it('占位符落空后收拾孤立标点', () => {
    const anonymous: Contact = { ...CONTACT, name: undefined as never }
    expect(renderTemplate('你好{{name}}，请查收。', anonymous)).not.toMatch(/^你好，，/)
  })

  it('超长字段被截断，避免撑爆消息', () => {
    const long: Contact = { ...CONTACT, company: 'x'.repeat(200) }
    expect(renderTemplate('{{company}}', long).length).toBeLessThanOrEqual(60)
  })
})

describe('OutreachComposer · 模式选择', () => {
  const stubLlm: ComposerLlm = { async complete() { return '  ```\n模型生成的文案。\n```  ' } }
  const composer = new OutreachComposer(stubLlm)

  it('有 template 时短路，不调 LLM（大批量首触的成本关键）', async () => {
    let called = false
    const spy: ComposerLlm = { async complete() { called = true; return 'x' } }
    const result = await new OutreachComposer(spy).compose({
      step: { id: 's', cadenceId: 'c', stepOrder: 0, delaySeconds: 0, template: '你好 {{name}}' },
      contact: CONTACT,
      cadenceName: '首触',
    })
    expect(result).toEqual({ text: '你好 张三', mode: 'template' })
    expect(called).toBe(false)
  })

  it('只有 goal 时走 LLM', async () => {
    const result = await composer.compose({
      step: { id: 's', cadenceId: 'c', stepOrder: 0, delaySeconds: 0, goal: '邀约试用' },
      contact: CONTACT,
      cadenceName: '跟进',
    })
    expect(result.mode).toBe('llm')
  })

  it('清掉模型自作主张的 Markdown 代码块', async () => {
    const result = await composer.compose({
      step: { id: 's', cadenceId: 'c', stepOrder: 0, delaySeconds: 0, goal: '邀约试用' },
      contact: CONTACT,
      cadenceName: '跟进',
    })
    expect(result.text).toBe('模型生成的文案。')
  })

  it('清掉「以下是消息：」之类的前言', async () => {
    const chatty: ComposerLlm = { async complete() { return '以下是给客户的消息：你好张三。' } }
    const result = await new OutreachComposer(chatty).compose({
      step: { id: 's', cadenceId: 'c', stepOrder: 0, delaySeconds: 0, goal: 'x' },
      contact: CONTACT,
      cadenceName: 'y',
    })
    expect(result.text).toBe('你好张三。')
  })

  it('既无 template 也无 goal 时抛错（配置问题应尽早暴露）', async () => {
    await expect(
      composer.compose({
        step: { id: 's', cadenceId: 'c', stepOrder: 0, delaySeconds: 0 },
        contact: CONTACT,
        cadenceName: 'x',
      }),
    ).rejects.toThrow(/既没有 template 也没有 goal/)
  })
})

describe('SendOutbox · 幂等与租约', () => {
  const outbox = (): SendOutbox => {
    db = openDb(IN_MEMORY, OUTREACH_MIGRATIONS)
    return new SendOutbox(db)
  }

  const request = (stepOrder = 0) => ({
    tenantId: 'default',
    cadenceRunId: 'run-1',
    stepOrder,
    contactId: 'c1',
    channelId: 'webchat',
    customerId: 'u1',
    content: '你好',
    scheduledAt: new Date('2026-08-21T00:00:00Z'),
  })

  it('同一 (run, step) 重复入队只有一条（幂等的最后防线）', () => {
    const box = outbox()
    const first = box.enqueue(request())
    const second = box.enqueue(request())
    expect(second.id).toBe(first.id)
  })

  it('不同 step 各自入队', () => {
    const box = outbox()
    expect(box.enqueue(request(0)).id).not.toBe(box.enqueue(request(1)).id)
  })

  it('claim 写租约，第二个 worker 领不到同一条', () => {
    const box = outbox()
    box.enqueue(request())
    const now = new Date('2026-08-21T01:00:00Z')
    expect(box.claim('w1', 10, 300, now)).toHaveLength(1)
    expect(box.claim('w2', 10, 300, now)).toHaveLength(0)
  })

  it('未到 scheduledAt 的不会被领取', () => {
    const box = outbox()
    box.enqueue({ ...request(), scheduledAt: new Date('2026-08-22T00:00:00Z') })
    expect(box.claim('w1', 10, 300, new Date('2026-08-21T00:00:00Z'))).toHaveLength(0)
  })

  it('租约过期后被回收，可再次领取', () => {
    const box = outbox()
    box.enqueue(request())
    box.claim('w1', 10, 60, new Date('2026-08-21T01:00:00Z'))
    // 租约 60 秒，两分钟后过期
    expect(box.reapExpiredLeases(new Date('2026-08-21T01:02:00Z'))).toBe(1)
    expect(box.claim('w2', 10, 300, new Date('2026-08-21T01:02:00Z'))).toHaveLength(1)
  })

  it('租约未过期时不回收（否则就是在制造重复发送）', () => {
    const box = outbox()
    box.enqueue(request())
    box.claim('w1', 10, 300, new Date('2026-08-21T01:00:00Z'))
    expect(box.reapExpiredLeases(new Date('2026-08-21T01:01:00Z'))).toBe(0)
  })

  it('markSent 后不再被领取', () => {
    const box = outbox()
    const send = box.enqueue(request())
    box.claim('w1', 10, 300, new Date('2026-08-21T01:00:00Z'))
    box.markSent(send.id)
    expect(box.claim('w2', 10, 300, new Date('2026-08-21T02:00:00Z'))).toHaveLength(0)
    expect(box.get(send.id)?.status).toBe('sent')
  })

  it('可重试失败会放回队列', () => {
    const box = outbox()
    const send = box.enqueue(request())
    box.claim('w1', 10, 300, new Date('2026-08-21T01:00:00Z'))
    box.markFailed(send.id, '网络抖动', true)
    expect(box.get(send.id)?.status).toBe('pending')
  })

  it('不可重试失败直接终态', () => {
    const box = outbox()
    const send = box.enqueue(request())
    box.claim('w1', 10, 300, new Date('2026-08-21T01:00:00Z'))
    box.markFailed(send.id, '渠道不支持主动发起', false)
    expect(box.get(send.id)?.status).toBe('failed')
  })

  it('超过重试上限后终态，不再无限占用并发槽', () => {
    const box = outbox()
    const send = box.enqueue(request())
    const now = new Date('2026-08-21T01:00:00Z')
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      box.claim('w1', 10, 300, now)
      box.markFailed(send.id, '又失败了', true)
    }
    expect(box.get(send.id)?.status).toBe('failed')
    expect(box.claim('w1', 10, 300, now)).toHaveLength(0)
  })

  it('回执记录完整的投递轨迹', () => {
    const box = outbox()
    const send = box.enqueue(request())
    box.claim('w1', 10, 300, new Date('2026-08-21T01:00:00Z'))
    box.markSent(send.id)
    expect(box.receipts(send.id).map((r) => r.eventType)).toEqual(['queued', 'sent'])
  })

  it('recentTouches 只统计成功发送的', () => {
    const box = outbox()
    const a = box.enqueue(request(0))
    box.enqueue(request(1))
    box.claim('w1', 10, 300, new Date('2026-08-21T01:00:00Z'))
    box.markSent(a.id)
    expect(box.recentTouches('c1', new Date('2026-08-20T00:00:00Z'))).toHaveLength(1)
  })

  it('countByStatus 供运维面板', () => {
    const box = outbox()
    box.enqueue(request(0))
    box.enqueue(request(1))
    expect(box.countByStatus('default')).toEqual({ pending: 2 })
  })
})
