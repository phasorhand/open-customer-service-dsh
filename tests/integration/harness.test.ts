/**
 * harness 集成测试。
 *
 * 纪律（dsh-best-practices §A）：集成测试必须走**真实组装**启动，不允许只 mock Context。
 * 因此这里调用生产的 `assembleHarness()`，只把「模型 token 生成」与「数据端口」换成
 * 确定性实现——agent loop / 工具管线 / guard / session 持久化全部是生产代码路径。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toTextBlocks } from '../../src/evolution/assistant-text.js'
import { loadConfig } from '../../src/config.js'
import { assembleHarness, type Harness } from '../../src/harness/assemble.js'
import { parseCard } from '../../src/harness/cards.js'
import type { RiskDecisionEntry } from '../../src/harness/plugins/guard-risk.js'
import { RecordingOutbound, memoryPorts } from '../../src/harness/ports-memory.js'
import { resetScopes, type TenantScope } from '../../src/harness/session-scope.js'

const SCOPE: TenantScope = {
  tenantId: 'default',
  conversationId: 'conv-int-1',
  channelId: 'webchat',
  customerId: 'cus-int-1',
}

/** 放开到 ORANGE_C：允许 agent 自动把回复发出去。这是一个显式的运营决策。 */
const AUTO_REPLY = { OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' } as const

interface Fixture {
  readonly harness: Harness
  readonly decisions: RiskDecisionEntry[]
  readonly outbound: RecordingOutbound
  readonly dataDir: string
}

const built: Fixture[] = []

async function build(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opencs-int-'))
  const decisions: RiskDecisionEntry[] = []
  const outbound = new RecordingOutbound()
  const harness = await assembleHarness({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...env }),
    ports: memoryPorts(undefined, undefined, outbound),
    onRiskDecision: (entry) => decisions.push(entry),
  })
  const fixture: Fixture = { harness, decisions, outbound, dataDir }
  built.push(fixture)
  return fixture
}

beforeEach(() => {
  resetScopes()
})

afterEach(async () => {
  for (const fixture of built.splice(0)) {
    await fixture.harness.dispose()
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
  resetScopes()
})

/** 从 session 事件里抽出助手回复的纯文本（与 shadow/网关共用同一投影 helper）。 */
function assistantText(events: readonly { readonly type: string; readonly data: unknown }[]): string {
  return toTextBlocks(events)
    .map((b) => b.text)
    .join('\n')
}

function toolNames(events: readonly { readonly type: string; readonly data: unknown }[]): string[] {
  return events.filter((e) => e.type === 'tool/call').map((e) => (e.data as { name?: string }).name ?? '?')
}

function cardsOf(events: readonly { readonly type: string; readonly data: unknown }[]) {
  return events
    .filter((e) => e.type === 'tool/result')
    .map((e) => parseCard((e.data as { meta?: unknown }).meta))
    .filter((card): card is NonNullable<typeof card> => card !== undefined)
}

describe('assembleHarness · 组装', () => {
  it('无 API key 时使用确定性 mock provider', async () => {
    const { harness } = await build()
    expect(harness.provider).toBe('opencs-mock')
  })

  it('同一 conversationId 复用同一个 agent', async () => {
    const { harness } = await build()
    expect(await harness.agentFor(SCOPE)).toBe(await harness.agentFor(SCOPE))
  })

  it('不同 conversationId 得到不同 agent', async () => {
    const { harness } = await build()
    const a = await harness.agentFor(SCOPE)
    const b = await harness.agentFor({ ...SCOPE, conversationId: 'conv-int-2' })
    expect(a).not.toBe(b)
  })
})

describe('agent loop · 查证 → 回复 全链路', () => {
  it('政策问题：knowledge.search → channel.reply → 送达', async () => {
    const { harness, outbound } = await build(AUTO_REPLY)
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')

    const events = [...agent.session.events]
    expect(toolNames(events)).toEqual(['knowledge.search', 'channel.reply'])
    expect(outbound.delivered).toHaveLength(1)
    // 回复内容必须来自工具结果，而不是模型臆造
    expect(outbound.delivered[0]?.text).toMatch(/7\s*天/)
  })

  it('产出 knowledge_hit 与 cs_reply 两张卡片', async () => {
    const { harness } = await build(AUTO_REPLY)
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')

    const types = cardsOf([...agent.session.events]).map((c) => c.type)
    expect(types).toContain('knowledge_hit')
    expect(types).toContain('cs_reply')
  })

  it('订单号：crm.get_order → channel.reply，回复含订单状态', async () => {
    const { harness, outbound } = await build(AUTO_REPLY)
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '订单 ord-10086 到哪了')

    expect(toolNames([...agent.session.events])).toContain('crm.get_order')
    expect(outbound.delivered[0]?.text).toMatch(/已发货/)
  })

  it('订单不存在时返回 canonical value 而不是 isError', async () => {
    const { harness, outbound } = await build(AUTO_REPLY)
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '查一下订单 ord-99999')

    const failed = [...agent.session.events]
      .filter((e) => e.type === 'tool/result')
      .filter((e) => (e.data as { isError?: boolean }).isError === true)
    expect(failed).toHaveLength(0)
    expect(outbound.delivered[0]?.text).toMatch(/不存在/)
  })

  it('无法识别的意图走兜底问候，不查知识库', async () => {
    const { harness, outbound } = await build(AUTO_REPLY)
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '嗯')

    expect(toolNames([...agent.session.events])).toEqual(['channel.reply'])
    expect(outbound.delivered[0]?.text).toMatch(/OpenCS 客服助手/)
  })

  it('投递失败时不重复发送，并如实告知', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'opencs-int-'))
    const harness = await assembleHarness({
      config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...AUTO_REPLY }),
      ports: memoryPorts(undefined, undefined, new RecordingOutbound('渠道不可达')),
    })
    built.push({ harness, decisions: [], outbound: new RecordingOutbound(), dataDir })

    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')

    expect(toolNames([...agent.session.events]).filter((n) => n === 'channel.reply')).toHaveLength(1)
    expect(assistantText([...agent.session.events])).toMatch(/没能送达|人工跟进/)
  })
})

describe('审批门禁 · ORANGE_C 默认需人工确认', () => {
  it('默认策略下 channel.reply 不会自动送达', async () => {
    const { harness, outbound, decisions } = await build()
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')

    expect(outbound.delivered).toHaveLength(0)
    expect(decisions.some((d) => d.toolName === 'channel.reply' && d.decision === 'ask')).toBe(true)
    expect(assistantText([...agent.session.events])).toMatch(/需要人工确认/)
  })

  it('查证工具仍然自动放行（只读不需要审批）', async () => {
    const { harness, decisions } = await build()
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')
    expect(decisions.some((d) => d.toolName === 'knowledge.search' && d.decision === 'allow')).toBe(true)
  })

  it('收紧到只放行 RED 时，连只读工具也走人工确认', async () => {
    const { harness, decisions } = await build({ OPENCS_AUTO_APPROVE_TIERS: '5' })
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')
    expect(decisions.some((d) => d.toolName === 'knowledge.search' && d.decision === 'ask')).toBe(true)
  })
})

describe('guard 链 · 租户隔离', () => {
  it('未绑定作用域的 session 调用业务工具被拒绝', async () => {
    const { harness } = await build(AUTO_REPLY)
    // 绕过 agentFor（它会绑定作用域），直接建裸 agent 模拟「作用域注入缺失」
    const handle = await harness.ctx.agents.create({
      sessionId: SessionId('conv-unbound'),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: harness.provider, model: harness.model },
    })
    await harness.runTurn(handle.agent, '想退款还来得及吗')

    const events = [...handle.agent.session.events]
    const resultText = JSON.stringify(events.filter((e) => e.type === 'tool/result').map((e) => e.data))
    expect(resultText).toMatch(/未经服务端注入|作用域/)
    expect(cardsOf(events).filter((c) => c.type === 'knowledge_hit')).toHaveLength(0)
  })

  it('跨租户会话检索不到其他租户的数据', async () => {
    const { harness, outbound } = await build(AUTO_REPLY)
    const agent = await harness.agentFor({ ...SCOPE, tenantId: 'other-corp', conversationId: 'conv-other' })
    await harness.runTurn(agent, '想退款还来得及吗')
    expect(outbound.delivered[0]?.text ?? '').not.toMatch(/原路返回/)
  })
})

describe('回放 · 从 session 事件重建卡片', () => {
  it('重建结果可重复且与实时一致', async () => {
    const { harness } = await build(AUTO_REPLY)
    const agent = await harness.agentFor(SCOPE)
    await harness.runTurn(agent, '想退款还来得及吗')
    await harness.runTurn(agent, '订单 ord-10086 到哪了')

    const first = cardsOf([...agent.session.events])
    expect(first.length).toBeGreaterThanOrEqual(4)
    expect(first).toEqual(cardsOf([...agent.session.events]))
  })
})
