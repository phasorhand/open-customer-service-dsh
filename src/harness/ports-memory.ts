/**
 * 端口的内存实现：离线冒烟、单测与 P1 阶段使用。
 *
 * 纪律（教训 #5）：与真实实现**共用同一份 interface**（`ports.ts`），
 * 接口变更会同时打断两边的类型检查，不会出现 mock 悄悄漂移。
 */

import type {
  DeliveryResult,
  HarnessPorts,
  KnowledgeHit,
  KnowledgePort,
  OrderInfo,
  OrderPort,
  OutboundPort,
} from './ports.js'

/** 内存知识库：朴素子串匹配，够 P1 冒烟用；P3 换 FTS5 store。 */
export class InMemoryKnowledge implements KnowledgePort {
  constructor(private readonly chunks: readonly (KnowledgeHit & { readonly tenantId: string })[]) {}

  async search(tenantId: string, query: string, limit: number): Promise<readonly KnowledgeHit[]> {
    const needle = query.trim()
    if (needle === '') return []
    const scored = this.chunks
      .filter((chunk) => chunk.tenantId === tenantId)
      .map((chunk) => ({ chunk, score: score(chunk, needle) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    return scored.map(({ chunk }) => ({
      chunkId: chunk.chunkId,
      sourceFile: chunk.sourceFile,
      headingPath: chunk.headingPath,
      content: chunk.content,
    }))
  }
}

/**
 * 匹配打分：标题命中权重高于正文，逐字命中累加。
 *
 * 中文没有词边界，用「查询串整体 + 逐字」两级匹配，避免完全命中不了。
 */
function score(chunk: KnowledgeHit, needle: string): number {
  let total = 0
  if (chunk.headingPath.includes(needle)) total += 10
  if (chunk.content.includes(needle)) total += 5
  for (const char of new Set(needle)) {
    if (char.trim() === '') continue
    if (chunk.headingPath.includes(char)) total += 2
    if (chunk.content.includes(char)) total += 1
  }
  return total
}

/** 内存订单表。 */
export class InMemoryOrders implements OrderPort {
  constructor(private readonly orders: readonly (OrderInfo & { readonly tenantId: string })[]) {}

  async getOrder(tenantId: string, orderId: string): Promise<OrderInfo | undefined> {
    return this.orders.find((order) => order.tenantId === tenantId && order.orderId === orderId)
  }
}

/** 冒烟与单测用的示例知识库。 */
export const SAMPLE_KNOWLEDGE: readonly (KnowledgeHit & { readonly tenantId: string })[] = [
  {
    tenantId: 'default',
    chunkId: 'kb-refund-1',
    sourceFile: 'refund.md',
    headingPath: '售后 / 退款政策',
    content: '签收后 7 天内可无理由退款，需商品完好且配件齐全。超过 7 天但在 15 天内的，仅质量问题可退。退款原路返回，1-3 个工作日到账。',
  },
  {
    tenantId: 'default',
    chunkId: 'kb-invoice-1',
    sourceFile: 'invoice.md',
    headingPath: '财务 / 发票开具',
    content: '订单完成后可在订单详情页申请开票，电子发票 48 小时内开具并发送到下单邮箱。专用发票需提供开票资质，人工审核 3 个工作日。',
  },
  {
    tenantId: 'default',
    chunkId: 'kb-logistics-1',
    sourceFile: 'logistics.md',
    headingPath: '物流 / 配送时效',
    content: '现货商品 48 小时内发货，江浙沪次日达，其他地区 2-4 天。预售商品按商品页标注的发货时间为准。节假日顺延。',
  },
]

/** 冒烟与单测用的示例订单。 */
export const SAMPLE_ORDERS: readonly (OrderInfo & { readonly tenantId: string })[] = [
  {
    tenantId: 'default',
    orderId: 'ord-10086',
    status: '已发货',
    amount: 299,
    currency: 'CNY',
    placedAt: '2026-08-18T10:24:00+08:00',
  },
]

/**
 * 内存出站端口：把投递记录在数组里，供测试断言「发了什么」。
 *
 * 与真实渠道共用 `OutboundPort` 接口，因此接口变更会同时打断两边（教训 #5）。
 */
export class RecordingOutbound implements OutboundPort {
  readonly delivered: { readonly channelId: string; readonly conversationId: string; readonly customerId: string; readonly text: string }[] = []

  /**
   * @param failWith - 设置后所有投递都失败，用于测试失败分支。
   */
  constructor(private readonly failWith?: string) {}

  async deliver(
    target: { readonly channelId: string; readonly conversationId: string; readonly customerId: string },
    text: string,
  ): Promise<DeliveryResult> {
    if (this.failWith !== undefined) return { ok: false, error: this.failWith, retryable: false }
    this.delivered.push({ ...target, text })
    return { ok: true, externalMessageId: `mem-${this.delivered.length}` }
  }
}

/** 构造一套内存端口。 */
export function memoryPorts(
  knowledge: readonly (KnowledgeHit & { readonly tenantId: string })[] = SAMPLE_KNOWLEDGE,
  orders: readonly (OrderInfo & { readonly tenantId: string })[] = SAMPLE_ORDERS,
  outbound: OutboundPort = new RecordingOutbound(),
): HarnessPorts {
  return { knowledge: new InMemoryKnowledge(knowledge), orders: new InMemoryOrders(orders), outbound }
}
