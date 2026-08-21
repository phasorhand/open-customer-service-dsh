/**
 * P8 端到端：管理面鉴权 + webhook 频控 + HITL 审批闭环。
 *
 * 审批闭环是产品的核心卖点验证：**默认安全档位下，回复不是消失而是进队列**，
 * 运营批准后客户真的收到——批准的就是看到的那句话。
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

const ADMIN_TOKEN = 'test-admin-token-16b'

let app: FastifyInstance
let runtime: OpenCsRuntime
let dataDir: string

async function boot(env: NodeJS.ProcessEnv = {}): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-sec-'))
  runtime = await buildRuntime({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...env }),
  })
  app = await createApp(runtime)
  await app.ready()
}

beforeEach(() => resetScopes())

afterEach(async () => {
  await app?.close()
  await runtime?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  resetScopes()
})

describe('管理面鉴权', () => {
  it('配置 token 后，无凭证访问管理 API 一律 401', async () => {
    await boot({ OPENCS_ADMIN_TOKEN: ADMIN_TOKEN })
    for (const url of ['/admin/stats', '/admin/proposals', '/admin/approvals', '/admin/audit-log']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
  })

  it('错误 token 401（含长度不同的 token，恒定时间比较不短路）', async () => {
    await boot({ OPENCS_ADMIN_TOKEN: ADMIN_TOKEN })
    for (const bad of ['wrong-token-16bytes!', 'short', `${ADMIN_TOKEN}-suffix`]) {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/stats',
        headers: { authorization: `Bearer ${bad}` },
      })
      expect(response.statusCode).toBe(401)
    }
  })

  it('正确 token 放行', async () => {
    await boot({ OPENCS_ADMIN_TOKEN: ADMIN_TOKEN })
    const response = await app.inject({
      method: 'GET',
      url: '/admin/stats',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(response.statusCode).toBe(200)
  })

  it('健康检查不需要 token（探针没有带凭证的能力）', async () => {
    await boot({ OPENCS_ADMIN_TOKEN: ADMIN_TOKEN })
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200)
  })

  it('渠道 webhook 不需要 token（客户触点，鉴权在渠道协议层）', async () => {
    await boot({ OPENCS_ADMIN_TOKEN: ADMIN_TOKEN, OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' })
    const response = await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'c1', customer_id: 'u1', text: '你好' },
    })
    expect(response.statusCode).toBe(200)
  })

  it('未配置 token（本地开发）时管理 API 开放', async () => {
    await boot()
    expect((await app.inject({ method: 'GET', url: '/admin/stats' })).statusCode).toBe(200)
  })
})

describe('webhook 频控', () => {
  it('同一会话超过每分钟上限返回 429 + retry-after', async () => {
    await boot({ OPENCS_WEBHOOK_RATE_LIMIT: '3', OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' })
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/channels/webchat',
        payload: { conversation_id: 'flood', customer_id: 'u1', text: '刷' },
      })
    for (let i = 0; i < 3; i += 1) expect((await send()).statusCode).toBe(200)
    const blocked = await send()
    expect(blocked.statusCode).toBe(429)
    expect(blocked.headers['retry-after']).toBeDefined()
  })

  it('不同会话各自计数', async () => {
    await boot({ OPENCS_WEBHOOK_RATE_LIMIT: '1', OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' })
    const send = (conversation: string) =>
      app.inject({
        method: 'POST',
        url: '/channels/webchat',
        payload: { conversation_id: conversation, customer_id: 'u1', text: '你好' },
      })
    expect((await send('a')).statusCode).toBe(200)
    expect((await send('b')).statusCode).toBe(200)
    expect((await send('a')).statusCode).toBe(429)
  })
})

describe('HITL 审批闭环（默认安全档位可用性）', () => {
  const chat = (text: string, conversation = 'appr-1') =>
    app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: conversation, customer_id: 'u-appr', text },
    })

  it('默认档位下回复进审批队列，而不是无声消失', async () => {
    await boot() // 默认 0,1,2,3 —— channel.reply(4) 需人工
    const response = await chat('想退款还来得及吗')
    const body = response.json() as { delivered: boolean; agent_narration: string }
    expect(body.delivered).toBe(false)

    const pending = runtime.approvals.list('default', 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.tool).toBe('channel.reply')
    // preview 就是将要发出的正文，内容来自知识库
    expect(pending[0]?.preview).toMatch(/7\s*天/)
    // 模型的叙述提到了「已生成待批草稿」——它知道话没发出去
    expect(body.agent_narration).toMatch(/人工确认/)
  })

  it('模型重试同一句话不会在队列里堆重复待办', async () => {
    await boot()
    await chat('想退款还来得及吗', 'appr-dedup')
    await chat('想退款还来得及吗', 'appr-dedup')
    const pending = runtime.approvals
      .list('default', 'pending')
      .filter((item) => item.conversationId === 'appr-dedup')
    expect(pending).toHaveLength(1)
  })

  it('批准后客户真的收到——批准的就是 preview 那句话', async () => {
    await boot()
    const delivered: string[] = []
    const unsubscribe = runtime.webchat.subscribe((action) => {
      delivered.push(action.content.map((part) => part.text ?? '').join(''))
    })

    await chat('想退款还来得及吗')
    const item = runtime.approvals.list('default', 'pending')[0]!

    const response = await app.inject({
      method: 'POST',
      url: `/admin/approvals/${item.id}/approve`,
      payload: { reviewer: 'alice', note: '内容属实' },
    })
    unsubscribe()

    expect(response.statusCode).toBe(200)
    expect((response.json() as { item: { status: string } }).item.status).toBe('delivered')
    expect(delivered.join('')).toBe(item.preview)
  })

  it('驳回后不投递', async () => {
    await boot()
    const delivered: string[] = []
    const unsubscribe = runtime.webchat.subscribe((action) => {
      delivered.push(action.content.map((part) => part.text ?? '').join(''))
    })

    await chat('想退款还来得及吗', 'appr-reject')
    const item = runtime.approvals.list('default', 'pending').find((entry) => entry.conversationId === 'appr-reject')!
    const response = await app.inject({
      method: 'POST',
      url: `/admin/approvals/${item.id}/reject`,
      payload: { reviewer: 'alice', note: '措辞需要调整' },
    })
    unsubscribe()

    expect(response.statusCode).toBe(200)
    expect(delivered).toHaveLength(0)
    expect(runtime.approvals.get(item.id)?.status).toBe('rejected')
  })

  it('并发批准两次只有一次生效（原子认领）', async () => {
    await boot()
    await chat('想退款还来得及吗', 'appr-race')
    const item = runtime.approvals.list('default', 'pending')[0]!

    const approve = () =>
      app.inject({ method: 'POST', url: `/admin/approvals/${item.id}/approve`, payload: { reviewer: 'alice' } })
    const [first, second] = await Promise.all([approve(), approve()])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 409])
  })

  it('已决的审批项不能再批（409 而不是重复投递）', async () => {
    await boot()
    await chat('想退款还来得及吗', 'appr-twice')
    const item = runtime.approvals.list('default', 'pending')[0]!
    await app.inject({ method: 'POST', url: `/admin/approvals/${item.id}/approve`, payload: { reviewer: 'alice' } })
    const again = await app.inject({
      method: 'POST',
      url: `/admin/approvals/${item.id}/approve`,
      payload: { reviewer: 'bob' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('不存在的审批项 404', async () => {
    await boot()
    const response = await app.inject({
      method: 'POST',
      url: '/admin/approvals/nope/approve',
      payload: { reviewer: 'alice' },
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('持久化审计', () => {
  it('裁决落库且跨 runtime 实例可查（重启不丢）', async () => {
    await boot({ OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' })
    await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'audit-1', customer_id: 'u1', text: '想退款' },
    })
    expect(runtime.audit.count()).toBeGreaterThan(0)

    // 模拟重启：关掉当前 runtime，用同一 dataDir 重建
    await app.close()
    await runtime.dispose()
    resetScopes()
    const config = loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test' })
    runtime = await buildRuntime({ config })
    app = await createApp(runtime)
    await app.ready()

    expect(runtime.audit.count()).toBeGreaterThan(0)
  })

  it('审计接口支持分页与过滤', async () => {
    await boot({ OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' })
    await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'audit-2', customer_id: 'u1', text: '想退款' },
    })
    const body = (await app.inject({ method: 'GET', url: '/admin/audit-log?decision=allow&limit=5' })).json() as {
      total: number
      items: { decision: string }[]
    }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.every((entry) => entry.decision === 'allow')).toBe(true)
  })
})
