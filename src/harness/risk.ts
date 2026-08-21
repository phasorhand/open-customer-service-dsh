/**
 * 六档风险分级 —— Python 版 `ActionGuard` 的等价物，重写为「工具的静态声明 + guard 统一裁决」。
 *
 * 设计取舍（spec §4.3）：档位不由模型决定，也不由工具运行时计算，而是**注册表里的静态事实**。
 * 未登记的工具落到 `ORANGE_C`（保守档，需人工确认）——新增工具忘记登记时会走审批而非放行。
 */

export enum RiskTier {
  /** 只读。知识检索、联系人查询。 */
  GREEN = 0,
  /** 低风险写入。备注、结构化记忆。 */
  YELLOW = 1,
  /** 模板消息（无 LLM 自由文本），受频控。 */
  ORANGE_A = 2,
  /** 节奏外呼（LLM 组稿），受频控 + 静默时段 + 事后审计。 */
  ORANGE_B = 3,
  /** 面向客户的自由文本回复。默认走人工确认。 */
  ORANGE_C = 4,
  /** 不可逆商业动作。成单标记、写外部 CRM。 */
  RED = 5,
}

/** 未登记工具的兜底档位：保守，走人工确认。 */
export const DEFAULT_TIER = RiskTier.ORANGE_C

/**
 * 工具 → 风险档。
 *
 * 新增工具必须在此登记，否则落 {@link DEFAULT_TIER}。
 * `tests/unit/risk.test.ts` 断言每个已注册工具都在表内。
 */
export const RISK_TIERS: Readonly<Record<string, RiskTier>> = Object.freeze({
  // GREEN — 只读
  'knowledge.search': RiskTier.GREEN,
  'contact.get': RiskTier.GREEN,
  'contact.segment_preview': RiskTier.GREEN,
  'crm.get_order': RiskTier.GREEN,

  // YELLOW — 低风险写入
  'memory.write_l2': RiskTier.YELLOW,
  'contact.add_note': RiskTier.YELLOW,
  'evolution.propose': RiskTier.YELLOW,

  // ORANGE_A — 模板消息
  'channel.send_template': RiskTier.ORANGE_A,

  // ORANGE_B — 节奏外呼
  'nurture.deliver': RiskTier.ORANGE_B,

  // ORANGE_C — 自由文本回复
  'channel.reply': RiskTier.ORANGE_C,

  // RED — 不可逆商业动作
  'contact.update_stage': RiskTier.RED,
  'contact.mark_won': RiskTier.RED,
  'crm.write_external': RiskTier.RED,
})

/**
 * 查询工具的风险档。
 *
 * @param toolName - 工具名。
 * @returns 登记的档位，未登记返回 {@link DEFAULT_TIER}。
 */
export function tierOf(toolName: string): RiskTier {
  return RISK_TIERS[toolName] ?? DEFAULT_TIER
}

/** 档位的中文名，用于 deny/ask 的 reason 文案与审计日志。 */
export const TIER_LABEL: Readonly<Record<RiskTier, string>> = Object.freeze({
  [RiskTier.GREEN]: 'GREEN(只读)',
  [RiskTier.YELLOW]: 'YELLOW(低风险写入)',
  [RiskTier.ORANGE_A]: 'ORANGE_A(模板消息)',
  [RiskTier.ORANGE_B]: 'ORANGE_B(节奏外呼)',
  [RiskTier.ORANGE_C]: 'ORANGE_C(自由文本回复)',
  [RiskTier.RED]: 'RED(不可逆动作)',
})
