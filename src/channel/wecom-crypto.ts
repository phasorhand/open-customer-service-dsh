/**
 * 企业微信回调加解密（官方 WXBizMsgCrypt 算法的 TypeScript 实现）。
 *
 * 自建理由（RESEARCH.md 决策补充）：官方只提供 PHP/Java/Python/C++ 的参考实现；
 * npm 上的第三方移植要么停更多年、要么无 license。算法本身只有三步
 * （SHA1 字典序签名、AES-256-CBC、自定义封包），用 node:crypto 实现 ~100 行，
 * 引第三方依赖的供应链风险大于自建成本。
 *
 * 算法（官方文档《加解密方案说明》）：
 * - AESKey = Base64Decode(EncodingAESKey + '=')，32 字节；IV = AESKey 前 16 字节
 * - 明文封包 = random(16B) + msg_len(4B, 网络序) + msg + receiveid
 * - 填充：PKCS#7，块大小 32
 * - 签名 = SHA1(字典序排序(token, timestamp, nonce, msg_encrypt) 后拼接)
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export class WecomCryptoError extends Error {
  override readonly name = 'WecomCryptoError'
}

/** PKCS#7 块大小。企微用 32（不是 AES 标准的 16）。 */
const BLOCK_SIZE = 32

export class WecomCrypto {
  private readonly aesKey: Buffer
  private readonly iv: Buffer

  /**
   * @param token - 回调配置里的 Token（签名用）。
   * @param encodingAesKey - 43 位 EncodingAESKey。
   * @param receiveId - 企业内部应用为 corpid。
   * @throws {WecomCryptoError} EncodingAESKey 非法。
   */
  constructor(
    private readonly token: string,
    encodingAesKey: string,
    private readonly receiveId: string,
  ) {
    if (encodingAesKey.length !== 43) {
      throw new WecomCryptoError(`EncodingAESKey 必须是 43 位字符（收到 ${encodingAesKey.length} 位）`)
    }
    this.aesKey = Buffer.from(`${encodingAesKey}=`, 'base64')
    if (this.aesKey.length !== 32) {
      throw new WecomCryptoError('EncodingAESKey Base64 解码后必须是 32 字节')
    }
    this.iv = this.aesKey.subarray(0, 16)
  }

  /**
   * 计算回调签名。
   *
   * @returns SHA1(sort(token, timestamp, nonce, encrypt))。
   */
  signature(timestamp: string, nonce: string, encrypt: string): string {
    const joined = [this.token, timestamp, nonce, encrypt].sort().join('')
    return createHash('sha1').update(joined).digest('hex')
  }

  /**
   * 校验签名。恒定时间比较，防计时侧信道。
   *
   * @returns 是否有效。
   */
  verifySignature(msgSignature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    const expected = Buffer.from(this.signature(timestamp, nonce, encrypt), 'utf8')
    const presented = Buffer.from(msgSignature, 'utf8')
    return expected.length === presented.length && timingSafeEqual(expected, presented)
  }

  /**
   * 解密回调密文。
   *
   * @param encrypted - Base64 密文。
   * @returns 明文消息（XML 或验证用 echostr）。
   * @throws {WecomCryptoError} 解密失败、填充非法或 receiveid 不匹配。
   */
  decrypt(encrypted: string): string {
    let padded: Buffer
    try {
      const decipher = createDecipheriv('aes-256-cbc', this.aesKey, this.iv)
      decipher.setAutoPadding(false) // 企微用 32 字节 PKCS#7，Node 自动去填充只认 16
      padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()])
    } catch (error) {
      throw new WecomCryptoError(`AES 解密失败：${String(error)}`)
    }

    const plain = unpad(padded)
    if (plain.length < 20) throw new WecomCryptoError('明文过短，不是合法的企微封包')

    // 封包：random(16) + msg_len(4, 网络序) + msg + receiveid
    const msgLen = plain.readUInt32BE(16)
    if (20 + msgLen > plain.length) throw new WecomCryptoError('msg_len 越界，密文可能被截断')

    const message = plain.subarray(20, 20 + msgLen).toString('utf8')
    const receiveId = plain.subarray(20 + msgLen).toString('utf8')
    // receiveid 校验防「用别家企业的密文重放到我们的回调」
    if (receiveId !== this.receiveId) {
      throw new WecomCryptoError(`receiveid 不匹配：期望 ${this.receiveId}，收到 ${receiveId}`)
    }
    return message
  }

  /**
   * 加密明文（响应企微时用）。
   *
   * @param message - 明文。
   * @returns Base64 密文。
   */
  encrypt(message: string): string {
    const msg = Buffer.from(message, 'utf8')
    const lenBuf = Buffer.alloc(4)
    lenBuf.writeUInt32BE(msg.length)
    const packed = Buffer.concat([randomBytes(16), lenBuf, msg, Buffer.from(this.receiveId, 'utf8')])

    const cipher = createCipheriv('aes-256-cbc', this.aesKey, this.iv)
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(pad(packed)), cipher.final()]).toString('base64')
  }

  /**
   * URL 验证（GET 回调）：校验签名并解密 echostr。
   *
   * @returns 解密后的 echostr（原样返回给企微完成验证）。
   * @throws {WecomCryptoError} 签名不符或解密失败。
   */
  verifyUrl(msgSignature: string, timestamp: string, nonce: string, echostr: string): string {
    if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
      throw new WecomCryptoError('URL 验证签名不符')
    }
    return this.decrypt(echostr)
  }
}

function pad(data: Buffer): Buffer {
  const amount = BLOCK_SIZE - (data.length % BLOCK_SIZE)
  return Buffer.concat([data, Buffer.alloc(amount, amount)])
}

function unpad(data: Buffer): Buffer {
  const last = data.at(-1) ?? 0
  const amount = last >= 1 && last <= BLOCK_SIZE ? last : 0
  if (amount === 0) throw new WecomCryptoError('PKCS#7 填充非法')
  return data.subarray(0, data.length - amount)
}

/**
 * 从企微回调 XML 里取一个字段（CDATA 或纯文本）。
 *
 * 企微 XML 结构扁平且字段名固定，正则提取即可——引入完整 XML 解析器
 * 换不来收益（且 XXE 风险面更大）。
 */
export function xmlField(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml)
  if (cdata !== null) return cdata[1]
  const plain = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)
  return plain?.[1]
}
