/**
 * 技能的 OpenCS 侧语义。
 *
 * dsh 的 `SkillSummary` 只有通用字段（name/description/invocation）。
 * 以下三个是**路由语义**，由 SKILL.md 的 frontmatter 提供，薄封装负责解析。
 */

/** 默认优先级。数值越大越靠前，取中间值方便双向调整。 */
export const DEFAULT_PRIORITY = 50

/** 默认路由目标：主客服回复流程。 */
export const DEFAULT_ROUTING = 'cs_reply'

/** 一条技能的完整形态（索引 + 正文）。 */
export interface LoadedSkill {
  readonly name: string
  readonly description: string
  /** Markdown 正文，Round 2 注入 system prompt。 */
  readonly content: string
  /** 索引排序权重，越大越靠前。 */
  readonly priority: number
  /** 由哪个 worker / subagent 处理。 */
  readonly routing: string
  /** 给模型做技能选择的意图线索。 */
  readonly intentSignals: readonly string[]
}

/** 技能库端口。工具层与 prompt 注入层只认这个接口。 */
export interface SkillPort {
  /**
   * 构建紧凑索引，注入 Round 1 的 system prompt。
   *
   * 索引只含 name / description / 意图线索，**不含正文**——
   * 这是两轮选择法的成本控制点。
   *
   * @returns 可直接嵌入 prompt 的文本；无技能时返回空串。
   */
  buildIndex(): Promise<string>

  /**
   * 按名字加载技能正文，注入 Round 2 的 system prompt。
   *
   * @param names - Round 1 选出的技能名。
   * @returns 存在的技能；不存在的名字被**静默跳过**（模型可能幻觉出不存在的技能名，
   *   这不该让整轮对话失败）。
   */
  load(names: readonly string[]): Promise<readonly LoadedSkill[]>

  /** 列出全部技能（管理端用）。 */
  list(): Promise<readonly LoadedSkill[]>
}

/**
 * 从 frontmatter 解析 OpenCS 的路由字段。
 *
 * **字段位置**：必须写在 frontmatter 的 `metadata:` 之下。这是 dsh 的约定——
 * `dsh-skill-filesystem` 只识别 `name` / `description` / `whenToUse` /
 * `metadata` / 两个 invocation 开关，其余顶层键一律忽略。`metadata` 是它
 * 留给下游的开放扩展点。
 *
 * ```yaml
 * ---
 * name: refund-escalation
 * description: 处理退款请求
 * metadata:
 *   priority: 80
 *   routing: cs_reply
 *   intent_signals: [想退款, 退货]
 * ---
 * ```
 *
 * 全部字段都可缺省——运营写 SKILL.md 时不该被必填字段绊住。
 *
 * @param metadata - dsh 解析出的 `metadata` 对象。
 * @param whenToUse - dsh 原生的 `whenToUse` 字段，作为意图线索的兜底来源。
 * @returns 归一化后的路由语义。
 */
export function parseRoutingMeta(
  metadata: Readonly<Record<string, unknown>> | undefined,
  whenToUse?: string,
): {
  priority: number
  routing: string
  intentSignals: readonly string[]
} {
  const priority = Number(metadata?.['priority'])
  const routing = metadata?.['routing']
  const signals = metadata?.['intent_signals'] ?? metadata?.['intentSignals']
  const parsed = normalizeSignals(signals)

  return {
    priority: Number.isFinite(priority) ? priority : DEFAULT_PRIORITY,
    routing: typeof routing === 'string' && routing !== '' ? routing : DEFAULT_ROUTING,
    // 没写 intent_signals 时退回 dsh 原生的 whenToUse，避免索引里缺少路由线索
    intentSignals: parsed.length > 0 ? parsed : normalizeSignals(whenToUse),
  }
}

function normalizeSignals(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((s) => s.trim())
  }
  // 允许写成逗号分隔的单行字符串——运营手写 YAML 时常见
  if (typeof raw === 'string') {
    return raw
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
  }
  return []
}
