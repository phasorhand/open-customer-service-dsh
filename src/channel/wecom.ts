/**
 * 企业微信「微信客服」渠道适配器。
 *
 * 协议形态（与 webchat 的推模型不同）：
 * 1. 企微向回调 URL 推**事件**（kf_msg_or_event），事件里只有游标 token
 * 2. 我们凭 access_token + 游标调 `kf/sync_msg` **拉取**增量消息
 * 3. 回复走 `kf/send_msg`（48 小时会话窗口内）
 *
 * HTTP 客户端可注入：单测/集成用桩覆盖收发闭环，真实凭证只在客户环境出现。
 */

import type { WecomConfig } from '../config.js'
import type { ChannelAdapter } from './adapter.js'
import { ChannelParseError } from './adapter.js'
import type { ChannelCapabilities, InboundMessage, OutboundAction, SendResult } from './types.js'
import { textOf } from './types.js'
import { WecomCrypto, xmlField } from './wecom-crypto.js'

export const WECOM_CHANNEL_ID = 'wecom_kf'

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin'
/** access_token 官方有效期 7200 秒；提前 5 分钟刷新，避免边界失效。 */
const TOKEN_REFRESH_MARGIN_MS = 300_000

/** 最小化的 HTTP 客户端接口，测试可注入桩。 */
export interface WecomHttp {
  getJson(url: string): Promise<Record<string, unknown>>
  postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** 默认实现：全局 fetch。 */
export class FetchWecomHttp implements WecomHttp {
  async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await fetch(url)
    return (await response.json()) as Record<string, unknown>
  }

  async postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await response.json()) as Record<string, unknown>
  }
}

export interface WecomAdapterOptions {
  readonly config: WecomConfig
  readonly tenantId: string
  readonly http?: WecomHttp
}

export class WecomAdapter implements ChannelAdapter {
  readonly channelId = WECOM_CHANNEL_ID
  readonly crypto: WecomCrypto
  private readonly http: WecomHttp
  private accessToken: string | undefined
  private tokenExpiresAt = 0
  /** sync_msg 的游标。持久化留待接入真实客户时补（丢游标只是重拉，幂等）。 */
  private syncCursor = ''

  constructor(private readonly options: WecomAdapterOptions) {
    this.crypto = new WecomCrypto(options.config.token, options.config.encodingAesKey, options.config.corpId)
    this.http = options.http ?? new FetchWecomHttp()
  }

  /**
   * URL 验证（企微在配置回调时 GET 一次）。
   *
   * @returns 解密后的 echostr，原样作为响应体返回。
   */
  verifyUrl(query: { msg_signature: string; timestamp: string; nonce: string; echostr: string }): string {
    return this.crypto.verifyUrl(query.msg_signature, query.timestamp, query.nonce, query.echostr)
  }

  /**
   * 解析回调事件（POST）。
   *
   * 企微客服的回调**不含消息本体**，只是「有新消息」的通知。
   * 返回 `undefined`，真正的消息经 {@link pullMessages} 拉取。
   *
   * @throws {ChannelParseError} 签名不符或密文非法。
   */
  async parseInbound(payload: unknown): Promise<InboundMessage | undefined> {
    const { body, query } = payload as {
      body?: string
      query?: { msg_signature?: string; timestamp?: string; nonce?: string }
    }
    if (typeof body !== 'string' || query?.msg_signature === undefined) {
      throw new ChannelParseError('wecom 回调载荷缺少密文或签名参数')
    }

    const encrypt = xmlField(body, 'Encrypt')
    if (encrypt === undefined) throw new ChannelParseError('wecom 回调 XML 缺少 Encrypt 字段')

    if (!this.crypto.verifySignature(query.msg_signature, query.timestamp ?? '', query.nonce ?? '', encrypt)) {
      throw new ChannelParseError('wecom 回调签名校验失败')
    }

    let plain: string
    try {
      plain = this.crypto.decrypt(encrypt)
    } catch (error) {
      throw new ChannelParseError(`wecom 回调解密失败：${String(error)}`)
    }

    // kf_msg_or_event 事件：记录 open_kfid 与拉取 token，消息本体走 sync_msg
    const openKfId = xmlField(plain, 'OpenKfId')
    if (openKfId !== undefined) this.lastOpenKfId = openKfId
    return undefined
  }

  /** 最近一次事件里的客服账号 id（配置省略 openKfId 时的兜底）。 */
  private lastOpenKfId: string | undefined

  /**
   * 拉取增量消息。
   *
   * @returns 平台中立的入站消息列表（只保留文本；其余类型先跳过并在扩展时补）。
   */
  async pullMessages(): Promise<readonly InboundMessage[]> {
    const token = await this.ensureAccessToken()
    const openKfId = this.options.config.openKfId ?? this.lastOpenKfId
    if (openKfId === undefined) return []

    const response = await this.http.postJson(`${API_BASE}/kf/sync_msg?access_token=${token}`, {
      open_kfid: openKfId,
      ...(this.syncCursor === '' ? {} : { cursor: this.syncCursor }),
    })
    assertOk(response, 'kf/sync_msg')

    if (typeof response['next_cursor'] === 'string') this.syncCursor = response['next_cursor']

    const list = Array.isArray(response['msg_list']) ? (response['msg_list'] as Record<string, unknown>[]) : []
    const out: InboundMessage[] = []
    for (const msg of list) {
      // origin 3 = 客户发来的消息；其余（客服回复回执、系统事件）不触发 agent
      if (msg['origin'] !== 3 || msg['msgtype'] !== 'text') continue
      const external = String(msg['external_userid'] ?? '')
      const text = (msg['text'] as { content?: string } | undefined)?.content ?? ''
      if (external === '' || text.trim() === '') continue
      out.push({
        channelId: this.channelId,
        // 企微客服没有独立会话 id：同一客户在同一客服账号下是连续对话
        conversationId: `${openKfId}:${external}`,
        customerId: external,
        senderKind: 'customer',
        content: [{ kind: 'text', text }],
        timestamp: new Date(Number(msg['send_time'] ?? 0) * 1000 || Date.now()),
        tenantId: this.options.tenantId,
        rawPayload: msg,
      })
    }
    return out
  }

  async send(action: OutboundAction): Promise<SendResult> {
    const text = textOf(action.content)
    if (text === '') return { ok: false, error: '企微客服仅支持文本消息（当前内容为空）', retryable: false }

    const openKfId = this.options.config.openKfId ?? this.lastOpenKfId ?? action.conversationId.split(':')[0]
    if (openKfId === undefined || openKfId === '') {
      return { ok: false, error: '缺少 open_kfid，无法确定用哪个客服账号发送', retryable: false }
    }

    let token: string
    try {
      token = await this.ensureAccessToken()
    } catch (error) {
      return { ok: false, error: `获取 access_token 失败：${String(error)}`, retryable: true }
    }

    const response = await this.http.postJson(`${API_BASE}/kf/send_msg?access_token=${token}`, {
      touser: action.customerId,
      open_kfid: openKfId,
      msgtype: 'text',
      text: { content: text },
    })
    const errcode = Number(response['errcode'] ?? -1)
    if (errcode === 0) {
      return { ok: true, ...(typeof response['msgid'] === 'string' ? { externalMessageId: response['msgid'] } : {}) }
    }
    // 95xxx 是会话窗口类错误（48 小时窗口外）——重试无意义
    const retryable = errcode !== 95001 && errcode !== 95017 && errcode < 95000
    return { ok: false, error: `kf/send_msg errcode=${errcode} ${String(response['errmsg'] ?? '')}`, retryable }
  }

  capabilities(): ChannelCapabilities {
    // 企微客服有 48 小时会话窗口：窗口外不可主动发起 → 节奏外呼不应选它做首触
    return { canSendProactive: false, supportsMedia: false, maxTextLength: 2048 }
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken !== undefined && Date.now() < this.tokenExpiresAt) return this.accessToken

    const { corpId, corpSecret } = this.options.config
    const response = await this.http.getJson(`${API_BASE}/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`)
    assertOk(response, 'gettoken')
    const token = response['access_token']
    if (typeof token !== 'string' || token === '') throw new Error('gettoken 未返回 access_token')

    this.accessToken = token
    const expiresIn = Number(response['expires_in'] ?? 7200)
    this.tokenExpiresAt = Date.now() + expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS
    return token
  }
}

function assertOk(response: Record<string, unknown>, api: string): void {
  const errcode = Number(response['errcode'] ?? 0)
  if (errcode !== 0) {
    throw new Error(`${api} 失败：errcode=${errcode} ${String(response['errmsg'] ?? '')}`)
  }
}
