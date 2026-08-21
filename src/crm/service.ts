/**
 * 联系人业务逻辑：入站识别、身份关联、阶段跃迁、打分。
 *
 * 职责边界：`ContactStore` 只管持久化，本类管**规则**。
 * 写入方法不直接暴露给模型——它们经 `defineTool` 收口并受 guard 治理。
 */

import type { InboundMessage } from '../channel/types.js'
import { advanceOnInbound, applyTransition, checkTransition } from './lifecycle.js'
import { computeScore } from './scoring.js'
import { selectAudience } from './segment.js'
import type { ContactStore } from './store.js'
import {
  isAddressable,
  normalizeDedupKey,
  type AudienceFilter,
  type Contact,
  type LeadStatus,
  type LifecycleStage,
} from './types.js'

export class UnaddressableError extends Error {
  override readonly name = 'UnaddressableError'
  constructor(readonly contactId: string) {
    super(`联系人 ${contactId} 没有任何渠道身份，无法触达；请先关联渠道身份或从受众中排除`)
  }
}

export class ContactService {
  constructor(private readonly store: ContactStore) {}

  /**
   * 处理一条入站消息：找到或创建联系人，推进阶段，重新打分。
   *
   * 查找顺序（Python 版重复建档 bug 的修复）：
   *   1. 按**渠道身份** `(channel_id, external_id)` 找 —— 最精确
   *   2. 按**业务身份** `dedup_key` 找 —— 同一个人换了渠道
   *   3. 都没有才新建
   *
   * @param message - 入站消息。
   * @param now - 当前时间（注入便于测试）。
   * @returns 更新后的联系人。
   */
  onInbound(message: InboundMessage, now = new Date()): Contact {
    const { tenantId, channelId, customerId } = message

    let contact = this.store.findByChannelIdentity(tenantId, channelId, customerId)

    if (contact === undefined) {
      // 渠道身份没找到 → 按业务身份找。渠道 external_id 作为兜底去重键，
      // 保证「首次接触且没有邮箱手机」的客户也有稳定身份。
      const dedupKey = normalizeDedupKey({ fallback: `${channelId}:${customerId}` })
      const result = this.store.upsert({ tenantId, dedupKey, source: channelId })
      contact = result.contact
      if (result.created) {
        this.store.appendEvent(tenantId, contact.id, 'imported', { via: 'inbound', channelId })
      }
      // 建档即关联渠道身份——否则下次入站又走一遍「找不到→新建」
      this.store.linkIdentity(tenantId, contact.id, channelId, customerId)
      this.store.appendEvent(tenantId, contact.id, 'identity_linked', { channelId, externalId: customerId })
    }

    const counters = this.store.recordInbound(contact.id, now)
    this.store.appendEvent(tenantId, contact.id, 'inbound', { conversationId: message.conversationId })

    const advanced = advanceOnInbound(contact.lifecycleStage)
    if (advanced !== contact.lifecycleStage) {
      this.store.updateStage(contact.id, advanced)
      this.store.appendEvent(tenantId, contact.id, 'stage_changed', {
        from: contact.lifecycleStage,
        to: advanced,
        reason: 'inbound',
      })
    }

    const score = computeScore({
      lifecycleStage: advanced,
      inboundCount: counters.inboundCount,
      outboundCount: counters.outboundCount,
      lastInboundAt: now,
      now,
    })
    this.store.updateScore(contact.id, score)

    const updated = this.store.get(contact.id)
    if (updated === undefined) throw new Error(`联系人 ${contact.id} 处理入站后读不到`)
    return updated
  }

  /**
   * 记一次外呼。
   *
   * @param contactId - 联系人 id。
   * @param now - 当前时间。
   * @throws {UnaddressableError} 联系人没有任何渠道身份。
   */
  onOutbound(contactId: string, now = new Date()): Contact {
    const contact = this.require(contactId)
    // 显式失败而不是静默跳过（Python 版实测教训 #4）
    if (!isAddressable(contact)) {
      this.store.appendEvent(contact.tenantId, contact.id, 'unaddressable', { at: now.toISOString() })
      throw new UnaddressableError(contactId)
    }

    const counters = this.store.recordOutbound(contactId, now)
    this.store.appendEvent(contact.tenantId, contactId, 'outbound', {})

    this.store.updateScore(
      contactId,
      computeScore({
        lifecycleStage: contact.lifecycleStage,
        inboundCount: counters.inboundCount,
        outboundCount: counters.outboundCount,
        ...(contact.lastInboundAt === undefined ? {} : { lastInboundAt: contact.lastInboundAt }),
        now,
      }),
    )
    return this.require(contactId)
  }

  /**
   * 变更生命周期阶段。
   *
   * @param contactId - 联系人 id。
   * @param to - 目标阶段。
   * @param options - 变更原因、联动的触达状态、是否强制。
   * @returns 更新后的联系人。
   * @throws {LifecycleError} 跃迁非法且未强制。
   */
  updateStage(
    contactId: string,
    to: LifecycleStage,
    options: { readonly reason?: string; readonly status?: LeadStatus; readonly force?: boolean } = {},
  ): Contact {
    const contact = this.require(contactId)
    const next = applyTransition(contact.lifecycleStage, to, options.force ?? false)
    if (next !== contact.lifecycleStage || options.status !== undefined) {
      this.store.updateStage(contactId, next, options.status)
      this.store.appendEvent(contact.tenantId, contactId, 'stage_changed', {
        from: contact.lifecycleStage,
        to: next,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(options.force === true ? { forced: true } : {}),
      })
      if (next === 'customer') {
        this.store.appendEvent(contact.tenantId, contactId, 'converted', {})
      }
    }
    return this.require(contactId)
  }

  /** 预检一次跃迁而不执行，供 UI 与工具在提示里说明原因。 */
  canTransition(contactId: string, to: LifecycleStage): string | undefined {
    return checkTransition(this.require(contactId).lifecycleStage, to)
  }

  /**
   * 关联渠道身份。
   *
   * @param contactId - 联系人 id。
   * @param channelId - 渠道。
   * @param externalId - 渠道侧用户标识。
   * @returns 更新后的联系人。
   * @throws {Error} 该渠道身份已属于另一个联系人。
   */
  linkIdentity(contactId: string, channelId: string, externalId: string): Contact {
    const contact = this.require(contactId)
    this.store.linkIdentity(contact.tenantId, contactId, channelId, externalId)
    this.store.appendEvent(contact.tenantId, contactId, 'identity_linked', { channelId, externalId })
    return this.require(contactId)
  }

  /** 添加时间线备注。 */
  addNote(contactId: string, note: string): Contact {
    const contact = this.require(contactId)
    this.store.appendEvent(contact.tenantId, contactId, 'scored', { note })
    return contact
  }

  /**
   * 按受众筛选取联系人。
   *
   * @param tenantId - 租户。
   * @param filter - 筛选条件。
   * @param limit - 候选集上限（防止全表加载）。
   * @returns 命中的联系人。
   */
  segment(tenantId: string, filter: AudienceFilter, limit = 10_000): readonly Contact[] {
    // 在内存里求值（RESEARCH.md §segment 取舍），先按上限取候选集
    return selectAudience(this.store.list(tenantId, limit, 0), filter)
  }

  /** 按 id 取联系人，不存在即抛错。 */
  require(contactId: string): Contact {
    const contact = this.store.get(contactId)
    if (contact === undefined) throw new Error(`联系人 ${contactId} 不存在`)
    return contact
  }
}
