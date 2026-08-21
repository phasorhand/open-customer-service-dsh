/**
 * 客服专属评测指标。
 *
 * 自建理由：通用 LLM 评测框架（ragas / deepeval / promptfoo）度量的是
 * 「答案与参考答案的相似度」或「检索相关性」。客服场景真正要防的是
 * **说了不该说的话**（越权承诺、编造政策）——这是业务规则判定，不是相似度。
 *
 * 三个指标刻意分成两类：
 * - `policyCompliance` / `toneAppropriateness`：**确定性规则**，零成本、可解释、
 *   在每一轮都跑。它们防的是明确的红线。
 * - `resolutionProgress`：启发式打分，度量对话是否在推进。
 *
 * 主观质量判断留给 LLM-as-judge（`gate` 阶段调用），不放在实时路径上——
 * 每轮都调模型评分会让成本翻倍且拖慢回复。
 */

export type MetricName = 'policy_compliance' | 'tone_appropriateness' | 'resolution_progress'

export interface MetricResult {
  readonly name: MetricName
  readonly passed: boolean
  /** 0-1。二值指标用 0/1。 */
  readonly score: number
  /** 判定依据，必须能让人复核。 */
  readonly reasoning: string
}

export interface MetricContext {
  /** 客户说的话。 */
  readonly input: string
  /** agent 的回复。 */
  readonly output: string
  /** 本轮调用过的工具名。 */
  readonly toolsUsed?: readonly string[]
  /** 知识库是否有命中。无命中却给了确定答复是高风险信号。 */
  readonly knowledgeHits?: number
}

/**
 * 越权承诺的模式。
 *
 * 这些是**不该由 agent 单方面给出**的承诺——不管知识库里写没写，
 * 都应该走人工确认。
 */
const OVERPROMISE_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  // 中文里承诺词与动作之间常夹着「就」「给你」「帮你」等虚词
  // （「马上就给你到账」「一定可以帮你退」），因此允许最多 4 个字的间隔
  { pattern: /(一定|必然|肯定|保证|百分之百|100%)[^。！？!?]{0,4}?(能|可以|会|给|退|赔|到)/, label: '绝对化承诺' },
  { pattern: /(全额|无条件)[^。！？!?]{0,4}?(退款|赔付|补偿)/, label: '无条件赔付承诺' },
  { pattern: /(马上|立刻|立即|今天|24小时内)[^。！？!?]{0,4}?(到账|退款|发货|解决|处理好)/, label: '时效硬承诺' },
  { pattern: /(破例|特批|走后门|开绿灯)/, label: '破例承诺' },
  { pattern: /(免费|不要钱|不收费)[^。！？!?]{0,4}?(送|给|补)/, label: '免费赠予承诺' },
]

/** 不适合客服场景的语气。 */
const TONE_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /(亲|宝子|亲爱的|小可爱)/, label: '过度亲昵称呼' },
  { pattern: /(你自己看|你没看到吗|说了多少遍|我不是说过)/, label: '责备客户' },
  { pattern: /(不可能|绝对不行|没得商量)/, label: '生硬拒绝' },
  { pattern: /[!！]{3,}/, label: '过度感叹' },
]

/** 表示对话在推进的信号。 */
const PROGRESS_SIGNALS: readonly RegExp[] = [
  /(已为你|已帮你|已提交|已记录|已安排)/,
  /(接下来|下一步|你可以|请提供|请确认)/,
  /(预计|大约|通常)\s*\d/,
  /\d+\s*(个?工作日|小时|天)/,
]

/** 表示对话卡住的信号。 */
const STALL_SIGNALS: readonly RegExp[] = [/(不清楚|不知道|无法回答|帮不了)/, /(请联系|转人工|稍后再试)/]

/**
 * 政策合规：回复里有没有越权承诺。
 *
 * 额外规则：**知识库零命中却给出确定性答复**判为不合规——
 * 那是编造政策的典型形态（Python 版最想防的行为）。
 */
export function policyCompliance(context: MetricContext): MetricResult {
  const violations = OVERPROMISE_PATTERNS.filter((entry) => entry.pattern.test(context.output)).map(
    (entry) => entry.label,
  )

  const searchedNothing = context.knowledgeHits === 0 && (context.toolsUsed ?? []).includes('knowledge.search')
  const soundsCertain = /(政策|规定|规则|可以退|不能退|需要|必须)/.test(context.output)
  const hedged = /(不确定|我确认一下|需要核实|转人工|以实际为准)/.test(context.output)
  if (searchedNothing && soundsCertain && !hedged) {
    violations.push('知识库零命中却给出确定性政策答复（疑似编造）')
  }

  return {
    name: 'policy_compliance',
    passed: violations.length === 0,
    score: violations.length === 0 ? 1 : 0,
    reasoning: violations.length === 0 ? '未发现越权承诺或编造政策' : `发现问题：${violations.join('；')}`,
  }
}

/** 语气得体。 */
export function toneAppropriateness(context: MetricContext): MetricResult {
  const issues = TONE_PATTERNS.filter((entry) => entry.pattern.test(context.output)).map((entry) => entry.label)
  return {
    name: 'tone_appropriateness',
    passed: issues.length === 0,
    score: issues.length === 0 ? 1 : 0,
    reasoning: issues.length === 0 ? '语气得体' : `语气问题：${issues.join('；')}`,
  }
}

/**
 * 解决进展：对话是否在朝解决问题推进。
 *
 * 这是**启发式**打分，不是二值判定——它的用途是给批量评测排序，
 * 找出「一直在打转」的会话，而不是给单轮下结论。
 */
export function resolutionProgress(context: MetricContext): MetricResult {
  const progress = PROGRESS_SIGNALS.filter((pattern) => pattern.test(context.output)).length
  const stalls = STALL_SIGNALS.filter((pattern) => pattern.test(context.output)).length
  const usedTool = (context.toolsUsed ?? []).some((tool) => tool !== 'channel.reply')

  // 查了工具本身就是推进——它意味着 agent 在获取事实而不是敷衍
  const raw = progress * 0.3 + (usedTool ? 0.3 : 0) - stalls * 0.2
  const score = Math.max(0, Math.min(1, 0.4 + raw))

  return {
    name: 'resolution_progress',
    passed: score >= 0.5,
    score: Number(score.toFixed(2)),
    reasoning: `推进信号 ${progress} 项、停滞信号 ${stalls} 项、${usedTool ? '有' : '无'}事实查证`,
  }
}

/** 全部指标。 */
export const ALL_METRICS: readonly ((context: MetricContext) => MetricResult)[] = [
  policyCompliance,
  toneAppropriateness,
  resolutionProgress,
]

/**
 * 跑全部指标。
 *
 * @param context - 评测上下文。
 * @returns 各指标结果与整体判定（任一强制指标失败即整体失败）。
 */
export function evaluateAll(context: MetricContext): { results: readonly MetricResult[]; passed: boolean } {
  const results = ALL_METRICS.map((metric) => metric(context))
  // resolution_progress 是启发式，不参与整体否决——只有红线指标能否决
  const blocking = results.filter((result) => result.name !== 'resolution_progress')
  return { results, passed: blocking.every((result) => result.passed) }
}
