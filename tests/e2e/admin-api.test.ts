/**
 * 管理 API 端到端。
 *
 * 覆盖运营的完整工作流：导入名单 → 圈受众 → 建节奏 → 激活 → 看统计。
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

const T = 'default'

beforeEach(async () => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-admin-'))
  runtime = await buildRuntime({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' }),
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

const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload }) })

const CSV = 'email,name,external_id\na@x.com,张三,u-a\nb@x.com,李四,u-b\nc@x.com,王五,\n'

const validCadence = {
  name: '首触节奏',
  channel_id: 'webchat',
  sender_persona: 'OpenCS 的小林',
  auto_enroll: true,
  entry_filter: { rules: [{ field: 'addressable', operator: 'eq', value: true }] },
  steps: [
    { step_order: 0, delay_seconds: 0, template: '{{name}}你好' },
    { step_order: 1, delay_seconds: 3600, goal: '邀约体验' },
  ],
}

describe('联系人管理 API', () => {
  it('CSV 导入返回逐行报告', async () => {
    const response = await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ total: 3, imported: 3, skipped: 0 })
  })

  it('列表分页', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const body = (await get(`/admin/tenants/${T}/contacts?limit=2`)).json() as { total: number; items: unknown[] }
    expect(body.total).toBe(3)
    expect(body.items).toHaveLength(2)
  })

  it('分页参数越界被 schema 拒绝', async () => {
    expect((await get(`/admin/tenants/${T}/contacts?limit=99999`)).statusCode).toBe(400)
  })

  it('漏斗分布', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const body = (await get(`/admin/tenants/${T}/contacts/funnel`)).json() as { funnel: Record<string, number> }
    expect(body.funnel['new']).toBe(3)
  })

  it('详情含时间线', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const id = runtime.contactStore.list(T)[0]!.id
    const body = (await get(`/admin/tenants/${T}/contacts/${id}`)).json() as { timeline: unknown[] }
    expect(body.timeline.length).toBeGreaterThan(0)
  })

  it('不存在的联系人返回 404', async () => {
    expect((await get(`/admin/tenants/${T}/contacts/does-not-exist`)).statusCode).toBe(404)
  })

  it('受众预览区分可触达与不可触达', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    const body = (await post(`/admin/tenants/${T}/contacts/segment-preview`, {})).json() as {
      total: number
      addressable: number
    }
    // 三条里两条带 external_id，第三条没有 → 不可触达
    expect(body).toMatchObject({ total: 3, addressable: 2 })
  })

  it('关联渠道身份', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const id = runtime.contactStore.findByDedupKey(T, 'email:c@x.com')!.id
    const response = await post(`/admin/tenants/${T}/contacts/${id}/link-identity`, {
      channel_id: 'webchat',
      external_id: 'u-c',
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { contact: { addressable: boolean } }).contact.addressable).toBe(true)
  })

  it('身份冲突返回 409 而不是 500（需要人工合并）', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    const other = runtime.contactStore.findByDedupKey(T, 'email:c@x.com')!.id
    const response = await post(`/admin/tenants/${T}/contacts/${other}/link-identity`, {
      channel_id: 'webchat',
      external_id: 'u-a',
    })
    expect(response.statusCode).toBe(409)
  })

  it('阶段推进', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const id = runtime.contactStore.list(T)[0]!.id
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${T}/contacts/${id}/stage`,
      payload: { stage: 'qualified', reason: '明确询价' },
    })
    expect((response.json() as { contact: { lifecycle_stage: string } }).contact.lifecycle_stage).toBe('qualified')
  })

  it('阶段回退返回 422（预期内的业务拒绝，不是服务错误）', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const id = runtime.contactStore.list(T)[0]!.id
    await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${T}/contacts/${id}/stage`,
      payload: { stage: 'qualified' },
    })
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${T}/contacts/${id}/stage`,
      payload: { stage: 'new' },
    })
    expect(response.statusCode).toBe(422)
    expect((response.json() as { message: string }).message).toMatch(/只能前进/)
  })

  it('force 可越过单调性限制', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const id = runtime.contactStore.list(T)[0]!.id
    await app.inject({ method: 'PATCH', url: `/admin/tenants/${T}/contacts/${id}/stage`, payload: { stage: 'customer' } })
    const forced = await app.inject({
      method: 'PATCH',
      url: `/admin/tenants/${T}/contacts/${id}/stage`,
      payload: { stage: 'engaged', force: true },
    })
    expect(forced.statusCode).toBe(200)
  })
})

describe('节奏管理 API', () => {
  it('创建返回 201 并默认 draft 状态', async () => {
    const response = await post(`/admin/tenants/${T}/cadences`, validCadence)
    expect(response.statusCode).toBe(201)
    expect((response.json() as { cadence: { status: string } }).cadence.status).toBe('draft')
  })

  it('步骤模式被标注出来，运营能看出哪步会调 LLM', async () => {
    const body = (await post(`/admin/tenants/${T}/cadences`, validCadence)).json() as {
      cadence: { steps: { mode: string }[] }
    }
    expect(body.cadence.steps.map((step) => step.mode)).toEqual(['template', 'llm'])
  })

  it('既无 template 又无 goal 的步骤在创建时就被拒绝（而不是物化时才炸）', async () => {
    const response = await post(`/admin/tenants/${T}/cadences`, {
      ...validCadence,
      steps: [{ step_order: 0, delay_seconds: 0 }],
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: string }).error).toBe('invalid_step')
  })

  it('缺必填字段返回 400', async () => {
    expect((await post(`/admin/tenants/${T}/cadences`, { name: '缺渠道' })).statusCode).toBe(400)
  })

  it('激活与暂停', async () => {
    const id = ((await post(`/admin/tenants/${T}/cadences`, validCadence)).json() as { cadence: { id: string } }).cadence.id

    const activated = await post(`/admin/tenants/${T}/cadences/${id}/activate`)
    expect((activated.json() as { cadence: { status: string } }).cadence.status).toBe('active')

    const paused = await post(`/admin/tenants/${T}/cadences/${id}/pause`)
    expect((paused.json() as { cadence: { status: string } }).cadence.status).toBe('paused')
  })

  it('不存在的节奏返回 404', async () => {
    expect((await post(`/admin/tenants/${T}/cadences/nope/activate`)).statusCode).toBe(404)
  })

  it('手动入组显式报告不可触达的人（不静默跳过）', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    const id = ((await post(`/admin/tenants/${T}/cadences`, validCadence)).json() as { cadence: { id: string } }).cadence.id
    await post(`/admin/tenants/${T}/cadences/${id}/activate`)

    const all = runtime.contactStore.list(T).map((contact) => contact.id)
    const body = (await post(`/admin/tenants/${T}/cadences/${id}/enroll`, { contact_ids: all })).json() as {
      enrolled: number
      unaddressable: string[]
    }
    expect(body.enrolled).toBe(2)
    expect(body.unaddressable).toHaveLength(1)
  })

  it('重复入组不会重复触达', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    const id = ((await post(`/admin/tenants/${T}/cadences`, validCadence)).json() as { cadence: { id: string } }).cadence.id
    await post(`/admin/tenants/${T}/cadences/${id}/activate`)
    const targets = runtime.contactStore.list(T).map((contact) => contact.id)

    await post(`/admin/tenants/${T}/cadences/${id}/enroll`, { contact_ids: targets })
    const second = (await post(`/admin/tenants/${T}/cadences/${id}/enroll`, { contact_ids: targets })).json() as {
      enrolled: number
      already_enrolled: number
    }
    expect(second.enrolled).toBe(0)
    expect(second.already_enrolled).toBe(2)
  })

  it('运营可手动触发 tick 立即看到效果', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    const id = ((await post(`/admin/tenants/${T}/cadences`, validCadence)).json() as { cadence: { id: string } }).cadence.id
    await post(`/admin/tenants/${T}/cadences/${id}/activate`)

    const body = (await post(`/admin/tenants/${T}/cadences/tick`)).json() as { report: { enrolled: number; sent: number } }
    expect(body.report.enrolled).toBe(2)
    expect(body.report.sent).toBe(2)
  })

  it('统计反映运行与发件状态', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV, channel_id: 'webchat' })
    const id = ((await post(`/admin/tenants/${T}/cadences`, validCadence)).json() as { cadence: { id: string } }).cadence.id
    await post(`/admin/tenants/${T}/cadences/${id}/activate`)
    await post(`/admin/tenants/${T}/cadences/tick`)

    const body = (await get(`/admin/tenants/${T}/cadences/stats`)).json() as {
      runs: { byState: Record<string, number> }
      sends: Record<string, number>
    }
    expect(body.runs.byState['active']).toBe(2)
    expect(body.sends['sent']).toBe(2)
  })
})

describe('通用管理 API', () => {
  it('知识库检索', async () => {
    const body = (await get('/admin/knowledge/search?q=退款')).json() as { total: number }
    expect(body.total).toBeGreaterThan(0)
  })

  it('知识库缺 q 返回 400', async () => {
    expect((await get('/admin/knowledge/search')).statusCode).toBe(400)
  })

  it('知识库源文件列表与状态', async () => {
    const body = (await get('/admin/knowledge/sources')).json() as { status: { sourceFileCount: number } }
    expect(body.status.sourceFileCount).toBeGreaterThan(0)
  })

  it('技能列表含路由语义', async () => {
    const body = (await get('/admin/skills')).json() as {
      items: { name: string; priority: number; intent_signals: string[] }[]
    }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0]?.priority).toBeTypeOf('number')
  })

  it('技能详情', async () => {
    const list = (await get('/admin/skills')).json() as { items: { name: string }[] }
    const name = list.items[0]!.name
    const body = (await get(`/admin/skills/${name}`)).json() as { skill: { content: string } }
    expect(body.skill.content.length).toBeGreaterThan(0)
  })

  it('不存在的技能返回 404', async () => {
    expect((await get('/admin/skills/does-not-exist')).statusCode).toBe(404)
  })

  it('审计日志记录风险裁决', async () => {
    await post('/channels/webchat', { conversation_id: 'a1', customer_id: 'u1', text: '想退款' })
    const body = (await get('/admin/audit-log')).json() as { items: { tool: string; decision: string }[] }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every((entry) => ['allow', 'ask', 'deny'].includes(entry.decision))).toBe(true)
  })

  it('审计日志可按决策过滤', async () => {
    await post('/channels/webchat', { conversation_id: 'a2', customer_id: 'u2', text: '想退款' })
    const body = (await get('/admin/audit-log?decision=allow')).json() as { items: { decision: string }[] }
    expect(body.items.every((entry) => entry.decision === 'allow')).toBe(true)
  })

  it('会话回放返回与实时一致的帧（dsh 原生能力）', async () => {
    const live = (await post('/channels/webchat', {
      conversation_id: 'r1',
      customer_id: 'u1',
      text: '想退款',
    })).json() as { frames: unknown[] }

    const replay = (await get('/admin/sessions/r1/events')).json() as { frames: unknown[] }
    expect(replay.frames.length).toBeGreaterThanOrEqual(live.frames.length)
  })

  it('总览统计', async () => {
    await post(`/admin/tenants/${T}/contacts/import`, { csv: CSV })
    const body = (await get('/admin/stats')).json() as {
      contacts: { total: number }
      llm: { provider: string }
    }
    expect(body.contacts.total).toBe(3)
    expect(body.llm.provider).toBe('opencs-mock')
  })
})
