import { describe, expect, it } from 'vitest'

import {
  parseSkillSelection,
  round1Instruction,
  round2Instruction,
} from '../../src/skills/selection.js'
import { DEFAULT_PRIORITY, DEFAULT_ROUTING, parseRoutingMeta } from '../../src/skills/types.js'

describe('parseRoutingMeta · frontmatter 路由语义', () => {
  it('全部字段齐全时原样解析', () => {
    expect(
      parseRoutingMeta({ priority: 80, routing: 'lead_qualifier', intent_signals: ['想退款', '退货'] }),
    ).toEqual({ priority: 80, routing: 'lead_qualifier', intentSignals: ['想退款', '退货'] })
  })

  it('全部缺省时用默认值（运营写 SKILL.md 不该被必填字段绊住）', () => {
    expect(parseRoutingMeta(undefined)).toEqual({
      priority: DEFAULT_PRIORITY,
      routing: DEFAULT_ROUTING,
      intentSignals: [],
    })
  })

  it('priority 非数字时回落默认值', () => {
    expect(parseRoutingMeta({ priority: '很高' }).priority).toBe(DEFAULT_PRIORITY)
    expect(parseRoutingMeta({ priority: Number.NaN }).priority).toBe(DEFAULT_PRIORITY)
  })

  it('routing 空串回落默认值', () => {
    expect(parseRoutingMeta({ routing: '' }).routing).toBe(DEFAULT_ROUTING)
  })

  it('intent_signals 写成逗号分隔字符串也能解析（手写 YAML 常见）', () => {
    expect(parseRoutingMeta({ intent_signals: '想退款, 退货、不想要了' }).intentSignals).toEqual([
      '想退款',
      '退货',
      '不想要了',
    ])
  })

  it('接受 camelCase 别名', () => {
    expect(parseRoutingMeta({ intentSignals: ['a'] }).intentSignals).toEqual(['a'])
  })

  it('数组里的非字符串与空白项被剔除', () => {
    expect(parseRoutingMeta({ intent_signals: ['ok', '', '  ', 42, null] }).intentSignals).toEqual(['ok'])
  })

  it('intent_signals 类型完全不对时返回空数组而不是抛错', () => {
    expect(parseRoutingMeta({ intent_signals: { a: 1 } }).intentSignals).toEqual([])
  })
})

describe('parseSkillSelection · Round 1 输出解析', () => {
  it('解析标准格式并剥掉声明', () => {
    const result = parseSkillSelection('[SKILLS: refund-escalation, order-status]\n好的，我来看一下。')
    expect(result.names).toEqual(['refund-escalation', 'order-status'])
    expect(result.text).toBe('好的，我来看一下。')
    expect(result.declared).toBe(true)
  })

  it('声明不会残留在给客户的回复里', () => {
    expect(parseSkillSelection('[SKILLS: a]\n你好').text).not.toContain('SKILLS')
  })

  it('明确选 0 个技能：declared 为 true，names 为空', () => {
    const result = parseSkillSelection('[SKILLS: ]\n你好')
    expect(result).toMatchObject({ names: [], declared: true, text: '你好' })
  })

  it('模型没按格式输出时不抛错，正文原样保留', () => {
    const result = parseSkillSelection('你好，请问有什么可以帮你？')
    expect(result).toMatchObject({ names: [], declared: false, text: '你好，请问有什么可以帮你？' })
  })

  it('容忍全角冒号与中文逗号', () => {
    expect(parseSkillSelection('[SKILLS：a，b]\nx').names).toEqual(['a', 'b'])
  })

  it('容忍单数写法与大小写', () => {
    expect(parseSkillSelection('[skill: a]\nx').names).toEqual(['a'])
    expect(parseSkillSelection('[Skills: a]\nx').names).toEqual(['a'])
  })

  it('剥掉模型加的引号与「技能：」前缀', () => {
    expect(parseSkillSelection('[SKILLS: "refund", 技能：order, 「greeting」]\nx').names).toEqual([
      'refund',
      'order',
      'greeting',
    ])
  })

  it('重复的技能名去重', () => {
    expect(parseSkillSelection('[SKILLS: a, a, b]\nx').names).toEqual(['a', 'b'])
  })

  it('声明出现在中间也能解析（模型不总把它放第一行）', () => {
    const result = parseSkillSelection('稍等\n[SKILLS: a]\n好的')
    expect(result.names).toEqual(['a'])
    expect(result.text).toBe('稍等\n\n好的')
  })
})

describe('round1Instruction / round2Instruction', () => {
  it('Round 1 指令包含索引与格式说明', () => {
    const instruction = round1Instruction('- refund：处理退款')
    expect(instruction).toContain('[SKILLS:')
    expect(instruction).toContain('- refund：处理退款')
  })

  it('Round 2 无选中技能时返回空串（不注入噪音）', () => {
    expect(round2Instruction([])).toBe('')
  })

  it('Round 2 注入技能正文并标注名称', () => {
    const instruction = round2Instruction([{ name: 'refund', content: '先查政策再答复。' }])
    expect(instruction).toContain('技能：refund')
    expect(instruction).toContain('先查政策再答复。')
  })

  it('Round 2 多条技能各自成块', () => {
    const instruction = round2Instruction([
      { name: 'a', content: 'AAA' },
      { name: 'b', content: 'BBB' },
    ])
    expect(instruction).toContain('技能：a')
    expect(instruction).toContain('技能：b')
  })
})
