import { afterEach, describe, expect, it } from 'vitest'

import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'
import { evaluateAll, policyCompliance, resolutionProgress, toneAppropriateness } from '../../src/evaluation/cs-metrics.js'
import { EVAL_MIGRATIONS, EvalStore } from '../../src/evaluation/store.js'
import { EvolutionGate } from '../../src/evolution/gate.js'
import { EVOLUTION_MIGRATIONS, ProposalStore } from '../../src/evolution/store.js'

let db: Db
afterEach(() => db?.close())

function stores(): { evals: EvalStore; proposals: ProposalStore } {
  db = openDb(IN_MEMORY, [...EVAL_MIGRATIONS, ...EVOLUTION_MIGRATIONS.map((m) => ({ ...m, id: m.id + 100 }))])
  return { evals: new EvalStore(db), proposals: new ProposalStore(db) }
}

const base = { input: '想退款', output: '', toolsUsed: [] as string[] }

describe('policyCompliance · 越权承诺', () => {
  it('正常答复通过', () => {
    expect(policyCompliance({ ...base, output: '按政策签收后 7 天内可以退款。' }).passed).toBe(true)
  })

  it.each([
    ['我保证一定能给你退款', '绝对化承诺'],
    ['我们无条件全额退款', '无条件赔付承诺'],
    ['马上就给你到账', '时效硬承诺'],
    ['我帮你破例处理', '破例承诺'],
    ['免费送你一个', '免费赠予承诺'],
  ])('拦住越权承诺：%s', (output) => {
    const result = policyCompliance({ ...base, output })
    expect(result.passed).toBe(false)
    expect(result.reasoning).toContain('发现问题')
  })

  it('知识库零命中却给确定政策答复 → 判为编造', () => {
    const result = policyCompliance({
      ...base,
      output: '按规定这个是可以退的。',
      toolsUsed: ['knowledge.search'],
      knowledgeHits: 0,
    })
    expect(result.passed).toBe(false)
    expect(result.reasoning).toContain('疑似编造')
  })

  it('零命中但明确说了不确定 → 通过（这是正确行为）', () => {
    expect(
      policyCompliance({
        ...base,
        output: '这个我需要核实一下，稍后转人工帮你确认。',
        toolsUsed: ['knowledge.search'],
        knowledgeHits: 0,
      }).passed,
    ).toBe(true)
  })

  it('有命中时给确定答复 → 通过', () => {
    expect(
      policyCompliance({
        ...base,
        output: '按规定签收后 7 天内可以退。',
        toolsUsed: ['knowledge.search'],
        knowledgeHits: 2,
      }).passed,
    ).toBe(true)
  })
})

describe('toneAppropriateness', () => {
  it('得体语气通过', () => {
    expect(toneAppropriateness({ ...base, output: '你好，我来帮你处理。' }).passed).toBe(true)
  })

  it.each([['亲，这边给你看看'], ['你自己看订单页面'], ['不可能，没得商量'], ['好的！！！！']])(
    '拦住不当语气：%s',
    (output) => {
      expect(toneAppropriateness({ ...base, output }).passed).toBe(false)
    },
  )
})

describe('resolutionProgress', () => {
  it('有推进信号且查了工具 → 高分', () => {
    const result = resolutionProgress({
      ...base,
      output: '已为你提交退款申请，预计 3 个工作日到账。接下来你可以在订单页查看进度。',
      toolsUsed: ['knowledge.search', 'crm.get_order'],
    })
    expect(result.score).toBeGreaterThan(0.7)
  })

  it('只有停滞信号 → 低分', () => {
    const result = resolutionProgress({ ...base, output: '这个我不知道，请联系人工。' })
    expect(result.passed).toBe(false)
  })

  it('分数落在 0-1', () => {
    for (const output of ['', '已为你提交，接下来请确认，预计 3 个工作日', '不清楚，帮不了，请联系人工，转人工']) {
      const score = resolutionProgress({ ...base, output }).score
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})

describe('evaluateAll · 整体判定', () => {
  it('红线指标失败即整体失败', () => {
    expect(evaluateAll({ ...base, output: '我保证一定能退' }).passed).toBe(false)
  })

  it('只有推进度低不否决整体（它是启发式，不是红线）', () => {
    const result = evaluateAll({ ...base, output: '这个我不知道，请联系人工。' })
    expect(result.passed).toBe(true)
    expect(result.results.find((r) => r.name === 'resolution_progress')?.passed).toBe(false)
  })

  it('返回全部三个指标', () => {
    expect(evaluateAll({ ...base, output: '你好' }).results).toHaveLength(3)
  })
})

describe('EvalStore', () => {
  it('保存并按会话查询', () => {
    const { evals } = stores()
    evals.save({
      tenantId: 'default',
      conversationId: 'c1',
      mode: 'realtime',
      passed: true,
      metrics: evaluateAll({ ...base, output: '你好' }).results,
    })
    expect(evals.byConversation('c1')).toHaveLength(1)
  })

  it('failing 只返回未通过的（演进提案的输入源）', () => {
    const { evals } = stores()
    const ok = evaluateAll({ ...base, output: '你好' })
    const bad = evaluateAll({ ...base, output: '我保证一定能退' })
    evals.save({ tenantId: 'default', conversationId: 'c1', mode: 'realtime', passed: ok.passed, metrics: ok.results })
    evals.save({ tenantId: 'default', conversationId: 'c2', mode: 'realtime', passed: bad.passed, metrics: bad.results })

    const failing = evals.failing('default')
    expect(failing).toHaveLength(1)
    expect(failing[0]?.conversationId).toBe('c2')
  })

  it('汇总给出通过率与失败指标分布', () => {
    const { evals } = stores()
    const bad = evaluateAll({ ...base, output: '我保证一定能退' })
    evals.save({ tenantId: 'default', conversationId: 'c1', mode: 'realtime', passed: bad.passed, metrics: bad.results })

    const summary = evals.summary('default')
    expect(summary.total).toBe(1)
    expect(summary.passRate).toBe(0)
    expect(summary.failuresByMetric['policy_compliance']).toBe(1)
  })

  it('空库汇总不除零', () => {
    expect(stores().evals.summary('default')).toMatchObject({ total: 0, passRate: 1 })
  })
})

describe('ProposalStore', () => {
  const input = {
    tenantId: 'default',
    dimension: 'knowledge' as const,
    action: 'create' as const,
    title: '缺少关于国际配送的说明',
    rationale: '客户询问是否发货到海外，知识库里没有任何相关条款',
    payload: { suggestion: '补充国际配送政策' },
    evidence: ['客户原话：你们发不发国际？'],
  }

  it('创建提案', () => {
    const { proposals } = stores()
    const { proposal, created } = proposals.propose(input)
    expect(created).toBe(true)
    expect(proposal.status).toBe('pending')
  })

  it('同一问题重复提交不会刷爆人工队列', () => {
    const { proposals } = stores()
    const first = proposals.propose(input)
    const second = proposals.propose(input)
    expect(second.created).toBe(false)
    expect(second.proposal.id).toBe(first.proposal.id)
  })

  it('已驳回的同名提案不阻止重新提出（问题可能再次出现）', () => {
    const { proposals } = stores()
    const first = proposals.propose(input)
    proposals.review(first.proposal.id, false, 'alice')
    expect(proposals.propose(input).created).toBe(true)
  })

  it('审批流转：gated → approved → applied', () => {
    const { proposals } = stores()
    const { proposal } = proposals.propose(input)
    proposals.recordGate(proposal.id, 'needs_human', '需人工')
    expect(proposals.review(proposal.id, true, 'alice', '合理').status).toBe('approved')
    expect(proposals.markApplied(proposal.id).status).toBe('applied')
  })

  it('未获批准不能标记为已应用', () => {
    const { proposals } = stores()
    const { proposal } = proposals.propose(input)
    expect(() => proposals.markApplied(proposal.id)).toThrow(/未获批准/)
  })

  it('已终结的提案不可再审批', () => {
    const { proposals } = stores()
    const { proposal } = proposals.propose(input)
    proposals.review(proposal.id, false, 'alice')
    expect(() => proposals.review(proposal.id, true, 'bob')).toThrow(/不可审批/)
  })

  it('按状态与维度过滤', () => {
    const { proposals } = stores()
    proposals.propose(input)
    proposals.propose({ ...input, dimension: 'skill', title: '退款话术需补充定制商品说明' })
    expect(proposals.list('default', { dimension: 'skill' })).toHaveLength(1)
    expect(proposals.list('default', { status: 'pending' })).toHaveLength(2)
  })

  it('按状态计数供管理端徽标', () => {
    const { proposals } = stores()
    proposals.propose(input)
    expect(proposals.countByStatus('default')).toEqual({ pending: 1 })
  })
})

describe('EvolutionGate · 改行为准则的提案永远人工', () => {
  const solid = {
    tenantId: 'default',
    action: 'create' as const,
    rationale: '客户多次询问，知识库确实没有覆盖这个场景',
    payload: {},
    evidence: ['客户原话 A'],
    confidence: 0.95,
  }

  it('技能维度永远需人工（它是 agent 的行为准则）', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({ ...solid, dimension: 'skill', title: '调整退款话术' })
    expect(gate.judge(proposal).verdict).toBe('needs_human')
  })

  it('节奏维度永远需人工（它决定发给客户什么）', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({ ...solid, dimension: 'cadence', title: '增加一步跟进' })
    expect(gate.judge(proposal).verdict).toBe('needs_human')
  })

  it('停用已有能力永远需人工（破坏性大于新增）', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({ ...solid, dimension: 'memory', action: 'deprecate', title: '删除画像字段' })
    expect(gate.judge(proposal).verdict).toBe('needs_human')
  })

  it('证据不足直接驳回，不占用人工时间', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals)
    const { proposal } = proposals.propose({ ...solid, dimension: 'knowledge', title: '无依据提案', evidence: [] })
    const result = gate.judge(proposal)
    expect(result.verdict).toBe('reject')
    expect(result.reason).toContain('证据不足')
  })

  it('理由过短驳回（审核者需要能独立判断）', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals)
    const { proposal } = proposals.propose({ ...solid, dimension: 'knowledge', title: '含糊提案', rationale: '需要' })
    expect(gate.judge(proposal).verdict).toBe('reject')
  })

  it('默认不开自动放行——全部走人工', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals)
    const { proposal } = proposals.propose({ ...solid, dimension: 'memory', title: '补充客户偏好' })
    expect(gate.judge(proposal).verdict).toBe('needs_human')
  })

  it('开启后，低风险 + 高置信度才可自动放行', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({ ...solid, dimension: 'memory', title: '补充客户偏好' })
    expect(gate.judge(proposal).verdict).toBe('auto_promote')
  })

  it('置信度不足则退回人工', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({ ...solid, dimension: 'memory', title: '低置信', confidence: 0.4 })
    expect(gate.judge(proposal).verdict).toBe('needs_human')
  })

  it('来源会话评测未通过 → 不能自动放行', () => {
    const { proposals, evals } = stores()
    const bad = evaluateAll({ ...base, output: '我保证一定能退' })
    evals.save({ tenantId: 'default', conversationId: 'c-bad', mode: 'realtime', passed: false, metrics: bad.results })

    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({
      ...solid,
      dimension: 'memory',
      title: '来自低分会话',
      sourceConversationId: 'c-bad',
    })
    const result = gate.judge(proposal)
    expect(result.verdict).toBe('needs_human')
    expect(result.reason).toContain('评测未通过')
  })

  it('evaluate 把判定写回存储', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals)
    const { proposal } = proposals.propose({ ...solid, dimension: 'knowledge', title: '写回测试' })
    gate.evaluate(proposal.id)
    expect(proposals.require(proposal.id).status).toBe('gated')
  })

  it('auto_promote 直接进 approved', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals, { allowAutoPromote: true })
    const { proposal } = proposals.propose({ ...solid, dimension: 'memory', title: '自动放行' })
    gate.evaluate(proposal.id)
    expect(proposals.require(proposal.id).status).toBe('approved')
  })

  it('reject 直接进 rejected', () => {
    const { proposals, evals } = stores()
    const gate = new EvolutionGate(proposals, evals)
    const { proposal } = proposals.propose({ ...solid, dimension: 'knowledge', title: '证据不足', evidence: [] })
    gate.evaluate(proposal.id)
    expect(proposals.require(proposal.id).status).toBe('rejected')
  })
})
