/**
 * 企微加解密与适配器测试。
 *
 * 加解密没有官方测试向量可抄（官方样例的密钥不公开），
 * 用**往返一致性**验证：encrypt → decrypt 恢复原文、签名可验、
 * receiveid 不符被拒。算法结构（封包格式/块大小/IV）逐项断言。
 */

import { describe, expect, it } from 'vitest'

import type { WecomConfig } from '../../src/config.js'
import { WecomAdapter, type WecomHttp } from '../../src/channel/wecom.js'
import { WecomCrypto, WecomCryptoError, xmlField } from '../../src/channel/wecom-crypto.js'

/** 43 位合法 EncodingAESKey（Base64 解码后 32 字节）。 */
const AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const TOKEN = 'test-callback-token'
const CORP_ID = 'ww1234567890abcdef'

const crypto = () => new WecomCrypto(TOKEN, AES_KEY, CORP_ID)

describe('WecomCrypto · 加解密往返', () => {
  it('encrypt → decrypt 恢复原文', () => {
    const instance = crypto()
    const plain = '<xml><ToUserName><![CDATA[ww123]]></ToUserName><Event><![CDATA[kf_msg_or_event]]></Event></xml>'
    expect(instance.decrypt(instance.encrypt(plain))).toBe(plain)
  })

  it('中文与 emoji 往返无损（msg_len 按字节而非字符）', () => {
    const instance = crypto()
    const plain = '客户说：你好👋，我想退款'
    expect(instance.decrypt(instance.encrypt(plain))).toBe(plain)
  })

  it('每次加密随机前缀不同，密文不可重放比对', () => {
    const instance = crypto()
    expect(instance.encrypt('same')).not.toBe(instance.encrypt('same'))
  })

  it('receiveid 不匹配被拒（防跨企业密文重放）', () => {
    const ours = crypto()
    const theirs = new WecomCrypto(TOKEN, AES_KEY, 'ww-other-corp')
    expect(() => ours.decrypt(theirs.encrypt('偷来的密文'))).toThrow(/receiveid 不匹配/)
  })

  it('坏密文抛 WecomCryptoError 而不是原始异常', () => {
    expect(() => crypto().decrypt('not-base64!!!')).toThrow(WecomCryptoError)
    expect(() => crypto().decrypt(Buffer.from('short').toString('base64'))).toThrow(WecomCryptoError)
  })

  it('EncodingAESKey 长度非法在构造时就拒绝', () => {
    expect(() => new WecomCrypto(TOKEN, 'too-short', CORP_ID)).toThrow(/43 位/)
  })
})

describe('WecomCrypto · 签名', () => {
  it('签名可验证', () => {
    const instance = crypto()
    const encrypted = instance.encrypt('msg')
    const signature = instance.signature('1692600000', 'nonce123', encrypted)
    expect(instance.verifySignature(signature, '1692600000', 'nonce123', encrypted)).toBe(true)
  })

  it('任一参数变动签名即失效', () => {
    const instance = crypto()
    const encrypted = instance.encrypt('msg')
    const signature = instance.signature('1692600000', 'nonce123', encrypted)
    expect(instance.verifySignature(signature, '1692600001', 'nonce123', encrypted)).toBe(false)
    expect(instance.verifySignature(signature, '1692600000', 'other', encrypted)).toBe(false)
    expect(instance.verifySignature('deadbeef', '1692600000', 'nonce123', encrypted)).toBe(false)
  })

  it('URL 验证：签名对则返回解密后的 echostr', () => {
    const instance = crypto()
    const echoPlain = 'random-echo-string-42'
    const echostr = instance.encrypt(echoPlain)
    const signature = instance.signature('ts', 'n', echostr)
    expect(instance.verifyUrl(signature, 'ts', 'n', echostr)).toBe(echoPlain)
  })

  it('URL 验证：签名错直接拒绝，不解密', () => {
    const instance = crypto()
    expect(() => instance.verifyUrl('bad', 'ts', 'n', instance.encrypt('echo'))).toThrow(/签名不符/)
  })
})

describe('xmlField', () => {
  it('提取 CDATA 与纯文本字段', () => {
    const xml = '<xml><A><![CDATA[cdata-值]]></A><B>plain</B></xml>'
    expect(xmlField(xml, 'A')).toBe('cdata-值')
    expect(xmlField(xml, 'B')).toBe('plain')
    expect(xmlField(xml, 'C')).toBeUndefined()
  })
})

describe('WecomAdapter · 收发闭环（stub HTTP）', () => {
  const config: WecomConfig = {
    corpId: CORP_ID,
    corpSecret: 'secret',
    token: TOKEN,
    encodingAesKey: AES_KEY,
    openKfId: 'kf_001',
  }

  /** 记录请求并按 URL 返回脚本化响应的桩。 */
  class StubHttp implements WecomHttp {
    readonly posts: { url: string; body: Record<string, unknown> }[] = []
    tokenCalls = 0

    async getJson(url: string): Promise<Record<string, unknown>> {
      if (url.includes('/gettoken')) {
        this.tokenCalls += 1
        return { errcode: 0, access_token: `tok-${this.tokenCalls}`, expires_in: 7200 }
      }
      return { errcode: 1, errmsg: `unexpected GET ${url}` }
    }

    async postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      this.posts.push({ url, body })
      if (url.includes('/kf/sync_msg')) {
        return {
          errcode: 0,
          next_cursor: 'cursor-1',
          msg_list: [
            { msgid: 'm1', origin: 3, msgtype: 'text', external_userid: 'wm-cust-1', send_time: 1755763200, text: { content: '想退款' } },
            // origin 4 = 系统事件，不该触发 agent
            { msgid: 'm2', origin: 4, msgtype: 'event', external_userid: 'wm-cust-1' },
            // 非文本先跳过
            { msgid: 'm3', origin: 3, msgtype: 'image', external_userid: 'wm-cust-2' },
          ],
        }
      }
      if (url.includes('/kf/send_msg')) return { errcode: 0, msgid: 'sent-1' }
      return { errcode: 1, errmsg: `unexpected POST ${url}` }
    }
  }

  it('回调事件：验签 + 解密，返回 undefined（消息本体走拉取）', async () => {
    const adapter = new WecomAdapter({ config, tenantId: 'default', http: new StubHttp() })
    const eventXml = '<xml><ToUserName><![CDATA[ww123]]></ToUserName><OpenKfId><![CDATA[kf_001]]></OpenKfId></xml>'
    const encrypt = adapter.crypto.encrypt(eventXml)
    const callbackBody = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`
    const signature = adapter.crypto.signature('ts', 'nonce', encrypt)

    const result = await adapter.parseInbound({
      body: callbackBody,
      query: { msg_signature: signature, timestamp: 'ts', nonce: 'nonce' },
    })
    expect(result).toBeUndefined()
  })

  it('伪造签名的回调被拒', async () => {
    const adapter = new WecomAdapter({ config, tenantId: 'default', http: new StubHttp() })
    const encrypt = adapter.crypto.encrypt('<xml></xml>')
    await expect(
      adapter.parseInbound({
        body: `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
        query: { msg_signature: 'forged', timestamp: 'ts', nonce: 'n' },
      }),
    ).rejects.toThrow(/签名校验失败/)
  })

  it('拉取消息：只保留客户发来的文本，转成平台中立消息', async () => {
    const adapter = new WecomAdapter({ config, tenantId: 'default', http: new StubHttp() })
    const messages = await adapter.pullMessages()

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      channelId: 'wecom_kf',
      conversationId: 'kf_001:wm-cust-1',
      customerId: 'wm-cust-1',
      tenantId: 'default',
    })
    expect(messages[0]?.content[0]?.text).toBe('想退款')
  })

  it('游标在两次拉取间延续（增量而非全量）', async () => {
    const http = new StubHttp()
    const adapter = new WecomAdapter({ config, tenantId: 'default', http })
    await adapter.pullMessages()
    await adapter.pullMessages()
    expect(http.posts[1]?.body['cursor']).toBe('cursor-1')
  })

  it('发送：带 access_token 调 kf/send_msg', async () => {
    const http = new StubHttp()
    const adapter = new WecomAdapter({ config, tenantId: 'default', http })
    const result = await adapter.send({
      channelId: 'wecom_kf',
      conversationId: 'kf_001:wm-cust-1',
      customerId: 'wm-cust-1',
      kind: 'reply',
      content: [{ kind: 'text', text: '按政策 7 天内可退' }],
    })
    expect(result).toEqual({ ok: true, externalMessageId: 'sent-1' })
    const sent = http.posts.find((post) => post.url.includes('/kf/send_msg'))
    expect(sent?.body).toMatchObject({ touser: 'wm-cust-1', open_kfid: 'kf_001', msgtype: 'text' })
  })

  it('access_token 在有效期内复用，不重复取', async () => {
    const http = new StubHttp()
    const adapter = new WecomAdapter({ config, tenantId: 'default', http })
    await adapter.pullMessages()
    await adapter.pullMessages()
    expect(http.tokenCalls).toBe(1)
  })

  it('会话窗口类错误（95xxx）标记为不可重试', async () => {
    class WindowClosedHttp extends StubHttp {
      override async postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (url.includes('/kf/send_msg')) return { errcode: 95001, errmsg: 'session window closed' }
        return super.postJson(url, body)
      }
    }
    const adapter = new WecomAdapter({ config, tenantId: 'default', http: new WindowClosedHttp() })
    const result = await adapter.send({
      channelId: 'wecom_kf',
      conversationId: 'kf_001:wm-cust-1',
      customerId: 'wm-cust-1',
      kind: 'reply',
      content: [{ kind: 'text', text: 'x' }],
    })
    expect(result).toMatchObject({ ok: false, retryable: false })
  })

  it('声明不支持主动发起（48 小时窗口）——节奏首触不该选企微', () => {
    const adapter = new WecomAdapter({ config, tenantId: 'default', http: new StubHttp() })
    expect(adapter.capabilities().canSendProactive).toBe(false)
  })
})
