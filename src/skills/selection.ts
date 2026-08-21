/**
 * 两轮技能选择 —— Python 版已验证有效的 context 成本控制手段。
 *
 * Round 1：注入**紧凑索引**（只有 name/description/意图线索）→ 模型输出 `[SKILLS: a, b]`
 * Round 2：只注入被选中技能的**正文** → 生成最终回复
 *
 * 为什么不一次性注入全部技能正文：话术库会长到几十上百条，全量注入
 * 每轮都要付一次完整 context 成本，且大量无关内容会稀释模型注意力。
 */

/** 模型声明选中技能的标记。大小写不敏感，允许中英文冒号与全半角括号。 */
const SKILLS_TAG = /\[\s*SKILLS?\s*[:：]\s*([^\]]*)\]/i

/** Round 1 注入的指令。要求模型先声明用哪些技能，再作答。 */
export function round1Instruction(index: string): string {
  return [
    '可用的客服话术（技能）目录如下。先判断这轮对话需要用到哪些，',
    `在回复的**第一行**用 \`[SKILLS: 名称1, 名称2]\` 声明（不需要任何技能就写 \`[SKILLS: ]\`），`,
    '然后再正常作答。',
    '',
    index,
  ].join('\n')
}

/** Round 2 注入的技能正文。 */
export function round2Instruction(skills: readonly { name: string; content: string }[]): string {
  if (skills.length === 0) return ''
  const blocks = skills.map((skill) => `### 技能：${skill.name}\n\n${skill.content.trim()}`)
  return ['以下是本轮适用的客服话术，请严格按其中的口径与流程作答：', '', ...blocks].join('\n')
}

export interface SkillSelection {
  /** 模型声明选中的技能名。 */
  readonly names: readonly string[]
  /** 剥掉声明标记后的正文。声明本身不该出现在给客户的回复里。 */
  readonly text: string
  /** 模型是否确实作出了声明（区分「明确选了 0 个」与「压根没按格式回答」）。 */
  readonly declared: boolean
}

/**
 * 从 Round 1 的输出里解析技能选择。
 *
 * 容错要求：模型不按格式输出是常态，**绝不能因此抛错**——
 * 解析不到就当成「没有选中任何技能」，正文原样保留。
 *
 * @param raw - 模型 Round 1 的完整输出。
 * @returns 选中的技能名、剥掉标记的正文、是否有声明。
 */
export function parseSkillSelection(raw: string): SkillSelection {
  const match = SKILLS_TAG.exec(raw)
  if (match === null) {
    return { names: [], text: raw.trim(), declared: false }
  }

  const names = (match[1] ?? '')
    .split(/[,，、]/)
    .map((name) => name.trim())
    // 模型有时会把名字写成 `技能：退款` 或用引号包起来
    .map((name) => name.replace(/^["'`「【]|["'`」】]$/g, '').replace(/^技能[:：]\s*/, ''))
    .filter((name) => name !== '')

  const text = raw.replace(SKILLS_TAG, '').trim()
  return { names: dedupe(names), text, declared: true }
}

function dedupe(names: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}
