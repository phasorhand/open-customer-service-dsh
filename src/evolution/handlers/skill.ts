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

/** 文件名用名最长长度（含 proposal- 前缀）。 */
const NAME_MAX = 24

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

export function buildSkillDraft(input: {
  readonly dimension: string
  readonly title: string
  readonly rationale: string
  readonly badcaseText: string
}): SkillDraft {
  const { title, rationale, badcaseText } = input
  const trimmedTitle = title.trim()
  const slug = trimmedTitle
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
  const name = `proposal-${slug || 'untitled'}`
  const signals = deriveIntentSignals(trimmedTitle)

  const content = [
    '---',
    `name: ${name}`,
    `description: ${trimmedTitle}`,
    'metadata:',
    `  priority: ${PROPOSAL_PRIORITY}`,
    `  routing: ${PROPOSAL_ROUTING}`,
    ...(signals.length > 0 ? ['  intent_signals:', ...signals.map((s) => `    - ${s}`)] : []),
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
