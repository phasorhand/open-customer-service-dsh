/**
 * 演进闭环端到端测试：真实 harness 驱动真实 `evolution.propose` 全链路。
 *
 * 纪律同 harness.test.ts：走生产 assembleHarness()，只替换「模型 token 生成」
 * 与「数据端口」。但 mock 的路由表（见 mock-llm.ts）从不发出 evolution.propose——
 * 它只覆盖 crm.get_order / knowledge.search / channel.reply 三条业务意图。
 * 因此这里不依赖 agent loop 自然触达 propose，而是用**真实 harness 上下文**直接
 * 经 `ctx.tools.execute` 驱动 propose 工具：scope guard（agent 已绑定）→ risk guard
 * （YELLOW 自动放行）→ 真实 execute 全部走生产管线。这正好验证本次接线要打通的闭环：
 *
 *   propose 落地 → lineage.append(proposed, 来源会话)
 *   → curate（真实 EvalStore 低分评测 → 证据 → 同输入真实影子重跑 → 差分）
 *   → setShadowVerdict + setSkillDraft（skill 维度草案持久化）
 *   → lineage.append(shadow_verified, verdict)
 *
 * 关键（Important #1，同 shadow.ts）：影子重跑必须用原会话真实租户 'default'，
 * 其下有 SAMPLE_KNOWLEDGE——否则 knowledge.search 0 命中会产出假 badcase_fixed。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CallId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'
import { evaluateAll } from '../../src/evaluation/cs-metrics.js'
import { EVAL_MIGRATIONS, EvalStore } from '../../src/evaluation/store.js'
import { EvolutionGate } from '../../src/evolution/gate.js'
import { LineageStore } from '../../src/evolution/lineage.js'
import { runShadowTurn } from '../../src/evolution/shadow.js'
import { EVOLUTION_MIGRATIONS, ProposalStore } from '../../src/evolution/store.js'
import { assembleHarness, type Harness } from '../../src/harness/assemble.js'
import { RecordingOutbound, memoryPorts } from '../../src/harness/ports-memory.js'
import { resetScopes } from '../../src/harness/session-scope.js'

/** 放开 YELLOW~ORANGE_C：propose（YELLOW）自动放行，影子重跑的 channel.reply 也能真实投递。 */
const AUTO_REPLY = { OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' } as const
/** SAMPLE_KNOWLEDGE 所在租户：影子重跑真的查得到退款政策。 */
const TENANT = 'default'
/** 与 seeded 低分评测相同的会话 id——propose 用它作来源会话，curate 据此找坏例。 */
const BAD_CONVERSATION = 'conv-bad-refund'

interface Fixture {
  readonly harness: Harness
  readonly db: Db
  readonly evals: EvalStore
  readonly proposals: ProposalStore
  readonly lineage: LineageStore
  readonly outbound: RecordingOutbound
  readonly dataDir: string
}
const built: Fixture[] = []

/** 装配真实 harness，把真实的进化存储（评测/提案/血缘）经 evolution 依赖注入。 */
async function build(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opencs-evolution-loop-'))
  const outbound = new RecordingOutbound()

  // 评测与演进同库（对齐 runtime.ts）：门禁要读来源会话评测结论
  const db = openDb(IN_MEMORY, [...EVAL_MIGRATIONS, ...EVOLUTION_MIGRATIONS.map((m) => ({ ...m, id: m.id + 100 }))])
  const evals = new EvalStore(db)
  const proposals = new ProposalStore(db)
  const lineage = new LineageStore(db)
  const gate = new EvolutionGate(proposals, evals)

  // seed 一条低分评测：outputText 含越权承诺「全额退款」→ extractEvidence 抽出
  // commitment_violation，badcase 锚点「全额退款」在影子重跑（真实知识库）里不再出现。
  const bad = evaluateAll({ input: '想退款', output: '我会帮你全额退款', toolsUsed: [] })
  evals.save({
    tenantId: TENANT,
    conversationId: BAD_CONVERSATION,
    mode: 'realtime',
    passed: bad.passed,
    metrics: bad.results,
    inputText: '买的东西想退款还来得及吗',
    outputText: '我会帮你全额退款',
  })

  // 与 runtime.ts 相同的组合根：curator 用前向引用闭包绑定 harness（装配期循环依赖的解法）
  const harness = await assembleHarness({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...AUTO_REPLY }),
    ports: memoryPorts(undefined, undefined, outbound),
    evolution: {
      proposals,
      gate,
      curator: { runShadowTurn: (input, options) => runShadowTurn(harness, input, options), evals },
      lineage,
    },
  })

  const fixture: Fixture = { harness, db, evals, proposals, lineage, outbound, dataDir }
  built.push(fixture)
  return fixture
}

beforeEach(() => resetScopes())
afterEach(async () => {
  for (const f of built.splice(0)) {
    await f.harness.dispose()
    f.db.close()
    rmSync(f.dataDir, { recursive: true, force: true })
  }
  resetScopes()
})

/** 经真实 `ctx.tools.execute` 管线驱动 propose 工具（scope guard → risk guard → execute）。 */
async function propose(
  harness: Harness,
  args: Record<string, unknown>,
): Promise<{ proposalId: string; created: boolean; shadowVerdict: string }> {
  const agent = await harness.agentFor({
    tenantId: TENANT,
    conversationId: BAD_CONVERSATION,
    channelId: 'webchat',
    customerId: 'cus-loop-1',
  })
  const result = await harness.ctx.tools.execute({
    callId: CallId(`loop-${counter()}`),
    name: 'evolution.propose',
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
  if (result.isError) {
    throw new Error(`propose 被拒：${JSON.stringify(result.error)}`)
  }
  return result.value as { proposalId: string; created: boolean; shadowVerdict: string }
}

/** 单调 callId 计数，保证每次调用 id 唯一。 */
let seq = 0
function counter(): number {
  seq += 1
  return seq
}

describe('演进闭环端到端 · 真实 propose → 影子验证 → 技能草案 → 血缘', () => {
  it('skill 提案：propose 落库，payload 带 shadowVerdict + skillDraft，血缘记 proposed + shadow_verified', async () => {
    const f = await build()

    const result = await propose(f.harness, {
      dimension: 'skill',
      title: '退款场景不要承诺全额',
      rationale: '客户问退款时承诺了全额退款，违反退款政策',
      suggestion: '退款类问题先查政策再答复，禁止承诺全额退款',
    })

    // ① 新提案创建成功，且 propose 返回的影子结论不是缺省 inconclusive
    expect(result.created).toBe(true)
    expect(['badcase_fixed', 'badcase_remains', 'new_regression', 'inconclusive']).toContain(result.shadowVerdict)

    // ② payload 持久化了影子验证证据（管理端/详情直接可读）
    const proposal = f.proposals.require(result.proposalId)
    expect(proposal.payload.shadowVerdict).toBe(result.shadowVerdict)
    expect(proposal.payload.shadowDivergences).toBeDefined()

    // ③ skill 维度 → 技能自策展草案已持久化（ASCII kebab-case 名 + 可加载的 SKILL.md）
    const draftName = proposal.payload.skillDraftName as string | undefined
    const draftContent = proposal.payload.skillDraftContent as string | undefined
    expect(draftName).toBeDefined()
    expect(draftName).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(draftName).toContain('tuikuan')
    expect(draftContent).toContain('---')
    expect(draftContent).toContain('坏例：全额退款')

    // ④ 血缘：proposed（来源会话）+ shadow_verified（verdict）
    const events = f.lineage.forProposal(result.proposalId)
    expect(events.map((e) => e.kind)).toEqual(['proposed', 'shadow_verified'])
    expect(events[0]?.detail).toBe(BAD_CONVERSATION)
    expect(events[1]?.detail).toBe(proposal.payload.shadowVerdict)

    // ⑤ 影子重跑真的走了真实知识路径（同租户 default 命中退款政策），
    //    badcase「全额退款」不再出现 → 与 propose 返回的 verdict 一致
    const delivered = f.outbound.delivered.map((d) => d.text).join('\n')
    expect(delivered).toMatch(/7\s*天/)
    expect(delivered).toMatch(/退款/)
    expect(result.shadowVerdict).toBe('badcase_fixed')
  })

  it('knowledge 提案：只记影子验证，不产技能草案（dimension 门控）', async () => {
    const f = await build()

    const result = await propose(f.harness, {
      dimension: 'knowledge',
      title: '缺少国际配送条款',
      rationale: '客户询问海外发货，知识库无相关条款',
      suggestion: '补充国际配送政策',
    })

    expect(result.created).toBe(true)
    const proposal = f.proposals.require(result.proposalId)
    expect(proposal.payload.shadowVerdict).toBeDefined()
    // 非 skill 维度不产草案
    expect(proposal.payload.skillDraftName).toBeUndefined()
    expect(proposal.payload.skillDraftContent).toBeUndefined()

    // 血缘照记（proposed / shadow_verified 与维度无关）
    const events = f.lineage.forProposal(result.proposalId)
    expect(events.map((e) => e.kind)).toEqual(['proposed', 'shadow_verified'])
  })
})
