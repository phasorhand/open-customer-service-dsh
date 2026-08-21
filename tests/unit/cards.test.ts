import { describe, expect, it } from 'vitest'

import { CARD_PROTOCOL_VERSION, cardToJson, makeCard, parseCard } from '../../src/harness/cards.js'

/** `cardToJson` 返回 dsh 的 `JsonValue`（联合类型，不可展开）；测试里需要普通对象形态。 */
const asRecord = (card: unknown): Record<string, unknown> => card as Record<string, unknown>

const VALID = makeCard({
  type: 'knowledge_hit',
  title: '命中 2 条',
  summary: '退款政策相关条款',
  scope: '租户 default',
  items: [
    { id: 'a', title: '售后 / 退款政策', evidence: '7 天无理由' },
    { id: 'b', title: '售后 / 超时规则', evidence: '15 天内仅质量问题' },
  ],
  actions: [{ id: 'open', label: '查看原文', kind: 'per_item', requiresConfirm: false }],
})

describe('makeCard', () => {
  it('自动带上当前协议版本', () => {
    expect(VALID.protocolVersion).toBe(CARD_PROTOCOL_VERSION)
  })
})

describe('parseCard · 正常路径', () => {
  it('往返一致', () => {
    const parsed = parseCard(JSON.parse(JSON.stringify(cardToJson(VALID))))
    expect(parsed).toMatchObject({
      protocolVersion: CARD_PROTOCOL_VERSION,
      type: 'knowledge_hit',
      title: '命中 2 条',
      scope: '租户 default',
    })
    expect(parsed && 'items' in parsed ? parsed.items : []).toHaveLength(2)
  })

  it('保留 actions 的 requiresConfirm 语义', () => {
    const parsed = parseCard(cardToJson(VALID))
    const actions = parsed && 'actions' in parsed ? (parsed.actions ?? []) : []
    expect(actions[0]).toEqual({ id: 'open', label: '查看原文', kind: 'per_item', requiresConfirm: false })
  })
})

describe('parseCard · 软降级（回放不允许 crash）', () => {
  it('旧协议版本降级为摘要卡而非抛错', () => {
    const old = { ...asRecord(cardToJson(VALID)), protocolVersion: 0 }
    const parsed = parseCard(old)
    expect(parsed?.type).toBe('degraded')
    expect(parsed?.summary).toContain('旧版本协议')
  })

  it('items 缺失降级', () => {
    const parsed = parseCard({ protocolVersion: CARD_PROTOCOL_VERSION, type: 'cs_reply', title: 'x' })
    expect(parsed?.type).toBe('degraded')
  })

  it('未来协议版本也降级（向前兼容）', () => {
    const parsed = parseCard({ ...asRecord(cardToJson(VALID)), protocolVersion: CARD_PROTOCOL_VERSION + 99 })
    expect(parsed?.type).toBe('degraded')
  })

  it('无标题时用占位符，不抛错', () => {
    const parsed = parseCard({ protocolVersion: 0, type: 'cs_reply' })
    expect(parsed?.title).toBe('（无标题）')
  })

  it('items 里的坏条目被跳过，好条目保留', () => {
    const parsed = parseCard({
      protocolVersion: CARD_PROTOCOL_VERSION,
      type: 'cs_reply',
      title: 't',
      summary: 's',
      items: [{ id: 'ok', title: '好的' }, null, { title: '缺 id' }, 42],
    })
    expect(parsed && 'items' in parsed ? parsed.items : []).toEqual([{ id: 'ok', title: '好的' }])
  })

  it('actions 里的坏条目被跳过', () => {
    const parsed = parseCard({
      protocolVersion: CARD_PROTOCOL_VERSION,
      type: 'cs_reply',
      title: 't',
      summary: 's',
      items: [],
      actions: [{ id: 'a', label: 'A' }, { label: '缺 id' }, 'nope'],
    })
    const actions = parsed && 'actions' in parsed ? (parsed.actions ?? []) : []
    expect(actions).toEqual([{ id: 'a', label: 'A', kind: 'per_item', requiresConfirm: false }])
  })

  it.each([[null], [undefined], [42], ['字符串'], [[1, 2]], [{}], [{ type: 7 }]])(
    '完全不像卡片的输入返回 undefined：%s',
    (input) => {
      expect(parseCard(input)).toBeUndefined()
    },
  )
})

describe('parseCard · 纯函数性', () => {
  it('同输入两次调用结果深相等', () => {
    const meta = cardToJson(VALID)
    expect(parseCard(meta)).toEqual(parseCard(meta))
  })
})
