// tests/unit/evolution-differ.test.ts
import { describe, expect, it } from 'vitest'
import { diffFrames, type FrameLike } from '../../src/evolution/differ.js'

const frames = (texts: string[]): FrameLike[] =>
  texts.map((text, i) => ({ type: 'text/delta' as const, seq: i + 1, text, index: 0 }))

describe('diffFrames', () => {
  it('baseline 为空 → INCONCLUSIVE', () => {
    const result = diffFrames([], frames(['hi']))
    expect(result.verdict).toBe('inconclusive')
  })

  it('replay 为空 → INCONCLUSIVE', () => {
    const result = diffFrames(frames(['hi']), [])
    expect(result.verdict).toBe('inconclusive')
  })

  it('badcase 文本存在且不再出现 → BADCASE_FIXED', () => {
    const baseline = frames(['我会帮你全额退款', '请稍等'])
    const replay = frames(['请稍等', '我帮你查一下政策'])
    const result = diffFrames(baseline, replay, { badcaseText: '全额退款' })
    expect(result.verdict).toBe('badcase_fixed')
  })

  it('badcase 文本仍在 replay 中出现 → BADCASE_REMAINS', () => {
    const baseline = frames(['我会帮你全额退款', '请稍等'])
    const replay = frames(['好的我会帮你全额退款'])
    const result = diffFrames(baseline, replay, { badcaseText: '全额退款' })
    expect(result.verdict).toBe('badcase_remains')
  })

  it('badcase 未提供时按内容一致性给 INCONCLUSIVE 或 CHANGE', () => {
    const result = diffFrames(frames(['a']), frames(['a']))
    expect(result.verdict).toBe('inconclusive') // 无差异且无 badcase
  })

  it('replay 退化为极短问候 → new_regression', () => {
    const result = diffFrames(frames(['这是政策正文', '还需要别的吗']), frames(['你好']))
    expect(result.verdict).toBe('new_regression')
  })

  it('diff 记录有差异内容变更', () => {
    const result = diffFrames(frames(['AAA']), frames(['BBB']))
    expect(result.divergences.length).toBeGreaterThan(0)
  })
})
