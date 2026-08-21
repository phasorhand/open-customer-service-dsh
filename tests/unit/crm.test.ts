import { afterEach, describe, expect, it } from 'vitest'

import type { InboundMessage } from '../../src/channel/types.js'
import { ContactImporter } from '../../src/crm/importer.js'
import { LifecycleError, advanceOnInbound, checkTransition } from '../../src/crm/lifecycle.js'
import { RECENCY_HALF_LIFE_DAYS, computeRecency, computeScore } from '../../src/crm/scoring.js'
import { matchesFilter, readField } from '../../src/crm/segment.js'
import { ContactService, UnaddressableError } from '../../src/crm/service.js'
import { CRM_MIGRATIONS, ContactStore } from '../../src/crm/store.js'
import { isAddressable, normalizeDedupKey, type Contact } from '../../src/crm/types.js'
import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'

let db: Db

afterEach(() => {
  db?.close()
})

function fixture(): { store: ContactStore; service: ContactService } {
  db = openDb(IN_MEMORY, CRM_MIGRATIONS)
  const store = new ContactStore(db)
  return { store, service: new ContactService(store) }
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelId: 'webchat',
    conversationId: 'c1',
    customerId: 'u1',
    senderKind: 'customer',
    content: [{ kind: 'text', text: '你好' }],
    timestamp: new Date('2026-08-21T10:00:00Z'),
    tenantId: 'default',
    ...overrides,
  }
}

describe('normalizeDedupKey · 业务身份归一', () => {
  it('邮箱大小写与空白归一', () => {
    expect(normalizeDedupKey({ email: '  Alice@Example.COM ' })).toBe('email:alice@example.com')
  })

  it('手机号去掉分隔符', () => {
    expect(normalizeDedupKey({ phone: '138-0013-8000' })).toBe('phone:13800138000')
  })

  it('+86 与本地号码归一到同一个键（否则同一个人会建两条）', () => {
    expect(normalizeDedupKey({ phone: '+86 138 0013 8000' })).toBe(normalizeDedupKey({ phone: '13800138000' }))
  })

  it('邮箱优先于手机', () => {
    expect(normalizeDedupKey({ email: 'a@b.com', phone: '13800138000' })).toBe('email:a@b.com')
  })

  it('都没有时用兜底键', () => {
    expect(normalizeDedupKey({ fallback: 'webchat:u1' })).toBe('ref:webchat:u1')
  })

  it('三者皆空抛错（不能造随机 id，否则重复导入会不断新建）', () => {
    expect(() => normalizeDedupKey({})).toThrow(/至少要有一个/)
  })
})

describe('生命周期单调性', () => {
  it('前进允许', () => {
    expect(checkTransition('new', 'qualified')).toBeUndefined()
  })

  it('同阶段幂等', () => {
    expect(checkTransition('engaged', 'engaged')).toBeUndefined()
  })

  it('回退被拒绝', () => {
    expect(checkTransition('qualified', 'new')).toMatch(/只能前进/)
  })

  it('从任意阶段进终态允许', () => {
    expect(checkTransition('new', 'disqualified')).toBeUndefined()
    expect(checkTransition('opportunity', 'customer')).toBeUndefined()
  })

  it('从终态离开被拒绝', () => {
    expect(checkTransition('customer', 'opportunity')).toMatch(/终态/)
    expect(checkTransition('churned', 'engaged')).toMatch(/终态/)
  })

  it('force 可越过全部限制（RED 风险档，需人工确认）', () => {
    expect(checkTransition('customer', 'new', true)).toBeUndefined()
  })

  it('入站只推进到 engaged，更深的阶段留给 lead_qualifier 判定', () => {
    expect(advanceOnInbound('new')).toBe('engaged')
    expect(advanceOnInbound('qualified')).toBe('qualified')
  })

  it('入站不会把终态客户拉回来', () => {
    expect(advanceOnInbound('customer')).toBe('customer')
    expect(advanceOnInbound('churned')).toBe('churned')
  })
})

describe('意向打分', () => {
  const base = { inboundCount: 0, outboundCount: 0, now: new Date('2026-08-21T00:00:00Z') } as const

  it('全新联系人分数低', () => {
    expect(computeScore({ ...base, lifecycleStage: 'new' })).toBeLessThan(30)
  })

  it('成交客户分数高', () => {
    expect(
      computeScore({ ...base, lifecycleStage: 'customer', inboundCount: 10, lastInboundAt: base.now }),
    ).toBeGreaterThan(80)
  })

  it('分数落在 0-100', () => {
    for (const stage of ['new', 'engaged', 'customer', 'churned'] as const) {
      const score = computeScore({ ...base, lifecycleStage: stage, inboundCount: 100 })
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })

  it('从未触达时回复率按中性算，不因「没回复」扣分', () => {
    const untouched = computeScore({ ...base, lifecycleStage: 'engaged', inboundCount: 1, outboundCount: 0 })
    const ignored = computeScore({ ...base, lifecycleStage: 'engaged', inboundCount: 0, outboundCount: 5 })
    expect(untouched).toBeGreaterThan(ignored)
  })

  it('终态 churned 的漏斗分归零而不是负分', () => {
    expect(computeScore({ ...base, lifecycleStage: 'churned' })).toBeGreaterThanOrEqual(0)
  })

  it('新鲜度按半衰期衰减', () => {
    const now = new Date('2026-08-21T00:00:00Z')
    const half = new Date(now.getTime() - RECENCY_HALF_LIFE_DAYS * 86_400_000)
    expect(computeRecency(now, now)).toBeCloseTo(1, 5)
    expect(computeRecency(half, now)).toBeCloseTo(0.5, 5)
    expect(computeRecency(undefined, now)).toBe(0)
  })
})

describe('分群筛选', () => {
  const contact: Contact = {
    id: 'c1',
    tenantId: 'default',
    dedupKey: 'email:a@b.com',
    name: '张三',
    lifecycleStage: 'qualified',
    leadStatus: 'replied',
    score: 72,
    tags: ['vip', '高意向'],
    attributes: { city: '上海', budget: 5000 },
    identities: [{ channelId: 'webchat', externalId: 'u1', linkedAt: new Date() }],
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('eq / ne', () => {
    expect(matchesFilter(contact, { rules: [{ field: 'lifecycle_stage', operator: 'eq', value: 'qualified' }] })).toBe(true)
    expect(matchesFilter(contact, { rules: [{ field: 'lifecycle_stage', operator: 'ne', value: 'new' }] })).toBe(true)
  })

  it('数值比较', () => {
    expect(matchesFilter(contact, { rules: [{ field: 'score', operator: 'gte', value: 70 }] })).toBe(true)
    expect(matchesFilter(contact, { rules: [{ field: 'score', operator: 'lt', value: 70 }] })).toBe(false)
  })

  it('数字与字符串宽松相等（JSON 条件常被写成字符串）', () => {
    expect(matchesFilter(contact, { rules: [{ field: 'score', operator: 'eq', value: '72' }] })).toBe(true)
  })

  it('in / contains', () => {
    expect(matchesFilter(contact, { rules: [{ field: 'lead_status', operator: 'in', value: ['replied', 'won'] }] })).toBe(true)
    expect(matchesFilter(contact, { rules: [{ field: 'tags', operator: 'contains', value: 'vip' }] })).toBe(true)
  })

  it('自定义属性可筛', () => {
    expect(matchesFilter(contact, { rules: [{ field: 'attributes.city', operator: 'eq', value: '上海' }] })).toBe(true)
    expect(matchesFilter(contact, { rules: [{ field: 'attributes.budget', operator: 'gt', value: 1000 }] })).toBe(true)
  })

  it('exists 判断属性有无', () => {
    expect(matchesFilter(contact, { rules: [{ field: 'attributes.city', operator: 'exists' }] })).toBe(true)
    expect(matchesFilter(contact, { rules: [{ field: 'attributes.missing', operator: 'exists', value: false }] })).toBe(true)
  })

  it('可触达性可筛（外呼受众必备）', () => {
    expect(readField(contact, 'addressable')).toBe(true)
    expect(matchesFilter(contact, { rules: [{ field: 'addressable', operator: 'eq', value: true }] })).toBe(true)
  })

  it('多条规则是 AND', () => {
    expect(
      matchesFilter(contact, {
        rules: [
          { field: 'score', operator: 'gte', value: 70 },
          { field: 'lifecycle_stage', operator: 'eq', value: 'new' },
        ],
      }),
    ).toBe(false)
  })

  it('contactIds 是显式并集，不受 rules 约束', () => {
    expect(
      matchesFilter(contact, {
        contactIds: ['c1'],
        rules: [{ field: 'score', operator: 'gt', value: 999 }],
      }),
    ).toBe(true)
  })

  it('空筛选命中全部', () => {
    expect(matchesFilter(contact, {})).toBe(true)
  })

  it('写错的规则不抛错，只是不命中', () => {
    expect(matchesFilter(contact, { rules: [{ field: '不存在的字段', operator: 'eq', value: 1 }] })).toBe(false)
    expect(
      matchesFilter(contact, { rules: [{ field: 'score', operator: 'unknown' as never, value: 1 }] }),
    ).toBe(false)
  })
})

describe('ContactStore · 身份三分', () => {
  it('同一渠道身份重复入站只建一条联系人', () => {
    const { service, store } = fixture()
    service.onInbound(inbound())
    service.onInbound(inbound())
    expect(store.count('default')).toBe(1)
  })

  it('同一个人在两个渠道 → 两条渠道身份可挂到同一联系人', () => {
    const { service, store } = fixture()
    const contact = service.onInbound(inbound())
    service.linkIdentity(contact.id, 'wecom_cs', 'wx-external-1')

    const viaWebchat = store.findByChannelIdentity('default', 'webchat', 'u1')
    const viaWecom = store.findByChannelIdentity('default', 'wecom_cs', 'wx-external-1')
    expect(viaWebchat?.id).toBe(viaWecom?.id)
    expect(store.count('default')).toBe(1)
  })

  it('渠道身份被另一个联系人占用时抛错，不静默覆盖', () => {
    const { service, store } = fixture()
    const first = service.onInbound(inbound())
    const second = store.upsert({ tenantId: 'default', dedupKey: 'email:b@x.com' }).contact
    expect(() => service.linkIdentity(second.id, 'webchat', 'u1')).toThrow(/已归属联系人/)
    expect(first.id).not.toBe(second.id)
  })

  it('重复关联同一身份到同一联系人是幂等的', () => {
    const { service } = fixture()
    const contact = service.onInbound(inbound())
    expect(() => service.linkIdentity(contact.id, 'webchat', 'u1')).not.toThrow()
  })

  it('upsert 的 undefined 字段表示不改动，而不是清空', () => {
    const { store } = fixture()
    store.upsert({ tenantId: 'default', dedupKey: 'email:a@b.com', name: '张三', phone: '13800138000' })
    const after = store.upsert({ tenantId: 'default', dedupKey: 'email:a@b.com', company: '示例公司' }).contact
    expect(after.name).toBe('张三')
    expect(after.phone).toBe('13800138000')
    expect(after.company).toBe('示例公司')
  })

  it('租户隔离：同一 dedupKey 在不同租户是两条记录', () => {
    const { store } = fixture()
    store.upsert({ tenantId: 'a', dedupKey: 'email:x@y.com' })
    store.upsert({ tenantId: 'b', dedupKey: 'email:x@y.com' })
    expect(store.count('a')).toBe(1)
    expect(store.count('b')).toBe(1)
  })

  it('漏斗分布可统计', () => {
    const { store } = fixture()
    store.upsert({ tenantId: 'default', dedupKey: 'e:1', lifecycleStage: 'new' })
    store.upsert({ tenantId: 'default', dedupKey: 'e:2', lifecycleStage: 'customer' })
    expect(store.funnel('default')).toEqual({ new: 1, customer: 1 })
  })
})

describe('ContactService · 入站处理', () => {
  it('首次入站建档、关联渠道身份、推进到 engaged', () => {
    const { service } = fixture()
    const contact = service.onInbound(inbound())
    expect(contact.lifecycleStage).toBe('engaged')
    expect(contact.identities).toHaveLength(1)
    expect(isAddressable(contact)).toBe(true)
  })

  it('入站后重新打分', () => {
    const { service } = fixture()
    expect(service.onInbound(inbound()).score).toBeGreaterThan(0)
  })

  it('时间线记录建档、身份关联与入站', () => {
    const { service, store } = fixture()
    const contact = service.onInbound(inbound())
    const kinds = store.timeline(contact.id).map((event) => event.kind)
    expect(kinds).toContain('imported')
    expect(kinds).toContain('identity_linked')
    expect(kinds).toContain('inbound')
  })

  it('阶段推进被记入时间线', () => {
    const { service, store } = fixture()
    const contact = service.onInbound(inbound())
    service.updateStage(contact.id, 'qualified', { reason: '客户明确询价' })
    const changes = store.timeline(contact.id).filter((event) => event.kind === 'stage_changed')
    expect(changes.at(-1)?.payload).toMatchObject({ to: 'qualified', reason: '客户明确询价' })
  })

  it('非法跃迁抛 LifecycleError', () => {
    const { service } = fixture()
    const contact = service.onInbound(inbound())
    service.updateStage(contact.id, 'qualified')
    expect(() => service.updateStage(contact.id, 'new')).toThrow(LifecycleError)
  })

  it('推进到 customer 记 converted 事件', () => {
    const { service, store } = fixture()
    const contact = service.onInbound(inbound())
    service.updateStage(contact.id, 'customer', { reason: '已付款' })
    expect(store.timeline(contact.id).some((event) => event.kind === 'converted')).toBe(true)
  })
})

describe('ContactService · 不可触达显式失败', () => {
  it('无渠道身份的联系人外呼时抛 UnaddressableError（而不是静默跳过）', () => {
    const { store, service } = fixture()
    const contact = store.upsert({ tenantId: 'default', dedupKey: 'email:nobody@x.com' }).contact
    expect(isAddressable(contact)).toBe(false)
    expect(() => service.onOutbound(contact.id)).toThrow(UnaddressableError)
  })

  it('失败会记入时间线，运营能查到为什么没发出去', () => {
    const { store, service } = fixture()
    const contact = store.upsert({ tenantId: 'default', dedupKey: 'email:nobody@x.com' }).contact
    try {
      service.onOutbound(contact.id)
    } catch {
      // 预期抛错
    }
    expect(store.timeline(contact.id).some((event) => event.kind === 'unaddressable')).toBe(true)
  })

  it('有渠道身份的联系人外呼正常', () => {
    const { service } = fixture()
    const contact = service.onInbound(inbound())
    expect(() => service.onOutbound(contact.id)).not.toThrow()
  })
})

describe('ContactImporter · CSV 导入', () => {
  it('中英文表头都能识别', () => {
    const { store } = fixture()
    const report = new ContactImporter(store).import(
      '姓名,手机,公司\n张三,13800138000,示例公司\n',
      { tenantId: 'default' },
    )
    expect(report).toMatchObject({ total: 1, imported: 1, skipped: 0 })
    expect(store.list('default')[0]).toMatchObject({ name: '张三', phone: '13800138000', company: '示例公司' })
  })

  it('引号内的逗号被正确处理（手写 split 必错的场景）', () => {
    const { store } = fixture()
    new ContactImporter(store).import('name,company,email\n李四,"示例科技, 有限公司",a@b.com\n', {
      tenantId: 'default',
    })
    expect(store.list('default')[0]?.company).toBe('示例科技, 有限公司')
  })

  it('重复导入同一文件是幂等的（不会翻倍建档）', () => {
    const { store } = fixture()
    const csv = 'email,name\na@b.com,张三\n'
    const importer = new ContactImporter(store)
    importer.import(csv, { tenantId: 'default' })
    const second = importer.import(csv, { tenantId: 'default' })
    expect(second).toMatchObject({ imported: 0, updated: 1 })
    expect(store.count('default')).toBe(1)
  })

  it('单行脏数据不中断整批，逐行报错带 1-based 原始行号', () => {
    const { store } = fixture()
    const report = new ContactImporter(store).import('email,name\na@b.com,张三\n,无身份\nc@d.com,王五\n', {
      tenantId: 'default',
    })
    expect(report).toMatchObject({ total: 3, imported: 2, skipped: 1 })
    // 第 3 行（表头 1 + 数据 2）
    expect(report.errors[0]?.line).toBe(3)
    expect(store.count('default')).toBe(2)
  })

  it('带 externalId 时自动关联渠道身份', () => {
    const { store } = fixture()
    new ContactImporter(store).import('email,external_id\na@b.com,wx-1\n', {
      tenantId: 'default',
      channelId: 'wecom_cs',
    })
    expect(store.findByChannelIdentity('default', 'wecom_cs', 'wx-1')).toBeDefined()
  })

  it('标签列按多种分隔符切分', () => {
    const { store } = fixture()
    new ContactImporter(store).import('email,标签\na@b.com,"vip;高意向，上海"\n', { tenantId: 'default' })
    expect(store.list('default')[0]?.tags).toEqual(['vip', '高意向', '上海'])
  })

  it('BOM 头不影响首列表头识别', () => {
    const { store } = fixture()
    const report = new ContactImporter(store).import('﻿email,name\na@b.com,张三\n', { tenantId: 'default' })
    expect(report.imported).toBe(1)
  })

  it('完全无法解析的内容返回错误报告而不是抛错', () => {
    const { store } = fixture()
    const report = new ContactImporter(store).import('a,b\n"未闭合引号\n', { tenantId: 'default' })
    expect(report.errors.length).toBeGreaterThan(0)
  })
})
