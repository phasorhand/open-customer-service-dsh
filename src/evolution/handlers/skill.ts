/**
 * 技能自策展 Handler：把低分会话的证据（extractEvidence 产出）转成技能草案，
 * 写入 skills/proposals/ 待审目录。生效由审批 + 迁移完成，本 handler 只做草案生成。
 *
 * 草案必须能被 dsh-skill-filesystem 加载（对齐 skills 目录下现有 SKILL.md 的真实 frontmatter）：
 * name / description 在顶层，priority / routing / intent_signals 都在 metadata 之下。
 * 校验逻辑见 src/skills/types.ts 的 parseRoutingMeta。
 */

export interface SkillDraft {
  readonly name: string
  readonly content: string
}

/** 提案技能优先级：现存技能最高 80，提案取 90，保证命中该意图时优先入选。 */
const PROPOSAL_PRIORITY = 90

/** 提案路由到主客服回复流程（对齐现有 SKILL.md 的 routing: cs_reply / DEFAULT_ROUTING）。 */
const PROPOSAL_ROUTING = 'cs_reply'

/** 文件名用名最长长度（截断的是 slug，不含 proposal- 前缀）。 */
const NAME_MAX = 24

/**
 * 领域词 → ASCII slug（拼音或英文译名），用于把中文标题转成 kebab-case 技能名。
 *
 * dsh 技能名只接受 `[a-z0-9]+(?:-[a-z0-9]+)*`（见 dsh-skill 的 isSkillName），
 * 不符合的名字在发现期被静默丢弃——中文标题不能直接进名字，词典命中的领域词
 * 换成 ASCII slug 保留语义，未命中的中文在 slug 里一律剥离（description /
 * intent_signals 仍可自由含中文）。
 */
const DOMAIN_SLUGS: Readonly<Record<string, string>> = {
  退款: 'tuikuan',
  退货: 'tuihuo',
  订单: 'order',
  查询: 'query',
  发票: 'invoice',
  物流: 'logistics',
  承诺: 'commitment',
  客户: 'customer',
  政策: 'policy',
  场景: 'scenario',
  不要: 'avoid',
  先: 'first',
  调: 'call',
  工具: 'tool',
  全额: 'full',
}

/** 词典条目按词长降序，保证长词优先命中（如「订单」先于可能出现的「单」）。 */
const SLUG_ENTRIES: readonly (readonly [string, string])[] = Object.entries(DOMAIN_SLUGS).sort(
  (a, b) => b[0].length - a[0].length,
)

/**
 * 中文标题 → ASCII kebab-case slug。
 *
 * 词典命中的中文词替换为带分隔符的 ASCII slug，残留的非 ASCII（未命中词典的中文）
 * 与标点空格统一折叠成 `-`，再截断到 NAME_MAX。无任何可保留字符时返回空串，
 * 由调用方回退为 `untitled`。
 */
function slugifyTitle(title: string): string {
  let out = title.toLowerCase()
  for (const [word, slug] of SLUG_ENTRIES) {
    out = out.split(word).join(`-${slug}-`)
  }
  return out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '')
}

/**
 * 从标题提取意图信号。
 *
 * 标题常形如「退款场景不要承诺全额」→ 在第一个动作/结论词处截断，
 * 取前面的主题段 →「退款」。截断失败时退回标题前 12 字，保证信号非空。
 */
function deriveIntentSignals(title: string): readonly string[] {
  const trimmed = title.trim()
  if (trimmed === '') return []
  const topic = trimmed.split(/场景|处理|咨询|查询|时候|时[，,、]?|应该|需要|要先|先|不要|禁止|请|务必/)[0]?.trim() ?? ''
  if (topic.length > 0 && topic.length <= 12) return [topic]
  return [trimmed.slice(0, 12)]
}

/**
 * 把标量包进双引号并转义内嵌的 `"` 与 `\`，保证标题/信号含 `: ` 等特殊字符时
 * frontmatter 也始终可被 YAML 解析（dsh-skill-filesystem 对解析失败的草案会静默忽略）。
 */
const yamlQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export function buildSkillDraft(input: {
  readonly title: string
  readonly rationale: string
  readonly badcaseText: string
}): SkillDraft {
  const { title, rationale, badcaseText } = input
  const trimmedTitle = title.trim()
  const name = `proposal-${slugifyTitle(trimmedTitle) || 'untitled'}`
  const signals = deriveIntentSignals(trimmedTitle)

  const content = [
    '---',
    `name: ${yamlQuote(name)}`,
    `description: ${yamlQuote(trimmedTitle)}`,
    'metadata:',
    `  priority: ${PROPOSAL_PRIORITY}`,
    `  routing: ${PROPOSAL_ROUTING}`,
    ...(signals.length > 0 ? ['  intent_signals:', ...signals.map((s) => `    - ${yamlQuote(s)}`)] : []),
    '---',
    '',
    `# ${trimmedTitle}`,
    '',
    '## 行为约束',
    '',
    `- ${rationale}`,
    `- 坏例：${badcaseText}`,
    `- 反制：${rationale}`,
    '',
  ].join('\n')

  return { name, content }
}
