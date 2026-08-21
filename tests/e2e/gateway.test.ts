/**
 * 网关端到端：真实 Fastify 应用 + 真实 runtime 对象图。
 *
 * 用 `app.inject()` 打真实路由（不起 TCP 监听），因此测的是完整的
 * 路由 → 渠道解析 → 调度 → agent loop → guard → 工具 → 帧投影 链路。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { createApp } from '../../src/gateway/app.js'
import type { Frame } from '../../src/gateway/frames.js'
import { buildRuntime, type OpenCsRuntime } from '../../src/runtime.js'
import { resetScopes } from '../../src/harness/session-scope.js'

let app: FastifyInstance
let runtime: OpenCsRuntime
let dataDir: string

beforeEach(async () => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-e2e-'))
  runtime = await buildRuntime({
    config: loadConfig({
      OPENCS_DATA_DIR: dataDir,
      OPENCS_ENV: 'test',
      // 放开到 ORANGE_C，让端到端能观察到「回复真的发出去了」
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

describe('健康检查', () => {
  it('/health/live 永远 200 且不触碰依赖', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('/health/ready 报告组件状态', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ready: boolean; degraded: boolean; components: Record<string, { ok: boolean }> }
    expect(body.ready).toBe(true)
    expect(body.components['channels']?.ok).toBe(true)
  })

  it('使用 mock 模型时标记为 degraded，让运维看得见', async () => {
    const body = (await app.inject({ method: 'GET', url: '/health/ready' })).json() as { degraded: boolean }
    expect(body.degraded).toBe(true)
  })

  it('旧路径 /health 仍可用并标注 deprecated', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { deprecated?: string }).deprecated).toBeTypeOf('string')
  })
})

describe('POST /channels/webchat', () => {
  const post = (body: Record<string, unknown>, url = '/channels/webchat') =>
    app.inject({ method: 'POST', url, payload: body })

  it('入站消息得到回复', async () => {
    const response = await post({ conversation_id: 'c1', customer_id: 'u1', text: '想退款还来得及吗' })
    expect(response.statusCode).toBe(200)

    const body = response.json() as { conversation_id: string; reply: string; frames: Frame[] }
    expect(body.conversation_id).toBe('c1')
    expect(body.reply).not.toBe('')
  })

  it('返回可直接渲染的帧序列', async () => {
    const body = (await post({ conversation_id: 'c2', customer_id: 'u2', text: '想退款还来得及吗' })).json() as {
      frames: Frame[]
    }
    const types = new Set(body.frames.map((f) => f.type))
    expect(types.has('text/delta')).toBe(true)
    expect(types.has('tool/status')).toBe(true)
    expect(types.has('card/open')).toBe(true)
    expect(types.has('card/item')).toBe(true)
    expect(types.has('card/close')).toBe(true)
  })

  it('card/close 之前不下发 actions（动作在此之前应置灰）', async () => {
    const body = (await post({ conversation_id: 'c3', customer_id: 'u3', text: '想退款还来得及吗' })).json() as {
      frames: Frame[]
    }
    for (const frame of body.frames) {
      if (frame.type === 'card/open') expect(frame).not.toHaveProperty('actions')
      if (frame.type === 'card/close') expect(Array.isArray(frame.actions)).toBe(true)
    }
  })

  it('reply 字段是发给客户的话，内容来自知识库', async () => {
    const body = (await post({ conversation_id: 'c4', customer_id: 'u4', text: '想退款还来得及吗' })).json() as {
      reply: string
      delivered: boolean
      agent_narration: string
    }
    expect(body.delivered).toBe(true)
    expect(body.reply).toMatch(/7\s*天/)
    // agent_narration 是模型的内部叙述，与对客户说的话是两回事
    expect(body.agent_narration).not.toBe(body.reply)
  })

  it('在线 WS 订阅者能实时收到同一条出站消息', async () => {
    const seen: string[] = []
    const unsubscribe = runtime.webchat.subscribe((action) => {
      seen.push(action.content.map((part) => part.text ?? '').join(''))
    })
    await post({ conversation_id: 'c5', customer_id: 'u5', text: '想退款还来得及吗' })
    unsubscribe()
    expect(seen.join('')).toMatch(/7\s*天/)
  })

  it('tool/status done 帧带得出工具名（靠 callId 关联）', async () => {
    const body = (await post({ conversation_id: 'c8', customer_id: 'u8', text: '想退款还来得及吗' })).json() as {
      frames: Frame[]
    }
    const done = body.frames.filter((f) => f.type === 'tool/status' && f.status === 'done')
    expect(done.length).toBeGreaterThan(0)
    expect(done.every((f) => (f as { tool: string }).tool !== '')).toBe(true)
  })

  it('同一会话的并发请求被串行处理，事件区间不重叠', async () => {
    const [a, b] = await Promise.all([
      post({ conversation_id: 'c6', customer_id: 'u6', text: '想退款还来得及吗' }),
      post({ conversation_id: 'c6', customer_id: 'u6', text: '订单 ord-10086 到哪了' }),
    ])
    const first = (a.json() as { trace: { from_seq: number; to_seq: number } }).trace
    const second = (b.json() as { trace: { from_seq: number; to_seq: number } }).trace
    const [earlier, later] = first.from_seq <= second.from_seq ? [first, second] : [second, first]
    expect(later.from_seq).toBeGreaterThan(earlier.to_seq)
  })

  it('旧路径 /chat/message 等价可用', async () => {
    const response = await post({ conversation_id: 'c7', customer_id: 'u7', text: '想退款还来得及吗' }, '/chat/message')
    expect(response.statusCode).toBe(200)
    expect((response.json() as { reply: string }).reply).not.toBe('')
  })
})

describe('POST /channels/webchat · 入参校验', () => {
  const post = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/channels/webchat', payload: body })

  it('缺少必填字段返回 400', async () => {
    expect((await post({ conversation_id: 'c1' })).statusCode).toBe(400)
  })

  it('未知字段被拒绝（additionalProperties: false）', async () => {
    const response = await post({ conversation_id: 'c1', customer_id: 'u1', text: 'hi', evil: 'payload' })
    expect(response.statusCode).toBe(400)
  })

  it('空文本被 schema 拒绝', async () => {
    expect((await post({ conversation_id: 'c1', customer_id: 'u1', text: '' })).statusCode).toBe(400)
  })

  it('超长文本被拒绝而不是拖垮模型', async () => {
    const response = await post({ conversation_id: 'c1', customer_id: 'u1', text: 'x'.repeat(9000) })
    expect(response.statusCode).toBe(400)
  })

  it('4xx 回显校验信息，便于调用方修正', async () => {
    const body = (await post({ conversation_id: 'c1' })).json() as { message?: string }
    expect(body.message).toBeTypeOf('string')
  })
})

describe('多租户', () => {
  it('载荷可指定 tenant_id，不同租户互不可见', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'c-other', customer_id: 'u-other', text: '想退款还来得及吗', tenant_id: 'other-corp' },
    })
    expect(other.statusCode).toBe(200)
    expect((other.json() as { reply: string }).reply).not.toMatch(/原路返回/)
  })
})
