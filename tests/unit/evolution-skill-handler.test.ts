// tests/unit/evolution-skill-handler.test.ts
import { describe, expect, it } from 'vitest'
import { buildSkillDraft, type SkillDraft } from '../../src/evolution/handlers/skill.js'

describe('buildSkillDraft', () => {
  it('从低分命中生成技能草案', () => {
    const draft: SkillDraft = buildSkillDraft({
      dimension: 'skill',
      title: '退款场景不要承诺全额',
      rationale: '客户问退款，agent 答「我会帮你全额退款」，违反政策',
      badcaseText: '全额退款',
    })
    expect(draft.name).toContain('退款')
    expect(draft.content).toContain('不要')
    expect(draft.content).toContain('承诺')
  })

  it('草案是合法 SKILL.md 格式（frontmatter 含 name/description/metadata）', () => {
    const draft = buildSkillDraft({
      dimension: 'skill',
      title: '订单查询要先调工具',
      rationale: '客户问订单状态时直接编造，必须先查 crm.get_order',
      badcaseText: '已在途中',
    })
    expect(draft.content.startsWith('---')).toBe(true)
    expect(draft.content).toMatch(/^name: /m)
    expect(draft.content).toMatch(/^description: /m)
    expect(draft.content).toMatch(/^metadata:/m)
    expect(draft.content).toContain('坏例')
  })
})
