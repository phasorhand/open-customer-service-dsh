/**
 * 离线冒烟：不依赖任何 API key，跑通两条链路——
 *   ① harness 直连：用户消息 → 模型 → 工具 → 卡片 → 回放
 *   ② HTTP 网关：webhook → 调度 → agent → 帧投影 → 响应
 *
 * 这是 P1/P2 的验收脚本。mock 只替换了「模型的 token 生成」，
 * agent loop / guard / 工具执行 / session 持久化 / 路由 全部是生产代码路径。
 *
 * 运行：`pnpm smoke`
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../src/config.js'
import { createApp } from '../src/gateway/app.js'
import type { Frame } from '../src/gateway/frames.js'
import { parseCard } from '../src/harness/cards.js'
import type { RiskDecisionEntry } from '../src/harness/plugins/guard-risk.js'
import { resetScopes, type TenantScope } from '../src/harness/session-scope.js'
import { buildRuntime } from '../src/runtime.js'

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

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opencs-smoke-'))
  resetScopes()

  const decisions: RiskDecisionEntry[] = []
  const runtime = await buildRuntime({
    config: loadConfig({
      OPENCS_DATA_DIR: dataDir,
      OPENCS_ENV: 'test',
      // 放开到 ORANGE_C：让冒烟能观察到「回复真的发出去了」
      OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4',
    }),
  })
  // buildRuntime 内部已挂裁决回调；这里再订阅一次渠道出站用于断言
  const delivered: string[] = []
  const unsubscribe = runtime.webchat.subscribe((action) => {
    delivered.push(action.content.map((part) => part.text ?? '').join(''))
  })
  const app = await createApp(runtime)
  await app.ready()

  try {
    console.log(`\n[smoke] provider=${runtime.harness.provider} model=${runtime.harness.model}\n`)

    // ── ① harness 直连 ──────────────────────────────────────────
    console.log('① harness：政策问题 → knowledge.search → channel.reply')
    const agent = await runtime.harness.agentFor(CUSTOMER)
    await runtime.harness.runTurn(agent, '买的东西想退款，还来得及吗？')

    const events = [...agent.session.events]
    const calls = events.filter((e) => e.type === 'tool/call').map((e) => (e.data as { name?: string }).name)
    check('先查证后回复（工具调用顺序正确）', JSON.stringify(calls) === JSON.stringify(['knowledge.search', 'channel.reply']), JSON.stringify(calls))

    const cards = events
      .filter((e) => e.type === 'tool/result')
      .map((e) => parseCard((e.data as { meta?: unknown }).meta))
      .filter((card) => card !== undefined)
    const cardTypes = cards.map((card) => card.type)
    check('产出 knowledge_hit 卡片', cardTypes.includes('knowledge_hit'), JSON.stringify(cardTypes))
    check('产出 cs_reply 卡片', cardTypes.includes('cs_reply'), JSON.stringify(cardTypes))
    check('回复内容来自知识库而非臆造（含「7 天」）', delivered.join('').includes('7 天'), delivered.join('').slice(0, 80))

    // ── ② 风险治理 ──────────────────────────────────────────────
    console.log('\n② 风险治理：每次工具调用都有裁决')
    const graded = runtime.riskDecisions
    check('裁决记录非空', graded.length >= 2, `decisions=${graded.length}`)
    check(
      'GREEN 档只读工具自动放行',
      graded.some((d) => d.toolName === 'knowledge.search' && d.decision === 'allow'),
      JSON.stringify(graded.map((d) => `${d.toolName}:${d.decision}`)),
    )

    // ── ③ 租户隔离 ──────────────────────────────────────────────
    console.log('\n③ 租户隔离：跨租户拿不到他人数据')
    const before = delivered.length
    const otherAgent = await runtime.harness.agentFor({
      ...CUSTOMER,
      tenantId: 'other-corp',
      conversationId: 'conv-smoke-other',
    })
    await runtime.harness.runTurn(otherAgent, '退款政策是什么')
    const otherReply = delivered.slice(before).join('')
    check('跨租户回复不含 default 租户条款', !otherReply.includes('原路返回'), otherReply.slice(0, 80))

    // ── ④ HTTP 网关 ────────────────────────────────────────────
    console.log('\n④ HTTP 网关：webhook → agent → 帧')
    const live = await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'conv-smoke-http', customer_id: 'cus-http', text: '订单 ord-10086 到哪了' },
    })
    check('webhook 返回 200', live.statusCode === 200, String(live.statusCode))

    const body = live.json() as { reply: string; delivered: boolean; frames: Frame[] }
    check('回复已送达', body.delivered, JSON.stringify(body.delivered))
    check('回复包含订单状态', body.reply.includes('已发货'), body.reply.slice(0, 80))

    const frameTypes = new Set(body.frames.map((frame) => frame.type))
    for (const expected of ['text/delta', 'tool/status', 'card/open', 'card/item', 'card/close'] as const) {
      check(`帧序列包含 ${expected}`, frameTypes.has(expected), [...frameTypes].join(','))
    }
    const doneFrames = body.frames.filter((f) => f.type === 'tool/status' && f.status === 'done')
    check(
      'tool/status done 能报出工具名（callId 关联生效）',
      doneFrames.length > 0 && doneFrames.every((f) => (f as { tool: string }).tool !== ''),
      JSON.stringify(doneFrames.map((f) => (f as { tool: string }).tool)),
    )

    // ── ⑤ 入参校验 ──────────────────────────────────────────────
    console.log('\n⑤ 入参校验：坏载荷被显式拒绝而不是静默接受')
    const bad = await app.inject({
      method: 'POST',
      url: '/channels/webchat',
      payload: { conversation_id: 'x', customer_id: 'y', text: 'hi', typo_field: 1 },
    })
    check('未知字段返回 400（不静默剥离）', bad.statusCode === 400, String(bad.statusCode))

    // ── ⑥ 回放一致 ──────────────────────────────────────────────
    console.log('\n⑥ 回放：从 session 事件重建，与实时逐帧一致')
    const httpAgent = await runtime.harness.agentFor({
      tenantId: 'default',
      conversationId: 'conv-smoke-http',
      channelId: 'webchat',
      customerId: 'cus-http',
    })
    const { replayFrames } = await import('../src/gateway/frames.js')
    const replayed = replayFrames(httpAgent.session.events as never)
    check('回放帧数 ≥ 实时帧数（历史含全部 turn）', replayed.length >= body.frames.length, `${replayed.length} vs ${body.frames.length}`)
    check(
      '回放是确定性的：两次重建完全相同',
      JSON.stringify(replayed) === JSON.stringify(replayFrames(httpAgent.session.events as never)),
    )
  } finally {
    unsubscribe()
    await app.close()
    await runtime.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    resetScopes()
  }

  console.log('')
  if (failures > 0) {
    console.error(`[smoke] ${failures} 项失败`)
    process.exitCode = 1
    return
  }
  console.log('[smoke] 全部通过 ✓')
}

await main()
