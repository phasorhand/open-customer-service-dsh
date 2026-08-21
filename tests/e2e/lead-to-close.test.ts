/**
 * 全自动成单旅程端到端。
 *
 * 这是整个产品的验收线（plan §P5）：
 * **导入一批联系人 → 激活节奏 → 自动触达 → 客户回复即停 → 推进到成交**，
 * 全程无人工介入。
 *
 * 同时是 Python 版四个生产 bug 的回归防线：
 * #1 身份混淆、#2 租约超时重复发送、#3 重复建档、#4 静默丢弃。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { createApp } from '../../src/gateway/app.js'
import { resetScopes } from '../../src/harness/session-scope.js'
import { buildRuntime, type OpenCsRuntime } from '../../src/runtime.js'

let app: FastifyInstance
let runtime: OpenCsRuntime
let dataDir: string
/** 被渠道真正投递出去的文案，用于断言「发了什么」。 */
let delivered: string[]
let unsubscribe: () => void

const T0 = new Date('2026-08-21T02:00:00Z') // 上海时间 10:00，非静默时段

beforeEach(async () => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-l2c-'))
  runtime = await buildRuntime({
    config: loadConfig({
      OPENCS_DATA_DIR: dataDir,
      OPENCS_ENV: 'test',
      OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4',
      OPENCS_NURTURE_DRAIN_CONCURRENCY: '8',
    }),
    // 不启动后台 tick：测试要用 nurture.tick(now) 精确控制时间推进
  })
  delivered = []
  unsubscribe = runtime.webchat.subscribe((action) => {
    delivered.push(action.content.map((part) => part.text ?? '').join(''))
  })
  app = await createApp(runtime)
  await app.ready()
})

afterEach(async () => {
  unsubscribe()
  await app.close()
  await runtime.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  resetScopes()
})

/** 导入 N 个带渠道身份的联系人。 */
function importContacts(count: number): void {
  const rows = Array.from({ length: count }, (_, i) => `u${i}@example.com,客户${i},u${i}`)
  runtime.importer.import(`email,name,external_id\n${rows.join('\n')}\n`, {
    tenantId: 'default',
    channelId: 'webchat',
  })
}

/** 创建并激活一个模板节奏（毫秒级，不调 LLM）。 */
function activateTemplateCadence(steps = 2) {
  const cadence = runtime.cadences.create({
    tenantId: 'default',
    name: '首触节奏',
    channelId: 'webchat',
    senderPersona: 'OpenCS 的客户成功顾问小林',
    autoEnroll: true,
    entryFilter: { rules: [{ field: 'addressable', operator: 'eq', value: true }] },
    exitOnReply: true,
    exitOnStage: 'customer',
    quietHoursStart: 0,
    quietHoursEnd: 0, // 测试里关掉静默时段
    timezone: 'Asia/Shanghai',
    maxTouchesPerWeek: 10,
    steps: Array.from({ length: steps }, (_, i) => ({
      stepOrder: i,
      delaySeconds: i === 0 ? 0 : 3600,
      template: `{{name}}你好，这是第 ${i + 1} 次跟进。`,
    })),
  })
  runtime.cadences.setStatus(cadence.id, 'active')
  return runtime.cadences.require(cadence.id)
}

const chat = (conversationId: string, customerId: string, text: string) =>
  app.inject({
    method: 'POST',
    url: '/channels/webchat',
    payload: { conversation_id: conversationId, customer_id: customerId, text },
  })

describe('全自动旅程：导入 → 节奏 → 触达', () => {
  it('激活后自动入组全部可触达联系人', async () => {
    importContacts(5)
    const cadence = activateTemplateCadence()

    const report = await runtime.nurture.tick(T0)
    expect(report.enrolled).toBe(5)
    expect(runtime.cadences.listActiveRuns('default')).toHaveLength(5)
    expect(cadence.status).toBe('active')
  })

  it('一次 tick 完成物化与投递，无人工介入', async () => {
    importContacts(5)
    activateTemplateCadence()

    const report = await runtime.nurture.tick(T0)
    expect(report.materialized).toBe(5)
    expect(report.sent).toBe(5)
    expect(delivered).toHaveLength(5)
  })

  it('文案带上了个性化字段，且不含未替换的占位符', async () => {
    importContacts(3)
    activateTemplateCadence()
    await runtime.nurture.tick(T0)

    expect(delivered.every((text) => text.includes('你好'))).toBe(true)
    expect(delivered.some((text) => text.includes('客户0'))).toBe(true)
    expect(delivered.every((text) => !text.includes('{{'))).toBe(true)
  })

  it('重复 tick 不会重复发送（幂等的最后防线）', async () => {
    importContacts(5)
    activateTemplateCadence()
    await runtime.nurture.tick(T0)
    const afterFirst = delivered.length

    // 同一时刻再 tick 一次：第 2 步还没到期，不该有新投递
    await runtime.nurture.tick(T0)
    expect(delivered).toHaveLength(afterFirst)
  })

  it('到期后推进到第二步', async () => {
    importContacts(2)
    activateTemplateCadence(2)
    await runtime.nurture.tick(T0)
    expect(delivered).toHaveLength(2)

    // 第二步 delay 3600 秒
    await runtime.nurture.tick(new Date(T0.getTime() + 3601 * 1000))
    expect(delivered).toHaveLength(4)
    expect(delivered.some((text) => text.includes('第 2 次跟进'))).toBe(true)
  })

  it('走完全部步骤后运行结束，原因为 completed', async () => {
    importContacts(1)
    activateTemplateCadence(1)
    await runtime.nurture.tick(T0)
    await runtime.nurture.tick(new Date(T0.getTime() + 7200 * 1000))

    const stats = runtime.cadences.runStats('default')
    expect(stats.byFinishReason['completed']).toBe(1)
  })
})

describe('回复即停（不骚扰已在对话的客户）', () => {
  it('客户回复后节奏立即退出', async () => {
    importContacts(2)
    activateTemplateCadence(3)
    await runtime.nurture.tick(T0)
    // 只数节奏消息——`delivered` 里也会有客服 agent 对客户的即时回复
    const nurtureTouches = () => delivered.filter((text) => text.includes('次跟进'))
    expect(nurtureTouches()).toHaveLength(2)

    // u0 回复
    await chat('conv-u0', 'u0', '我想了解一下')

    await runtime.nurture.tick(new Date(T0.getTime() + 3601 * 1000))
    const stats = runtime.cadences.runStats('default')
    expect(stats.byFinishReason['replied']).toBe(1)

    // u0 不再被节奏触达，第二步只有 u1 收到
    expect(nurtureTouches().filter((text) => text.includes('第 2 次跟进'))).toHaveLength(1)
  })

  it('到达 exitOnStage 后退出', async () => {
    importContacts(1)
    activateTemplateCadence(3)
    await runtime.nurture.tick(T0)

    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u0')!
    runtime.contacts.updateStage(contact.id, 'customer', { reason: '已成交' })

    await runtime.nurture.tick(new Date(T0.getTime() + 3601 * 1000))
    expect(runtime.cadences.runStats('default').byFinishReason['stage_exit']).toBe(1)
  })

  it('退订的客户退出节奏', async () => {
    importContacts(1)
    activateTemplateCadence(3)
    await runtime.nurture.tick(T0)

    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u0')!
    runtime.contactStore.updateStage(contact.id, contact.lifecycleStage, 'opted_out')

    await runtime.nurture.tick(new Date(T0.getTime() + 3601 * 1000))
    expect(runtime.cadences.runStats('default').byFinishReason['opted_out']).toBe(1)
  })
})

describe('不打扰规则', () => {
  it('静默时段推迟投递而不是发出去', async () => {
    importContacts(2)
    const cadence = runtime.cadences.create({
      tenantId: 'default',
      name: '夜间测试',
      channelId: 'webchat',
      autoEnroll: true,
      entryFilter: { rules: [{ field: 'addressable', operator: 'eq', value: true }] },
      quietHoursStart: 22,
      quietHoursEnd: 9,
      timezone: 'Asia/Shanghai',
      steps: [{ stepOrder: 0, delaySeconds: 0, template: '你好' }],
    })
    runtime.cadences.setStatus(cadence.id, 'active')

    // 上海时间 02:00，处于静默时段
    const report = await runtime.nurture.tick(new Date('2026-08-21T18:00:00Z'))
    expect(report.deferred).toBe(2)
    expect(report.sent).toBe(0)
    expect(delivered).toHaveLength(0)
  })

  it('周频控超限时推迟', async () => {
    importContacts(1)
    const cadence = runtime.cadences.create({
      tenantId: 'default',
      name: '频控测试',
      channelId: 'webchat',
      autoEnroll: true,
      entryFilter: { rules: [{ field: 'addressable', operator: 'eq', value: true }] },
      quietHoursStart: 0,
      quietHoursEnd: 0,
      maxTouchesPerWeek: 1,
      steps: [
        { stepOrder: 0, delaySeconds: 0, template: '第一次' },
        { stepOrder: 1, delaySeconds: 60, template: '第二次' },
      ],
    })
    runtime.cadences.setStatus(cadence.id, 'active')

    await runtime.nurture.tick(T0)
    expect(delivered).toHaveLength(1)

    // 第二步到期，但本周已触达 1 次，达到上限
    const report = await runtime.nurture.tick(new Date(T0.getTime() + 61 * 1000))
    expect(report.deferred).toBe(1)
    expect(delivered).toHaveLength(1)
  })
})

describe('不可触达显式失败（教训 #4）', () => {
  it('无渠道身份的联系人不会被自动入组', async () => {
    runtime.importer.import('email,name\nnobody@example.com,无渠道\n', { tenantId: 'default' })
    activateTemplateCadence()

    const report = await runtime.nurture.tick(T0)
    expect(report.enrolled).toBe(0)
  })

  it('入组后失去渠道身份的运行以 unaddressable 结束，不是静默跳过', async () => {
    importContacts(1)
    const cadence = activateTemplateCadence()
    await runtime.nurture.tick(T0)

    // 直接建一个无渠道身份的联系人并手动入组，模拟数据异常
    const orphan = runtime.contactStore.upsert({ tenantId: 'default', dedupKey: 'email:orphan@x.com' }).contact
    runtime.cadences.enroll(cadence, orphan.id, T0)

    await runtime.nurture.tick(new Date(T0.getTime() + 1000))
    expect(runtime.cadences.runStats('default').byFinishReason['unaddressable']).toBe(1)
  })
})

describe('租约与重复发送（教训 #2）', () => {
  it('租约生效时第二个 worker 领不到同一条', async () => {
    importContacts(3)
    activateTemplateCadence()
    await runtime.nurture.tick(T0)

    // 全部已投递，队列应为空
    expect(runtime.outbox.claim('other-worker', 10, 300, T0)).toHaveLength(0)
  })

  it('并发 drain 下每条消息只发一次', async () => {
    importContacts(20)
    activateTemplateCadence(1)

    await runtime.nurture.tick(T0)
    expect(delivered).toHaveLength(20)
    // 去重后仍是 20 条 —— 没有任何一条被发两次
    expect(new Set(delivered).size).toBe(20)
  })

  it('发件箱状态统计可用于运维面板', async () => {
    importContacts(3)
    activateTemplateCadence()
    await runtime.nurture.tick(T0)

    expect(runtime.outbox.countByStatus('default')).toMatchObject({ sent: 3 })
  })
})

describe('身份边界（教训 #1）', () => {
  it('离线组稿不会自称是客户的公司', async () => {
    runtime.importer.import('email,name,公司,external_id\na@x.com,张三,晨光电商,u-a\n', {
      tenantId: 'default',
      channelId: 'webchat',
    })
    const cadence = runtime.cadences.create({
      tenantId: 'default',
      name: 'LLM 组稿测试',
      channelId: 'webchat',
      senderPersona: 'OpenCS 的客户成功顾问小林',
      autoEnroll: true,
      entryFilter: { rules: [{ field: 'addressable', operator: 'eq', value: true }] },
      quietHoursStart: 0,
      quietHoursEnd: 0,
      steps: [{ stepOrder: 0, delaySeconds: 0, goal: '邀约体验产品' }],
    })
    runtime.cadences.setStatus(cadence.id, 'active')

    await runtime.nurture.tick(T0)
    expect(delivered).toHaveLength(1)
    // 绝不能自称「我是晨光电商的…」——那是客户的公司
    expect(delivered[0]).not.toMatch(/我是晨光电商/)
    expect(delivered[0]).toContain('OpenCS')
  })
})

describe('触达计入客户档案', () => {
  it('投递后 last_outbound_at 与外呼计数更新', async () => {
    importContacts(1)
    activateTemplateCadence(1)
    await runtime.nurture.tick(T0)

    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u0')!
    expect(contact.lastOutboundAt).toBeDefined()
    expect(runtime.contactStore.counters(contact.id).outboundCount).toBe(1)
  })

  it('触达后客户回复 → 阶段推进 → 可标记成交（完整成单闭环）', async () => {
    importContacts(1)
    activateTemplateCadence(2)
    await runtime.nurture.tick(T0)

    await chat('conv-u0', 'u0', '我想买，怎么下单？')
    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u0')!
    expect(contact.lifecycleStage).toBe('engaged')

    runtime.contacts.updateStage(contact.id, 'opportunity', { reason: '明确购买意向' })
    const closed = runtime.contacts.updateStage(contact.id, 'customer', { reason: '已付款' })

    expect(closed.lifecycleStage).toBe('customer')
    expect(closed.convertedAt).toBeDefined()
    expect(runtime.contactStore.timeline(contact.id).some((event) => event.kind === 'converted')).toBe(true)
  })
})
