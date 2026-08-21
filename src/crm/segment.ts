/**
 * 分群筛选：`AudienceFilter` 的求值。
 *
 * 在内存里对已加载的联系人求值，而不是翻译成 SQL。取舍：
 * - 自定义属性存在 JSON 列里，翻 SQL 需要 `json_extract` 且无法用索引
 * - 受众规模在自托管场景是万级，全量加载可接受
 * - 规则语义在一处实现，不会出现「预览走内存、执行走 SQL」两套行为不一致
 *
 * 规模超出后的迁移路径：把高频字段（stage/status/score）下推成 SQL 前置过滤，
 * 属性类规则仍在内存里做。
 */

import type { AudienceFilter, Contact, FilterOperator, FilterRule } from './types.js'

/**
 * 判断一个联系人是否命中筛选。
 *
 * `rules` 之间是 AND；`contactIds` 是**显式并集**（列在里面的直接命中，
 * 不受 rules 约束——运营手动圈人时不该被规则再筛一遍）。
 *
 * @param contact - 待判定的联系人。
 * @param filter - 筛选条件。
 * @returns 是否命中。
 */
export function matchesFilter(contact: Contact, filter: AudienceFilter): boolean {
  if (filter.contactIds?.includes(contact.id) === true) return true

  const rules = filter.rules ?? []
  // 空筛选 = 全量。但若同时给了 contactIds 且不含此人，说明是「只要这些人」
  if (rules.length === 0) return filter.contactIds === undefined || filter.contactIds.length === 0

  return rules.every((rule) => matchesRule(contact, rule))
}

/**
 * 求值单条规则。
 *
 * 未知字段或未知操作符**返回 false**（不命中）而不是抛错——
 * 一条写错的规则不应该让整个分群预览 500。
 *
 * @param contact - 联系人。
 * @param rule - 规则。
 * @returns 是否命中。
 */
export function matchesRule(contact: Contact, rule: FilterRule): boolean {
  const actual = readField(contact, rule.field)
  return compare(actual, rule.operator, rule.value)
}

/**
 * 读取字段值。支持 `attributes.xxx` 访问自定义属性。
 *
 * @param contact - 联系人。
 * @param field - 字段路径。
 * @returns 字段值；不存在返回 `undefined`。
 */
export function readField(contact: Contact, field: string): unknown {
  if (field.startsWith('attributes.')) {
    return contact.attributes[field.slice('attributes.'.length)]
  }
  switch (field) {
    case 'id':
      return contact.id
    case 'name':
      return contact.name
    case 'phone':
      return contact.phone
    case 'email':
      return contact.email
    case 'company':
      return contact.company
    case 'lifecycle_stage':
    case 'lifecycleStage':
      return contact.lifecycleStage
    case 'lead_status':
    case 'leadStatus':
      return contact.leadStatus
    case 'score':
      return contact.score
    case 'owner':
      return contact.owner
    case 'source':
      return contact.source
    case 'tags':
      return contact.tags
    case 'last_inbound_at':
    case 'lastInboundAt':
      return contact.lastInboundAt?.getTime()
    case 'last_outbound_at':
    case 'lastOutboundAt':
      return contact.lastOutboundAt?.getTime()
    case 'addressable':
      return contact.identities.length > 0
    default:
      return undefined
  }
}

function compare(actual: unknown, operator: FilterOperator, expected: unknown): boolean {
  switch (operator) {
    case 'exists':
      // `exists: false` 用于「没有该属性」的筛选
      return expected === false ? actual === undefined : actual !== undefined
    case 'eq':
      return looseEquals(actual, expected)
    case 'ne':
      return !looseEquals(actual, expected)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareOrdered(actual, operator, expected)
    case 'in':
      return Array.isArray(expected) && expected.some((item) => looseEquals(actual, item))
    case 'contains':
      return containsValue(actual, expected)
    default:
      return false
  }
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true
  // 数字与其字符串形式视作相等——JSON 里的筛选条件常被写成字符串
  if (typeof actual === 'number' && typeof expected === 'string') return String(actual) === expected
  if (typeof actual === 'string' && typeof expected === 'number') return actual === String(expected)
  return false
}

function compareOrdered(actual: unknown, operator: 'gt' | 'gte' | 'lt' | 'lte', expected: unknown): boolean {
  const left = toNumber(actual)
  const right = toNumber(expected)
  if (left === undefined || right === undefined) return false
  switch (operator) {
    case 'gt':
      return left > right
    case 'gte':
      return left >= right
    case 'lt':
      return left < right
    case 'lte':
      return left <= right
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, expected))
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
  return false
}

/**
 * 对一批联系人求值。
 *
 * @param contacts - 候选集。
 * @param filter - 筛选条件。
 * @returns 命中的联系人，保持输入顺序。
 */
export function selectAudience(contacts: readonly Contact[], filter: AudienceFilter): readonly Contact[] {
  return contacts.filter((contact) => matchesFilter(contact, filter))
}
