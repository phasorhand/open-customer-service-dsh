/**
 * 端口（port）定义：dsh 插件层与业务实现之间的接缝。
 *
 * 纪律（spec §8、教训 #5）：**mock 与真实实现共用同一份 interface**。
 * P1 用内存桩实现这些端口，P3/P4/P5 换成真实 store，插件层代码零改动。
 */

/** 知识库检索命中。 */
export interface KnowledgeHit {
  readonly chunkId: string
  readonly sourceFile: string
  /** 标题层级路径，如 `售后 / 退款政策 / 超时规则`。 */
  readonly headingPath: string
  readonly content: string
}

/** 知识库检索端口。P3 由 FTS5 store 实现。 */
export interface KnowledgePort {
  /**
   * 全文检索。
   *
   * @param tenantId - 租户。
   * @param query - 查询词。
   * @param limit - 最多返回条数。
   * @returns 按相关度排序的命中，可为空数组（不抛错）。
   */
  search(tenantId: string, query: string, limit: number): Promise<readonly KnowledgeHit[]>
}

/** 订单信息。字段刻意保持最小，真实 CRM 字段由 `attributes` 透传。 */
export interface OrderInfo {
  readonly orderId: string
  readonly status: string
  readonly amount: number
  readonly currency: string
  readonly placedAt: string
  readonly attributes?: Readonly<Record<string, string>>
}

/** 订单查询端口。P4 由 CRM 适配器实现。 */
export interface OrderPort {
  /**
   * 按订单号查询。
   *
   * @param tenantId - 租户。
   * @param orderId - 订单号。
   * @returns 订单信息；不存在返回 `undefined`（不抛错——查不到是正常业务结果）。
   */
  getOrder(tenantId: string, orderId: string): Promise<OrderInfo | undefined>
}

/** 插件层依赖的全部端口。 */
export interface HarnessPorts {
  readonly knowledge: KnowledgePort
  readonly orders: OrderPort
}
