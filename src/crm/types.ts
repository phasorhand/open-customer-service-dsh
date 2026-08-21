/**
 * CRM 领域模型。
 *
 * 核心不变量（RESEARCH.md）：
 * 1. **身份三分**——业务身份 / 渠道身份 / 会话身份分开，互不冒充
 * 2. **生命周期单调**——只能前进，回退需显式 force 且属 RED 风险档
 */

/** 漏斗阶段。前五个单调递进，后两个是终态出口。 */
export type LifecycleStage =
  | 'new'
  | 'engaged'
  | 'qualified'
  | 'opportunity'
  | 'customer'
  | 'disqualified'
  | 'churned'

/** 单调阶段的顺序。终态出口不在此列——它们可以从任意阶段进入。 */
export const STAGE_ORDER: readonly LifecycleStage[] = ['new', 'engaged', 'qualified', 'opportunity', 'customer']

/** 终态：进入后不再参与节奏，也不能再前进。 */
export const TERMINAL_STAGES: ReadonlySet<LifecycleStage> = new Set(['customer', 'disqualified', 'churned'])

/** 触达状态。与漏斗阶段正交——可自由变化，不受单调性约束。 */
export type LeadStatus =
  | 'not_contacted'
  | 'contacted'
  | 'replied'
  | 'in_progress'
  | 'unresponsive'
  | 'opted_out'
  | 'won'
  | 'lost'

/** 渠道身份：在某个渠道上如何找到这个人。 */
export interface ChannelIdentity {
  readonly channelId: string
  readonly externalId: string
  readonly linkedAt: Date
}

export interface Contact {
  readonly id: string
  readonly tenantId: string
  /** 业务去重键（email/phone 归一化）。租户内唯一。 */
  readonly dedupKey: string
  readonly name?: string
  readonly phone?: string
  readonly email?: string
  readonly company?: string

  readonly lifecycleStage: LifecycleStage
  readonly leadStatus: LeadStatus
  /** 0-100 综合意向分。 */
  readonly score: number

  readonly owner?: string
  readonly source?: string
  readonly tags: readonly string[]
  readonly attributes: Readonly<Record<string, string | number | boolean>>

  /** 渠道身份列表。**为空即 unaddressable**，外呼必须显式失败。 */
  readonly identities: readonly ChannelIdentity[]

  readonly lastInboundAt?: Date
  readonly lastOutboundAt?: Date
  readonly convertedAt?: Date
  readonly dealValue?: number
  readonly lostReason?: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** 写入侧载荷。`undefined` 字段表示「不改动」，不是「清空」。 */
export interface ContactUpsert {
  readonly tenantId: string
  readonly dedupKey: string
  readonly name?: string
  readonly phone?: string
  readonly email?: string
  readonly company?: string
  readonly lifecycleStage?: LifecycleStage
  readonly leadStatus?: LeadStatus
  readonly owner?: string
  readonly source?: string
  readonly tags?: readonly string[]
  readonly attributes?: Readonly<Record<string, string | number | boolean>>
}

/** 追加式时间线事件。 */
export type ContactEventKind =
  | 'imported'
  | 'stage_changed'
  | 'status_changed'
  | 'scored'
  | 'inbound'
  | 'outbound'
  | 'identity_linked'
  | 'enrolled'
  | 'exited'
  | 'converted'
  | 'unaddressable'

export interface ContactEvent {
  readonly id: string
  readonly tenantId: string
  readonly contactId: string
  readonly kind: ContactEventKind
  readonly payload: Readonly<Record<string, unknown>>
  readonly at: Date
}

/** 分群筛选的比较操作符。 */
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists'

export interface FilterRule {
  /** 字段名。支持 `attributes.xxx` 访问自定义属性。 */
  readonly field: string
  readonly operator: FilterOperator
  readonly value?: unknown
}

/** 受众筛选。`rules` 之间是 AND；`contactIds` 是显式并集。 */
export interface AudienceFilter {
  readonly rules?: readonly FilterRule[]
  readonly contactIds?: readonly string[]
}

/** 一条导入错误。`line` 是 1-based 的**原始文件行号**，方便运营定位。 */
export interface ImportRowError {
  readonly line: number
  readonly error: string
  readonly raw: string
}

export interface ImportReport {
  readonly total: number
  readonly imported: number
  readonly updated: number
  readonly skipped: number
  readonly errors: readonly ImportRowError[]
  /** 错误过多时只保留前 N 条，此标记告诉调用方还有更多。 */
  readonly errorsTruncated: boolean
}

/**
 * 判断联系人是否可触达。
 *
 * 没有任何渠道身份的联系人无法被外呼——这必须**显式失败**，
 * 而不是在投递环节静默跳过（Python 版实测教训 #4）。
 *
 * @param contact - 联系人。
 * @returns 是否至少有一个渠道身份。
 */
export function isAddressable(contact: Contact): boolean {
  return contact.identities.length > 0
}

/**
 * 归一化业务去重键。
 *
 * 邮箱小写去空白；手机号只保留数字（去掉 +86、空格、横线）。
 * 两者都没有时用调用方给的兜底键（如渠道 external_id）。
 *
 * @param input - 邮箱 / 手机 / 兜底键。
 * @returns 归一化后的去重键。
 * @throws {Error} 三者皆空——无法建立稳定身份。
 */
export function normalizeDedupKey(input: {
  readonly email?: string
  readonly phone?: string
  readonly fallback?: string
}): string {
  const email = input.email?.trim().toLowerCase()
  if (email !== undefined && email !== '') return `email:${email}`

  const digits = input.phone?.replace(/\D/g, '')
  if (digits !== undefined && digits !== '') {
    // 去掉中国大陆国际区号，让 +8613800138000 与 13800138000 归一
    const local = digits.length > 11 && digits.startsWith('86') ? digits.slice(2) : digits
    return `phone:${local}`
  }

  const fallback = input.fallback?.trim()
  if (fallback !== undefined && fallback !== '') return `ref:${fallback}`

  throw new Error('无法归一化去重键：email / phone / fallback 至少要有一个')
}
