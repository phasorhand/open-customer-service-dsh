/**
 * 渠道适配器接口与注册表。
 *
 * 设计：适配器是**无状态**的协议翻译层——解析入站、投递出站、声明能力。
 * 业务判断（该不该发、发什么）不在这里，在 agent + guard 里。
 */

import type { ChannelCapabilities, InboundMessage, OutboundAction, SendResult } from './types.js'

export interface ChannelAdapter {
  readonly channelId: string

  /**
   * 把厂商载荷解析成平台中立消息。
   *
   * @param payload - 厂商原始载荷。
   * @returns 解析结果；载荷不是一条用户消息（如事件回调、心跳）时返回 `undefined`。
   * @throws {ChannelParseError} 载荷格式非法（签名不符、必填字段缺失）。
   */
  parseInbound(payload: unknown): Promise<InboundMessage | undefined>

  /**
   * 投递一条出站动作。
   *
   * @param action - 已通过 guard 的出站动作。
   * @returns 投递结果；失败以返回值表达，便于上游区分可重试与不可重试。
   */
  send(action: OutboundAction): Promise<SendResult>

  capabilities(): ChannelCapabilities
}

export class ChannelParseError extends Error {
  override readonly name = 'ChannelParseError'
}

export class UnknownChannelError extends Error {
  override readonly name = 'UnknownChannelError'
  constructor(channelId: string) {
    super(`未注册的渠道：${channelId}`)
  }
}

/** 进程内渠道注册表。 */
export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>()

  /**
   * 注册适配器。
   *
   * @param adapter - 适配器实例。
   * @returns 注销函数（registrations are effects）。
   * @throws {Error} channelId 重复注册。
   */
  register(adapter: ChannelAdapter): () => void {
    if (this.adapters.has(adapter.channelId)) {
      throw new Error(`渠道 ${adapter.channelId} 已注册，重复注册会让路由不确定`)
    }
    this.adapters.set(adapter.channelId, adapter)
    return () => {
      this.adapters.delete(adapter.channelId)
    }
  }

  /**
   * 取适配器。
   *
   * @param channelId - 渠道标识。
   * @returns 适配器。
   * @throws {UnknownChannelError} 未注册。
   */
  get(channelId: string): ChannelAdapter {
    const adapter = this.adapters.get(channelId)
    if (adapter === undefined) throw new UnknownChannelError(channelId)
    return adapter
  }

  /** 取适配器，未注册返回 `undefined`。 */
  find(channelId: string): ChannelAdapter | undefined {
    return this.adapters.get(channelId)
  }

  /** 已注册的渠道 id 列表（健康检查用）。 */
  list(): readonly string[] {
    return [...this.adapters.keys()]
  }
}
