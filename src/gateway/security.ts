/**
 * 网关安全层：管理面鉴权 + 公网 webhook 频控。
 *
 * 边界划分：
 * - `/admin/*` `/console`（数据接口）：要求 Bearer token——管理面能改生命周期、
 *   批外呼，等同后台权限
 * - `/health/*`：开放——k8s/负载均衡探针没有带 token 的能力
 * - `/channels/*`：开放但**频控**——它是客户触点，鉴权在渠道协议层
 *   （企微有签名校验），频控防的是被刷爆 LLM 账单
 */

import { timingSafeEqual } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { OpenCsRuntime } from '../runtime.js'

/** webhook 频控窗口（毫秒）。 */
const RATE_WINDOW_MS = 60_000

/**
 * 注册鉴权钩子。
 *
 * @param app - Fastify 实例。
 * @param runtime - 运行时（读 adminToken 配置）。
 */
export function registerAuth(app: FastifyInstance, runtime: OpenCsRuntime): void {
  const token = runtime.config.adminToken

  if (token === undefined) {
    // 生产环境在 loadConfig 就会拒绝缺失；能走到这里只有 dev/test
    if (runtime.config.env !== 'test') {
      app.log.warn('未设置 OPENCS_ADMIN_TOKEN，管理 API 处于无鉴权状态——仅限本地开发')
    }
    return
  }

  const expected = Buffer.from(token, 'utf8')

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/admin/')) return

    const header = request.headers.authorization
    const presented = header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : undefined
    if (presented !== undefined && constantTimeEquals(expected, presented)) return

    // async 钩子里发响应必须 return reply，否则 fastify 生命周期会停摆
    return reply
      .status(401)
      .send({ error: 'unauthorized', message: '缺少或无效的管理凭证（Authorization: Bearer <OPENCS_ADMIN_TOKEN>）' })
  })
}

/** 恒定时间比较，避免 token 被逐字节计时猜测。 */
function constantTimeEquals(expected: Buffer, presented: string): boolean {
  const candidate = Buffer.from(presented, 'utf8')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(expected, candidate)
}

/**
 * 注册 webhook 频控钩子。
 *
 * 维度是 **conversation_id**（而不是 IP）：客户触点常经反代/小程序网关，
 * 源 IP 会坍缩成一个；而刷账单的模式是「同一会话高频灌消息」。
 *
 * @param app - Fastify 实例。
 * @param runtime - 运行时（读频控配置）。
 */
export function registerWebhookRateLimit(app: FastifyInstance, runtime: OpenCsRuntime): void {
  const limit = runtime.config.webhookRateLimit
  /** conversationId → 窗口内的时间戳。 */
  const hits = new Map<string, number[]>()
  /** 定期清理，避免长跑进程 map 无界增长。 */
  let lastSweep = Date.now()

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'POST') return
    if (!request.url.startsWith('/channels/') && !request.url.startsWith('/chat/')) return

    const conversationId = conversationOf(request.body)
    if (conversationId === undefined) return // 让 schema 校验去拒绝

    const now = Date.now()
    if (now - lastSweep > RATE_WINDOW_MS * 5) {
      lastSweep = now
      for (const [key, stamps] of hits) {
        if (stamps.every((ts) => now - ts >= RATE_WINDOW_MS)) hits.delete(key)
      }
    }

    const recent = (hits.get(conversationId) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS)
    if (recent.length >= limit) {
      hits.set(conversationId, recent)
      // async 钩子里发响应必须 return reply，否则 fastify 生命周期会停摆
      return reply
        .status(429)
        .header('retry-after', Math.ceil(RATE_WINDOW_MS / 1000))
        .send({ error: 'rate_limited', message: `会话 ${conversationId} 超过每分钟 ${limit} 条的上限` })
    }
    recent.push(now)
    hits.set(conversationId, recent)
  })
}

function conversationOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>)['conversation_id']
  return typeof value === 'string' && value !== '' ? value : undefined
}
