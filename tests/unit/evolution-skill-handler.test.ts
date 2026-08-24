// tests/unit/evolution-skill-handler.test.ts
import { describe, expect, it } from 'vitest'
import matter from 'gray-matter'
import { buildSkillDraft, type SkillDraft } from '../../src/evolution/handlers/skill.js'
import { parseRoutingMeta } from '../../src/skills/types.js'

/**
 * 与 @deepseek-ai/dsh-skill 的 `SKILL_NAME` 一致：不符合该语法的技能名
 * 在 dsh-skill-filesystem 发现期被静默丢弃（永不进入 ctx.skills.list()）。
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

describe('buildSkillDraft', () => {
  it('从低分命中生成技能草案', () => {
    const draft: SkillDraft = buildSkillDraft({
      dimension: 'skill',
      title: '退款场景不要承诺全额',
      rationale: '客户问退款，agent 答「我会帮你全额退款」，违反政策',
      badcaseText: '全额退款',
    })
    // 技能名必须是 ASCII kebab-case（dsh 只加载这种名字）
    expect(draft.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(draft.name).toContain('tuikuan')
    // 中文保留在 description 与 intent_signals 里
    expect(draft.content).toContain('不要')
    expect(draft.content).toContain('承诺')
    expect(draft.content).toContain('退款')
  })

  it('无领域词典命中时回退为合法 ASCII 名', () => {
    const draft = buildSkillDraft({
      dimension: 'skill',
      title: '完全不认识的场景词',
      rationale: '测试回退路径',
      badcaseText: '坏例',
    })
    expect(draft.name).toMatch(/^proposal-[a-z0-9-]+$/)
    expect(draft.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
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

  it('草案是可被技能库加载的 SKILL.md（name 过 isSkillName、parseRoutingMeta 读对路由语义）', () => {
    const draft = buildSkillDraft({
      dimension: 'skill',
      title: '退款场景不要承诺全额',
      rationale: '客户问退款，agent 答「我会帮你全额退款」，违反政策',
      badcaseText: '全额退款',
    })
    // name 必须过 isSkillName 语法，否则草案在 dsh 发现期被静默忽略
    expect(SKILL_NAME.test(draft.name)).toBe(true)

    // 走与 src/skills/repo.ts 相同的加载路径：gray-matter 解析 frontmatter → parseRoutingMeta
    const { data } = matter(draft.content)
    expect(data.name).toBe(draft.name)
    expect(data.description).toBe('退款场景不要承诺全额')
    const meta = parseRoutingMeta(data.metadata as Record<string, unknown> | undefined)
    expect(meta.priority).toBe(90)
    expect(meta.routing).toBe('cs_reply')
    // 中文意图信号保留在 metadata.intent_signals，仍可被路由解析读到
    expect(meta.intentSignals).toContain('退款')
  })
})
