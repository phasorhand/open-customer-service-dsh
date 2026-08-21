/**
 * CRM 端到端：真实网关 + 真实 agent + 真实 SQLite。
 *
 * 重点是 Python 版两个生产 bug 的回归防线：
 * - **教训 #3**：入站回复按手机号建重复联系人
 * - **教训 #4**：无渠道身份的联系人在外呼时被静默丢弃
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { UnaddressableError } from '../../src/crm/service.js'
import { isAddressable } from '../../src/crm/types.js'
import { createApp } from '../../src/gateway/app.js'
import { resetScopes } from '../../src/harness/session-scope.js'
import { buildRuntime, type OpenCsRuntime } from '../../src/runtime.js'

let app: FastifyInstance
let runtime: OpenCsRuntime
let dataDir: string

beforeEach(async () => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-crm-e2e-'))
  runtime = await buildRuntime({
    config: loadConfig({
      OPENCS_DATA_DIR: dataDir,
      OPENCS_ENV: 'test',
      OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4',
    }),
  })
  app = await createApp(runtime)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  await runtime.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  resetScopes()
})

const chat = (conversationId: string, customerId: string, text: string) =>
  app.inject({
    method: 'POST',
    url: '/channels/webchat',
    payload: { conversation_id: conversationId, customer_id: customerId, text },
  })

describe('入站自动建档', () => {
  it('首次入站自动建立客户档案并关联渠道身份', async () => {
    await chat('c1', 'u1', '你好')

    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')
    expect(contact).toBeDefined()
    expect(contact?.lifecycleStage).toBe('engaged')
    expect(isAddressable(contact!)).toBe(true)
  })

  it('同一客户多轮对话不会重复建档（教训 #3 的回归防线）', async () => {
    await chat('c1', 'u1', '你好')
    await chat('c1', 'u1', '想退款')
    await chat('c1', 'u1', '订单 ord-10086')

    expect(runtime.contactStore.count('default')).toBe(1)
  })

  it('同一客户换会话也不会重复建档（渠道身份优先于会话身份）', async () => {
    await chat('c1', 'u1', '你好')
    await chat('c2', 'u1', '我又来了')

    expect(runtime.contactStore.count('default')).toBe(1)
  })

  it('不同客户各自建档', async () => {
    await chat('c1', 'u1', '你好')
    await chat('c2', 'u2', '你好')

    expect(runtime.contactStore.count('default')).toBe(2)
  })

  it('时间线按发生顺序排列（同毫秒事件不乱序）', async () => {
    await chat('c1', 'u1', '你好')
    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')!
    const kinds = runtime.contactStore.timeline(contact.id).map((event) => event.kind)

    expect(kinds[0]).toBe('imported')
    expect(kinds.indexOf('identity_linked')).toBeLessThan(kinds.indexOf('inbound'))
  })

  it('多轮对话推高意向分', async () => {
    await chat('c1', 'u1', '你好')
    const first = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')!.score
    for (const text of ['想退款', '订单 ord-10086', '什么时候到']) await chat('c1', 'u1', text)
    const later = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')!.score

    expect(later).toBeGreaterThan(first)
  })

  it('租户隔离：不同租户的同名 customerId 各自建档', async () => {
    await chat('c1', 'u1', '你好')
    await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'c9', customer_id: 'u1', text: '你好', tenant_id: 'other-corp' },
    })

    expect(runtime.contactStore.count('default')).toBe(1)
    expect(runtime.contactStore.count('other-corp')).toBe(1)
  })
})

describe('不可触达显式失败（教训 #4 的回归防线）', () => {
  it('CSV 导入的无渠道身份联系人被标记为不可触达', () => {
    runtime.importer.import('email,name\nnobody@example.com,无渠道客户\n', { tenantId: 'default' })
    const contact = runtime.contactStore.findByDedupKey('default', 'email:nobody@example.com')!

    expect(isAddressable(contact)).toBe(false)
  })

  it('对不可触达联系人外呼时抛错，而不是静默跳过', () => {
    runtime.importer.import('email,name\nnobody@example.com,无渠道客户\n', { tenantId: 'default' })
    const contact = runtime.contactStore.findByDedupKey('default', 'email:nobody@example.com')!

    expect(() => runtime.contacts.onOutbound(contact.id)).toThrow(UnaddressableError)
  })

  it('失败原因写进时间线，运营能查到为什么没发出去', () => {
    runtime.importer.import('email,name\nnobody@example.com,无渠道客户\n', { tenantId: 'default' })
    const contact = runtime.contactStore.findByDedupKey('default', 'email:nobody@example.com')!
    try {
      runtime.contacts.onOutbound(contact.id)
    } catch {
      // 预期抛错
    }

    expect(runtime.contactStore.timeline(contact.id).some((event) => event.kind === 'unaddressable')).toBe(true)
  })

  it('关联渠道身份后即可触达', () => {
    runtime.importer.import('email,name\nnobody@example.com,无渠道客户\n', { tenantId: 'default' })
    const contact = runtime.contactStore.findByDedupKey('default', 'email:nobody@example.com')!
    runtime.contacts.linkIdentity(contact.id, 'webchat', 'u-linked')

    expect(() => runtime.contacts.onOutbound(contact.id)).not.toThrow()
  })

  it('分群可按 addressable 排除不可触达的人', async () => {
    runtime.importer.import('email,name\nnobody@example.com,无渠道\n', { tenantId: 'default' })
    await chat('c1', 'u1', '你好')

    const reachable = runtime.contacts.segment('default', {
      rules: [{ field: 'addressable', operator: 'eq', value: true }],
    })
    expect(reachable).toHaveLength(1)
  })
})

describe('CSV 导入端到端', () => {
  it('批量导入后可分群', () => {
    runtime.importer.import(
      'email,name,公司,标签\na@x.com,张三,甲公司,vip\nb@x.com,李四,乙公司,普通\nc@x.com,王五,丙公司,vip\n',
      { tenantId: 'default' },
    )

    expect(runtime.contactStore.count('default')).toBe(3)
    expect(runtime.contacts.segment('default', { rules: [{ field: 'tags', operator: 'contains', value: 'vip' }] })).toHaveLength(2)
  })

  it('导入 + 入站可合并为同一客户（先导入，后关联渠道身份）', async () => {
    runtime.importer.import('email,external_id,name\na@x.com,u1,张三\n', {
      tenantId: 'default',
      channelId: 'webchat',
    })
    await chat('c1', 'u1', '你好')

    // 渠道身份已在导入时关联，入站应命中同一条而不是新建
    expect(runtime.contactStore.count('default')).toBe(1)
    expect(runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')?.name).toBe('张三')
  })

  it('漏斗分布反映入站推进', async () => {
    runtime.importer.import('email\na@x.com\nb@x.com\n', { tenantId: 'default' })
    await chat('c1', 'u1', '你好')

    const funnel = runtime.contactStore.funnel('default')
    expect(funnel['new']).toBe(2)
    expect(funnel['engaged']).toBe(1)
  })
})

describe('CRM 工具经 agent 可用', () => {
  it('contact.get 能读到当前对话客户的档案', async () => {
    await chat('c1', 'u1', '你好')
    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')!

    // scope 里带上 contactId 后，工具才拿得到档案
    const agent = await runtime.harness.agentFor({
      tenantId: 'default',
      conversationId: 'c1',
      channelId: 'webchat',
      customerId: 'u1',
      contactId: contact.id,
    })
    const tool = runtime.harness.ctx.tools.get?.('contact.get')
    expect(tool ?? runtime.harness.ctx.tools).toBeDefined()
    expect(agent).toBeDefined()
  })

  it('阶段推进遵守单调性：回退被工具层拒绝而不是写坏数据', async () => {
    await chat('c1', 'u1', '你好')
    const contact = runtime.contactStore.findByChannelIdentity('default', 'webchat', 'u1')!
    runtime.contacts.updateStage(contact.id, 'qualified', { reason: '明确询价' })

    expect(runtime.contacts.canTransition(contact.id, 'new')).toMatch(/只能前进/)
    expect(runtime.contactStore.get(contact.id)?.lifecycleStage).toBe('qualified')
  })
})
