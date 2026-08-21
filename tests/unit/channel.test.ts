import { describe, expect, it } from 'vitest'

import { ChannelParseError, ChannelRegistry, UnknownChannelError } from '../../src/channel/adapter.js'
import type { ChannelAdapter } from '../../src/channel/adapter.js'
import { textContent, textOf } from '../../src/channel/types.js'
import { WEBCHAT_CHANNEL_ID, WebChatAdapter } from '../../src/channel/webchat.js'

const stub = (channelId: string): ChannelAdapter => ({
  channelId,
  async parseInbound() {
    return undefined
  },
  async send() {
    return { ok: true }
  },
  capabilities() {
    return { canSendProactive: false, supportsMedia: false, maxTextLength: 100 }
  },
})

describe('ChannelRegistry', () => {
  it('注册后可按 id 取回', () => {
    const registry = new ChannelRegistry()
    const adapter = stub('a')
    registry.register(adapter)
    expect(registry.get('a')).toBe(adapter)
  })

  it('重复注册同一 id 抛错（否则路由不确定）', () => {
    const registry = new ChannelRegistry()
    registry.register(stub('a'))
    expect(() => registry.register(stub('a'))).toThrow(/已注册/)
  })

  it('取未注册渠道抛 UnknownChannelError', () => {
    expect(() => new ChannelRegistry().get('nope')).toThrow(UnknownChannelError)
  })

  it('find 对未注册渠道返回 undefined', () => {
    expect(new ChannelRegistry().find('nope')).toBeUndefined()
  })

  it('注册返回的注销函数可撤销注册', () => {
    const registry = new ChannelRegistry()
    const unregister = registry.register(stub('a'))
    unregister()
    expect(registry.find('a')).toBeUndefined()
  })

  it('list 列出全部已注册渠道', () => {
    const registry = new ChannelRegistry()
    registry.register(stub('a'))
    registry.register(stub('b'))
    expect([...registry.list()].sort()).toEqual(['a', 'b'])
  })
})

describe('内容片段辅助', () => {
  it('textOf 拼接文本片段，跳过媒体', () => {
    expect(textOf([{ kind: 'text', text: '你好' }, { kind: 'image', mediaUrl: 'x' }, { kind: 'text', text: '世界' }])).toBe(
      '你好世界',
    )
  })

  it('textContent 构造单条文本片段', () => {
    expect(textOf(textContent('hi'))).toBe('hi')
  })
})

describe('WebChatAdapter · 入站解析', () => {
  const adapter = new WebChatAdapter('default')

  it('解析出平台中立消息', async () => {
    const message = await adapter.parseInbound({ conversation_id: 'c', customer_id: 'u', text: '你好' })
    expect(message).toMatchObject({
      channelId: WEBCHAT_CHANNEL_ID,
      conversationId: 'c',
      customerId: 'u',
      senderKind: 'customer',
      tenantId: 'default',
    })
    expect(textOf(message?.content ?? [])).toBe('你好')
  })

  it('载荷可覆盖 tenant_id', async () => {
    const message = await adapter.parseInbound({ conversation_id: 'c', customer_id: 'u', text: 'x', tenant_id: 'acme' })
    expect(message?.tenantId).toBe('acme')
  })

  it.each([[null], ['字符串'], [42]])('非对象载荷抛 ChannelParseError：%s', async (payload) => {
    await expect(adapter.parseInbound(payload)).rejects.toThrow(ChannelParseError)
  })

  it('缺少必填字段时报出**具体缺了哪些**', async () => {
    await expect(adapter.parseInbound({ conversation_id: 'c' })).rejects.toThrow(/customer_id, text/)
  })

  it('纯空白消息返回 undefined（不该触发一次 agent turn）', async () => {
    expect(await adapter.parseInbound({ conversation_id: 'c', customer_id: 'u', text: '   ' })).toBeUndefined()
  })

  it('非法时间戳降级为当前时间而不是 Invalid Date', async () => {
    const message = await adapter.parseInbound({ conversation_id: 'c', customer_id: 'u', text: 'x', timestamp: '乱码' })
    expect(Number.isNaN(message?.timestamp.getTime())).toBe(false)
  })
})

describe('WebChatAdapter · 出站投递', () => {
  const action = {
    channelId: WEBCHAT_CHANNEL_ID,
    conversationId: 'c',
    customerId: 'u',
    kind: 'reply' as const,
    content: textContent('答复'),
  }

  it('无在线订阅者时**仍然算送达**（HTTP 请求/响应模式）', async () => {
    const adapter = new WebChatAdapter('default')
    expect(await adapter.send(action)).toEqual({ ok: true })
  })

  it('drain 取回待发消息，且只能取一次', async () => {
    const adapter = new WebChatAdapter('default')
    await adapter.send(action)
    expect(adapter.drain('c').map((a) => textOf(a.content))).toEqual(['答复'])
    expect(adapter.drain('c')).toEqual([])
  })

  it('不同会话的待发消息互不串台', async () => {
    const adapter = new WebChatAdapter('default')
    await adapter.send(action)
    await adapter.send({ ...action, conversationId: 'c2', content: textContent('另一条') })
    expect(adapter.drain('c').map((a) => textOf(a.content))).toEqual(['答复'])
    expect(adapter.drain('c2').map((a) => textOf(a.content))).toEqual(['另一条'])
  })

  it('在线订阅者实时收到消息', async () => {
    const adapter = new WebChatAdapter('default')
    const seen: string[] = []
    adapter.subscribe((a) => seen.push(textOf(a.content)))
    await adapter.send(action)
    expect(seen).toEqual(['答复'])
  })

  it('坏订阅者抛错不影响其他订阅者与投递结果', async () => {
    const adapter = new WebChatAdapter('default')
    const seen: string[] = []
    adapter.subscribe(() => {
      throw new Error('boom')
    })
    adapter.subscribe((a) => seen.push(textOf(a.content)))
    expect(await adapter.send(action)).toEqual({ ok: true })
    expect(seen).toEqual(['答复'])
  })

  it('取消订阅后不再收到', async () => {
    const adapter = new WebChatAdapter('default')
    const seen: string[] = []
    const unsubscribe = adapter.subscribe((a) => seen.push(textOf(a.content)))
    unsubscribe()
    await adapter.send(action)
    expect(seen).toEqual([])
  })

  it('声明支持主动发起（节奏外呼的默认演示渠道）', () => {
    expect(new WebChatAdapter('default').capabilities().canSendProactive).toBe(true)
  })
})
