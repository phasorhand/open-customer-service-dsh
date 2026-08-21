/**
 * 卡片协议 —— 实现为 dsh `defineTool` 的 `output.presentationMeta`，不自建协议层。
 *
 * 依据（research §2.3 / dsh-best-practices §B）：
 * - `render()` 给模型看摘要（省 context）
 * - `presentationMeta()` 给 UI 看完整投影，随 `tool/result` 事件持久化
 * - presenter 必须是**纯函数**：实时流式与历史回放共用同一份逻辑，天然不会不同步
 * - 读取端遇到未知/旧版本必须**软降级**，绝不抛错（回放不允许 crash）
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** 当前卡片协议版本。字段语义变更时 +1，读取端按版本软降级。 */
export const CARD_PROTOCOL_VERSION = 1

/** v1 卡型。新增卡型不需要升版本；改字段语义才需要。 */
export type CardType =
  | 'cs_reply'
  | 'contact_segment'
  | 'contact_profile'
  | 'knowledge_hit'
  | 'cadence_stats'
  | 'proposal_review'

/** 卡片上的一个动作。`requiresConfirm` 的动作在前端需二次确认。 */
export interface CardAction {
  readonly id: string
  readonly label: string
  readonly kind: 'per_item' | 'batch'
  readonly requiresConfirm: boolean
}

/** 卡片条目。`evidence` 是给人看的判定依据，与模型看到的 render 内容同源。 */
export interface CardItem {
  readonly id: string
  readonly title: string
  readonly evidence?: string
  readonly status?: string
  readonly link?: string
  readonly extra?: Readonly<Record<string, string | number | boolean>>
}

/** 一张卡片的完整投影。 */
export interface Card {
  readonly protocolVersion: number
  readonly type: CardType
  readonly title: string
  readonly summary: string
  /** 数据范围说明（例如「租户 default / 全部渠道」），让人能判断结果可信度。 */
  readonly scope?: string
  readonly items: readonly CardItem[]
  readonly actions?: readonly CardAction[]
}

/** 软降级卡片：读取端遇到无法识别的 meta 时展示它，而不是崩溃或静默丢弃。 */
export interface DegradedCard {
  readonly protocolVersion: number
  readonly type: 'degraded'
  readonly title: string
  readonly summary: string
}

/**
 * 构造卡片。集中一处保证 `protocolVersion` 不会漏写。
 *
 * @param input - 除版本号外的全部字段。
 * @returns 带版本号的不可变卡片。
 */
export function makeCard(input: Omit<Card, 'protocolVersion'>): Card {
  return { protocolVersion: CARD_PROTOCOL_VERSION, ...input }
}

/**
 * 把卡片转成 dsh 要求的 `JsonValue`。
 *
 * `presentationMeta` 的返回类型是 `JsonValue`，而我们的 `Card` 是只读接口——
 * 结构上兼容但 TS 不认，这里收口一次转换，避免每个工具各写一遍 `as`。
 *
 * @param card - 卡片。
 * @returns 可持久化的 JSON 值。
 */
export function cardToJson(card: Card): JsonValue {
  return card as unknown as JsonValue
}

/**
 * 从持久化的 `tool/result` meta 还原卡片。
 *
 * **不抛错**：任何形状不符（旧版本、字段缺失、被截断）都返回 {@link DegradedCard}，
 * 让历史会话仍然可读。这是 dsh「回放不允许 crash」纪律的落地。
 *
 * @param meta - `tool/result` 事件里的 presentationMeta。
 * @returns 卡片或降级卡片；完全不像卡片的返回 `undefined`（调用方跳过渲染）。
 */
export function parseCard(meta: unknown): Card | DegradedCard | undefined {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const raw = meta as Record<string, unknown>
  if (typeof raw['type'] !== 'string') return undefined

  const title = typeof raw['title'] === 'string' ? raw['title'] : '（无标题）'
  const summary = typeof raw['summary'] === 'string' ? raw['summary'] : title

  if (raw['protocolVersion'] !== CARD_PROTOCOL_VERSION || !Array.isArray(raw['items'])) {
    return {
      protocolVersion: CARD_PROTOCOL_VERSION,
      type: 'degraded',
      title,
      summary: `${summary}（该卡片由旧版本协议生成，仅显示摘要）`,
    }
  }

  const items = raw['items'].flatMap((entry): CardItem[] => {
    if (entry === null || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item['id'] !== 'string' || typeof item['title'] !== 'string') return []
    return [
      {
        id: item['id'],
        title: item['title'],
        ...(typeof item['evidence'] === 'string' ? { evidence: item['evidence'] } : {}),
        ...(typeof item['status'] === 'string' ? { status: item['status'] } : {}),
        ...(typeof item['link'] === 'string' ? { link: item['link'] } : {}),
      },
    ]
  })

  return {
    protocolVersion: CARD_PROTOCOL_VERSION,
    type: raw['type'] as CardType,
    title,
    summary,
    ...(typeof raw['scope'] === 'string' ? { scope: raw['scope'] } : {}),
    items,
    ...(Array.isArray(raw['actions']) ? { actions: parseActions(raw['actions']) } : {}),
  }
}

function parseActions(raw: readonly unknown[]): readonly CardAction[] {
  return raw.flatMap((entry): CardAction[] => {
    if (entry === null || typeof entry !== 'object') return []
    const action = entry as Record<string, unknown>
    if (typeof action['id'] !== 'string' || typeof action['label'] !== 'string') return []
    const kind = action['kind'] === 'batch' ? 'batch' : 'per_item'
    return [{ id: action['id'], label: action['label'], kind, requiresConfirm: action['requiresConfirm'] === true }]
  })
}
