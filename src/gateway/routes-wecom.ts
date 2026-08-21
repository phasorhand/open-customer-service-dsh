/**
 * 企业微信客服回调路由。
 *
 * 时序要求：企微要求回调**5 秒内**返回，否则重推。因此 POST 处理器
 * 校验签名后立即回 200，消息拉取与 agent 处理在响应后异步进行。
 */

import type { FastifyInstance } from 'fastify'

import { ChannelParseError } from '../channel/adapter.js'
import type { WecomAdapter } from '../channel/wecom.js'
import type { OpenCsRuntime } from '../runtime.js'
import { InboundDispatcher } from './dispatcher.js'

export function registerWecomRoutes(app: FastifyInstance, runtime: OpenCsRuntime, adapter: WecomAdapter): void {
  const dispatcher = new InboundDispatcher(runtime)

  // 企微 POST 的是 XML；fastify 默认只解析 JSON
  app.addContentTypeParser(['text/xml', 'application/xml'], { parseAs: 'string' }, (_request, body, done) => {
    done(null, body)
  })

  // URL 验证：配置回调地址时企微 GET 一次，要求返回解密后的 echostr
  app.get('/channels/wecom/callback', async (request, reply) => {
    const query = request.query as {
      msg_signature?: string
      timestamp?: string
      nonce?: string
      echostr?: string
    }
    if (query.msg_signature === undefined || query.echostr === undefined) {
      void reply.status(400)
      return { error: 'bad_request', message: '缺少验证参数' }
    }
    try {
      const echo = adapter.verifyUrl({
        msg_signature: query.msg_signature,
        timestamp: query.timestamp ?? '',
        nonce: query.nonce ?? '',
        echostr: query.echostr,
      })
      // 企微要求**纯文本**返回明文 echostr，不能是 JSON
      void reply.type('text/plain')
      return echo
    } catch (error) {
      request.log.warn({ err: error }, '企微 URL 验证失败')
      void reply.status(403)
      return { error: 'verify_failed', message: '签名校验失败' }
    }
  })

  app.post('/channels/wecom/callback', async (request, reply) => {
    try {
      // 只校验签名与解密；事件里没有消息本体
      await adapter.parseInbound({ body: request.body, query: request.query })
    } catch (error) {
      if (error instanceof ChannelParseError) {
        // 签名不符 = 伪造回调，403 且不进入拉取
        void reply.status(403)
        return { error: 'invalid_callback', message: error.message }
      }
      throw error
    }

    // 立即响应企微（5 秒时限），拉取与处理异步进行
    void processNewMessages(runtime, adapter, dispatcher, app)
    void reply.type('text/plain')
    return 'success'
  })
}

/** 拉取增量消息并逐条经 agent 处理，回复经企微发回。 */
async function processNewMessages(
  runtime: OpenCsRuntime,
  adapter: WecomAdapter,
  dispatcher: InboundDispatcher,
  app: FastifyInstance,
): Promise<void> {
  try {
    const messages = await adapter.pullMessages()
    for (const message of messages) {
      try {
        await dispatcher.dispatch(message)
        // agent 的回复经 channel.reply 工具投递；企微渠道的 OutboundPort
        // 路由在 runtime 的 ChannelOutbound 里按 channelId 分发
      } catch (error) {
        app.log.error({ err: error, conversationId: message.conversationId }, '企微消息处理失败')
      }
    }
  } catch (error) {
    app.log.error({ err: error }, '企微消息拉取失败')
  }
}
