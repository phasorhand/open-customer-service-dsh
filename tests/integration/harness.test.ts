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

import { loadConfig } from '../../src/config.js'
import { assembleHarness, type Harness } from '../../src/harness/assemble.js'
import { parseCard } from '../../src/harness/cards.js'
import type { RiskDecisionEntry } from '../../src/harness/plugins/guard-risk.js'
import { memoryPorts } from '../../src/harness/ports-memory.js'
import { resetScopes, type TenantScope } from '../../src/harness/session-scope.js'

const SCOPE: TenantScope = {
  tenantId: 'default',
  conversationId: 'conv-int-1',
  channelId: 'webchat',
  customerId: 'cus-int-1',
}

interface Fixture {
  readonly harness: Harness
  readonly decisions: RiskDecisionEntry[]
  readonly dataDir: string
}

let fixture: Fixture

async function build(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opencs-int-'))
  const decisions: RiskDecisionEntry[] = []
  const harness = await assembleHarness({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...env }),
    ports: memoryPorts(),
    onRiskDecision: (entry) => decisions.push(entry),
  })
  return { harness, decisions, dataDir }
}

beforeEach(async () => {
  resetScopes()
  fixture = await build()
})

afterEach(async () => {
  await fixture.harness.dispose()
  rmSync(fixture.dataDir, { recursive: true, force: true })
  resetScopes()
})

/** 从 session 事件里抽出助手回复的纯文本。 */
function assistantText(events: readonly { readonly type: string; readonly data: unknown }[]): string {
  const out: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly { type: string; text?: string }[] } }
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }
  return out.join('\n')
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
  it('无 API key 时使用确定性 mock provider', () => {
    expect(fixture.harness.provider).toBe('opencs-mock')
  })

  it('同一 conversationId 复用同一个 agent', async () => {
    const a = await fixture.harness.agentFor(SCOPE)
    const b = await fixture.harness.agentFor(SCOPE)
    expect(a).toBe(b)
  })

  it('不同 conversationId 得到不同 agent', async () => {
    const a = await fixture.harness.agentFor(SCOPE)
    const b = await fixture.harness.agentFor({ ...SCOPE, conversationId: 'conv-int-2' })
    expect(a).not.toBe(b)
  })
})

describe('agent loop · 工具调用链路', () => {
  it('政策问题触发 knowledge.search 并产出卡片', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '想退款还来得及吗')

    const events = [...agent.session.events]
    expect(toolNames(events)).toContain('knowledge.search')

    const cards = cardsOf(events)
    expect(cards.some((c) => c.type === 'knowledge_hit')).toBe(true)
  })

  it('回复内容来自工具结果，而不是模型臆造', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '想退款还来得及吗')
    expect(assistantText([...agent.session.events])).toMatch(/7\s*天/)
  })

  it('订单号触发 crm.get_order', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '订单 ord-10086 到哪了')

    const events = [...agent.session.events]
    expect(toolNames(events)).toContain('crm.get_order')
    expect(assistantText(events)).toMatch(/已发货/)
  })

  it('订单不存在时返回 canonical value 而不是报错', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '查一下订单 ord-99999')

    const results = [...agent.session.events].filter((e) => e.type === 'tool/result')
    const failed = results.filter((e) => (e.data as { isError?: boolean }).isError === true)
    expect(failed).toHaveLength(0)
    expect(assistantText([...agent.session.events])).toMatch(/不存在|没有找到|确认订单号/)
  })

  it('无法识别的意图走兜底问候，不调用工具', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '嗯')
    expect(toolNames([...agent.session.events])).toHaveLength(0)
    expect(assistantText([...agent.session.events])).toMatch(/OpenCS 客服助手/)
  })
})

describe('guard 链 · 租户隔离', () => {
  it('未绑定作用域的 session 调用业务工具被拒绝', async () => {
    // 绕过 agentFor（它会绑定作用域），直接建一个裸 agent 模拟「作用域注入缺失」
    const handle = await fixture.harness.ctx.agents.create({
      sessionId: SessionId('conv-unbound'),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: fixture.harness.provider, model: fixture.harness.model },
    })
    await fixture.harness.runTurn(handle.agent, '想退款还来得及吗')

    const events = [...handle.agent.session.events]
    const resultText = JSON.stringify(events.filter((e) => e.type === 'tool/result').map((e) => e.data))
    expect(resultText).toMatch(/未经服务端注入|作用域/)
    // 越权请求不得产出业务卡片
    expect(cardsOf(events).filter((c) => c.type === 'knowledge_hit')).toHaveLength(0)
  })

  it('跨租户会话检索不到其他租户的数据', async () => {
    const agent = await fixture.harness.agentFor({ ...SCOPE, tenantId: 'other-corp', conversationId: 'conv-other' })
    await fixture.harness.runTurn(agent, '想退款还来得及吗')
    expect(assistantText([...agent.session.events])).not.toMatch(/原路返回/)
  })
})

describe('guard 链 · 风险裁决', () => {
  it('每次工具调用都产生裁决记录', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '想退款还来得及吗')
    expect(fixture.decisions.length).toBeGreaterThanOrEqual(1)
    expect(fixture.decisions.every((d) => ['allow', 'ask', 'deny'].includes(d.decision))).toBe(true)
  })

  it('GREEN 档工具被自动放行', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '想退款还来得及吗')
    expect(fixture.decisions.some((d) => d.toolName === 'knowledge.search' && d.decision === 'allow')).toBe(true)
  })

  it('收紧自动放行档位后，GREEN 之外的工具走人工确认', async () => {
    await fixture.harness.dispose()
    rmSync(fixture.dataDir, { recursive: true, force: true })
    resetScopes()
    fixture = await build({ OPENCS_AUTO_APPROVE_TIERS: '5' })

    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '想退款还来得及吗')
    expect(fixture.decisions.some((d) => d.toolName === 'knowledge.search' && d.decision === 'ask')).toBe(true)
  })
})

describe('回放 · 从 session 事件重建卡片', () => {
  it('重建结果与实时一致且可重复', async () => {
    const agent = await fixture.harness.agentFor(SCOPE)
    await fixture.harness.runTurn(agent, '想退款还来得及吗')
    await fixture.harness.runTurn(agent, '订单 ord-10086 到哪了')

    const first = cardsOf([...agent.session.events])
    const second = cardsOf([...agent.session.events])
    expect(first.length).toBeGreaterThanOrEqual(2)
    expect(first).toEqual(second)
  })
})
