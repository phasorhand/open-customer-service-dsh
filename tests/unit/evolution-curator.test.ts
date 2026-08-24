// tests/unit/evolution-curator.test.ts
import { describe, expect, it, vi } from 'vitest'
import { curate, type CuratorDeps } from '../../src/evolution/curator.js'
import type { DiffVerdict } from '../../src/evolution/differ.js'
import type { EvalStore } from '../../src/evaluation/store.js'
import type { Proposal } from '../../src/evolution/store.js'

const PROPOSAL: Proposal = {
  id: 'p1',
  tenantId: 'default',
  dimension: 'skill',
  action: 'create',
  title: '退款场景不要承诺全额',
  rationale: '客户问退款时承诺了全额退款',
  payload: {},
  evidence: [],
  confidence: 0.6,
  status: 'pending',
  sourceConversationId: 'conv-bad',
  createdAt: new Date(),
  updatedAt: new Date(),
}

const NO_SOURCE: Proposal = {
  id: 'p2',
  tenantId: 'default',
  dimension: 'skill',
  action: 'create',
  title: '没有来源会话的提案',
  rationale: '这条提案没有关联任何低分评测',
  payload: {},
  evidence: [],
  confidence: 0.5,
  status: 'pending',
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('curate · 闭环编排', () => {
  it('低分输出 → 证据 → 影子运行 → 差分 verdict', async () => {
    // 假评测库：来源会话有一条未通过的评测，input/output 就是坏例原文
    const evals = {
      byConversation: vi.fn(() => [
        {
          id: 'e1',
          tenantId: 'default',
          conversationId: 'conv-bad',
          mode: 'realtime',
          passed: false,
          overallScore: 0.2,
          metrics: [],
          inputText: '买的东西想退款还来得及吗',
          outputText: '我会帮你全额退款',
          createdAt: new Date(),
        },
      ]),
    } as unknown as EvalStore
    // 假影子运行：返回固定的 replay 帧（已不再含坏例「全额退款」）
    const runShadowTurn = vi.fn(async () => ({
      verdict: 'badcase_fixed' as DiffVerdict,
      divergences: [{ kind: 'content_changed' as const, baseline: '我会帮你全额退款', replay: '我帮你查一下政策' }],
      replayFrames: [{ type: 'text/delta' as const, text: '我帮你查一下政策' }],
    }))
    const deps = { runShadowTurn, evals } as unknown as CuratorDeps

    const result = await curate(PROPOSAL, deps)

    // ① 证据画像：越权承诺命中
    expect(result.evidenceHits.some((h) => h.kind === 'commitment_violation')).toBe(true)
    // ② verdict 直接透传影子内部 diff 的结果（curate 不再重复 diff）
    expect(result.shadowVerdict).toBe('badcase_fixed')
    // ③ 差分记录 + replay 帧都给审批看
    expect(result.divergences.length).toBeGreaterThan(0)
    expect(result.replayFrames).toHaveLength(1)
    // ④ 影子运行用原输入 + 提案租户（原会话真实数据域，见 shadow.ts Important #1），
    //    baseline（坏例原文）与 badcase 锚点一并传入，由 shadow 内部做差分
    expect(runShadowTurn).toHaveBeenCalledWith(
      { text: '买的东西想退款还来得及吗', tenantId: 'default' },
      { badcaseText: '全额退款', baselineFrames: [{ type: 'text/delta', text: '我会帮你全额退款' }] },
    )
  })

  it('来源会话无低分评测时返回 inconclusive', async () => {
    const evals = { byConversation: vi.fn(() => []) } as unknown as EvalStore
    const runShadowTurn = vi.fn()
    const deps = { runShadowTurn, evals } as unknown as CuratorDeps

    const result = await curate(PROPOSAL, deps)

    expect(result.shadowVerdict).toBe('inconclusive')
    expect(result.evidenceHits).toEqual([])
    expect(runShadowTurn).not.toHaveBeenCalled()
  })

  it('提案无来源会话时直接 inconclusive，不触碰评测库', async () => {
    const evals = { byConversation: vi.fn(() => []) } as unknown as EvalStore
    const runShadowTurn = vi.fn()
    const deps = { runShadowTurn, evals } as unknown as CuratorDeps

    const result = await curate(NO_SOURCE, deps)

    expect(result.shadowVerdict).toBe('inconclusive')
    expect(evals.byConversation).not.toHaveBeenCalled()
    expect(runShadowTurn).not.toHaveBeenCalled()
  })

  it('低分评测缺文本时返回 inconclusive 且不跑影子', async () => {
    // 有未通过评测但 inputText 缺失（评测侧异常）——没有原文就没有影子重跑的输入，
    // 应直接降级，不能带着 undefined 去跑影子
    const evals = {
      byConversation: vi.fn(() => [
        {
          id: 'e1',
          tenantId: 'default',
          conversationId: 'conv-bad',
          mode: 'realtime',
          passed: false,
          overallScore: 0.2,
          metrics: [],
          inputText: undefined,
          outputText: '我会帮你全额退款',
          createdAt: new Date(),
        },
      ]),
    } as unknown as EvalStore
    const runShadowTurn = vi.fn()
    const deps = { runShadowTurn, evals } as unknown as CuratorDeps

    const result = await curate(PROPOSAL, deps)

    expect(result.shadowVerdict).toBe('inconclusive')
    expect(result.evidenceHits).toEqual([])
    expect(runShadowTurn).not.toHaveBeenCalled()
  })
})
