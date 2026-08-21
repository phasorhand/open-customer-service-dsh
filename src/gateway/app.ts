/**
 * Fastify 应用工厂。
 *
 * 复用：fastify @ ^5 — 内建 JSON Schema 校验（与 dsh 的 schema 风格同源）、
 * 官方 WS/multipart 插件。排除 express（无内建校验）、hono（Node 侧 multipart 生态弱）。
 */

import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'

import type { OpenCsRuntime } from '../runtime.js'
import { registerAdminRoutes, registerEvolutionRoutes } from './routes-admin.js'
import { registerApprovalRoutes } from './routes-approvals.js'
import { registerCadenceRoutes } from './routes-cadences.js'
import { registerChannelRoutes } from './routes-channels.js'
import { registerContactRoutes } from './routes-contacts.js'
import { registerHealthRoutes } from './routes-health.js'
import { consoleHtml } from './console.js'
import { registerWecomRoutes } from './routes-wecom.js'
import { registerWsRoutes } from './ws.js'
import { registerAuth, registerWebhookRateLimit } from './security.js'

/** 请求体上限：入站 webhook 载荷不应很大；超限直接拒绝而不是拖垮进程。 */
const BODY_LIMIT_BYTES = 1_048_576

/**
 * 创建 HTTP 应用。
 *
 * @param runtime - 已构建的运行时对象图。
 * @returns 未监听的 Fastify 实例（调用方负责 `listen`）。
 */
export async function createApp(runtime: OpenCsRuntime): Promise<FastifyInstance> {
  const app = Fastify({
    logger: runtime.config.env !== 'test',
    bodyLimit: BODY_LIMIT_BYTES,
    ajv: {
      customOptions: {
        // fastify 默认 removeAdditional:true —— 未知字段会被**静默剥掉**。
        // 对 webhook 而言这会掩盖接入方的字段名拼写错误，直到线上才发现。
        // 这里改为显式拒绝：接错了要立刻 400，而不是行为诡异。
        removeAdditional: false,
        allErrors: true,
      },
    },
  })

  await app.register(websocket)

  app.decorate('opencs', runtime)

  // 安全层先于路由：鉴权与频控是 onRequest/preHandler 钩子
  registerAuth(app, runtime)
  registerWebhookRateLimit(app, runtime)

  registerHealthRoutes(app, runtime)
  registerChannelRoutes(app, runtime)
  registerAdminRoutes(app, runtime)
  registerEvolutionRoutes(app, runtime)
  registerContactRoutes(app, runtime)
  registerCadenceRoutes(app, runtime)
  registerApprovalRoutes(app, runtime)
  if (runtime.wecom !== undefined) registerWecomRoutes(app, runtime, runtime.wecom)

  // 管理控制台：HTML 本身不含敏感数据，数据接口仍受 Bearer 鉴权
  app.get('/console', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8')
    return consoleHtml()
  })
  await registerWsRoutes(app, runtime)

  app.setErrorHandler((error: unknown, request, reply) => {
    const failure = error as { statusCode?: number; code?: string; message?: string }
    const status = typeof failure.statusCode === 'number' ? failure.statusCode : 500
    if (status >= 500) request.log.error({ err: error }, '未处理的请求错误')
    // 5xx 不回显内部信息；4xx 回显校验消息帮助调用方修正
    void reply.status(status).send({
      error: status >= 500 ? 'internal_error' : (failure.code ?? 'bad_request'),
      message: status >= 500 ? '服务内部错误' : (failure.message ?? '请求非法'),
    })
  })

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly opencs: OpenCsRuntime
  }
}
