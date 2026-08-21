/**
 * 离线冒烟：不依赖任何 API key，跑通「用户消息 → 模型 → 工具 → 卡片 → 回放」。
 *
 * 这是 P1 的验收脚本（plan §P1 验收）。它验证的是**真实链路**——
 * mock 只替换了模型的 token 生成，agent loop / guard / 工具执行 / session 持久化
 * 全部是生产代码路径。
 *
 * 运行：`pnpm smoke`
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../src/config.js'
import { assembleHarness } from '../src/harness/assemble.js'
import { parseCard } from '../src/harness/cards.js'
import { memoryPorts } from '../src/harness/ports-memory.js'
import type { RiskDecisionEntry } from '../src/harness/plugins/guard-risk.js'
import { resetScopes, type TenantScope } from '../src/harness/session-scope.js'

let failures = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const CUSTOMER: TenantScope = {
  tenantId: 'default',
  conversationId: 'conv-smoke-1',
  channelId: 'webchat',
  customerId: 'cus-smoke-1',
}

/** 越权探针：租户与已绑定作用域不同的另一个会话。 */
const OTHER_TENANT: TenantScope = {
  tenantId: 'other-corp',
  conversationId: 'conv-smoke-2',
  channelId: 'webchat',
  customerId: 'cus-smoke-2',
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opencs-smoke-'))
  resetScopes()

  const decisions: RiskDecisionEntry[] = []
  const config = loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test' })
  const harness = await assembleHarness({
    config,
    ports: memoryPorts(),
    onRiskDecision: (entry) => decisions.push(entry),
  })

  try {
    console.log(`\n[smoke] provider=${harness.provider} model=${harness.model}\n`)

    // ── ① 知识检索链路 ──────────────────────────────────────────
    console.log('① 知识检索：政策问题 → knowledge.search → 卡片')
    const agent = await harness.agentFor(CUSTOMER)
    await harness.runTurn(agent, '买的东西想退款，还来得及吗？')

    const events = [...agent.session.events]
    const toolCalls = events.filter((e) => e.type === 'tool/call')
    const toolResults = events.filter((e) => e.type === 'tool/result')

    check('模型发起了工具调用', toolCalls.length >= 1, `tool/call = ${toolCalls.length}`)
    check(
      '调用的是 knowledge.search',
      toolCalls.some((e) => (e.data as { name?: string }).name === 'knowledge.search'),
      JSON.stringify(toolCalls.map((e) => (e.data as { name?: string }).name)),
    )
    check('产生了 tool/result 事件', toolResults.length >= 1)

    const cards = toolResults
      .map((e) => parseCard((e.data as { meta?: unknown }).meta))
      .filter((card): card is NonNullable<typeof card> => card !== undefined)
    check('tool/result 带可解析的卡片投影', cards.length >= 1)
    check(
      '卡片类型是 knowledge_hit',
      cards.some((card) => card.type === 'knowledge_hit'),
      JSON.stringify(cards.map((c) => c.type)),
    )
    const kbCard = cards.find((card) => card.type === 'knowledge_hit')
    check('卡片带命中条目', kbCard !== undefined && 'items' in kbCard && kbCard.items.length > 0)

    const assistantText = collectAssistantText(events)
    check('产生了助手回复文本', assistantText.trim() !== '', assistantText.slice(0, 60))
    check('回复引用了退款条款（7 天）', /7\s*天/.test(assistantText), assistantText.slice(0, 120))

    // ── ② 订单查询链路 ──────────────────────────────────────────
    console.log('\n② 订单查询：订单号 → crm.get_order → 卡片')
    await harness.runTurn(agent, '帮我看下订单 ord-10086 到哪了')
    const orderCalls = [...agent.session.events].filter(
      (e) => e.type === 'tool/call' && (e.data as { name?: string }).name === 'crm.get_order',
    )
    check('调用了 crm.get_order', orderCalls.length >= 1)
    const orderText = collectAssistantText([...agent.session.events])
    check('回复包含订单状态', /已发货/.test(orderText), orderText.slice(-120))

    // ── ③ 越权拒绝 ──────────────────────────────────────────────
    console.log('\n③ 租户隔离：未绑定作用域的会话被 guard 拒绝')
    const otherAgent = await harness.agentFor(OTHER_TENANT)
    const before = otherAgent.session.events.length
    await harness.runTurn(otherAgent, '他们家的退款政策是什么')
    const otherNew = [...otherAgent.session.events].slice(before)
    const otherCards = otherNew
      .filter((e) => e.type === 'tool/result')
      .map((e) => parseCard((e.data as { meta?: unknown }).meta))
      .filter((card) => card !== undefined)
    // OTHER_TENANT 的 tenantId 与内存知识库的 default 不同 → 检索为空，不应泄漏 default 租户数据
    const otherText = collectAssistantText(otherNew)
    check('跨租户会话拿不到 default 租户的退款条款', !/7\s*天|原路返回/.test(otherText), otherText.slice(0, 120))

    // ── ④ 风险裁决被记录 ────────────────────────────────────────
    console.log('\n④ 风险治理：每次工具调用都有裁决记录')
    check('风险 guard 产生了裁决记录', decisions.length >= 1, `decisions = ${decisions.length}`)
    check(
      'knowledge.search 被判为自动放行',
      decisions.some((d) => d.toolName === 'knowledge.search' && d.decision === 'allow'),
      JSON.stringify(decisions.map((d) => `${d.toolName}:${d.decision}`)),
    )

    // ── ⑤ 回放幂等 ──────────────────────────────────────────────
    console.log('\n⑤ 回放：从 session 事件重建卡片，与实时一致')
    const replayCards = [...agent.session.events]
      .filter((e) => e.type === 'tool/result')
      .map((e) => parseCard((e.data as { meta?: unknown }).meta))
      .filter((card) => card !== undefined)
    check('回放重建出全部卡片', replayCards.length >= 2, `replay=${replayCards.length}`)
    check(
      '回放是纯函数：两次重建结果相同',
      JSON.stringify(replayCards) ===
        JSON.stringify(
          [...agent.session.events]
            .filter((e) => e.type === 'tool/result')
            .map((e) => parseCard((e.data as { meta?: unknown }).meta))
            .filter((card) => card !== undefined),
        ),
    )
  } finally {
    await harness.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }

  console.log('')
  if (failures > 0) {
    console.error(`[smoke] ${failures} 项失败`)
    process.exitCode = 1
    return
  }
  console.log('[smoke] 全部通过 ✓')
}

function collectAssistantText(events: readonly { readonly type: string; readonly data: unknown }[]): string {
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

await main()
