import { describe, expect, it } from 'vitest'
import { extractEvidence, type EvidenceHit } from '../../src/evolution/evidence.js'

describe('extractEvidence', () => {
  it('提取越权承诺类命中', () => {
    const hits = extractEvidence('退款', '我会帮你全额退款')
    expect(hits.some((h) => h.kind === 'commitment_violation')).toBe(true)
  })

  it('提取事实缺失（知识库无命中）', () => {
    const hits = extractEvidence('查退款', '这个问题我暂时没有查到明确的说明')
    expect(hits.some((h) => h.kind === 'factual_gap')).toBe(true)
  })

  it('无命中时返回空数组', () => {
    expect(extractEvidence('退款', '签收后7天内可无理由退款。')).toEqual([])
  })

  it('提取空泛安抚语 tone_issue', () => {
    const hits = extractEvidence('物流', '您放心，我们一定会为您尽快处理')
    expect(hits.some((h) => h.kind === 'tone_issue')).toBe(true)
  })

  it('每条命中带 badcaseText 锚点（供差分器用）', () => {
    const hits = extractEvidence('退款', '保证全额退款到账')
    const commitment = hits.find((h) => h.kind === 'commitment_violation')
    expect(commitment?.badcaseText).toBeTruthy()
  })
})
