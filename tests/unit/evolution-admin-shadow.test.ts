/**
 * 管理端演进提案：影子验证证据的持久化与 API 暴露。
 *
 * 影子验证（curate）在 propose 时计算，但若只存在工具返回里，管理端审批时
 * 看不到「重跑是否真的修了坏例」。这条测试验证：
 *   ① setShadowVerdict 把 verdict/divergences 持久化进提案 payload（不丢、不覆盖既有字段）
 *   ② /admin/proposals 列表与 /admin/proposals/:id 都带出 shadowVerdict
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { IN_MEMORY, openDb, type Db } from '../../src/db/sqlite.js'
import { EVOLUTION_MIGRATIONS, ProposalStore } from '../../src/evolution/store.js'
import { createApp } from '../../src/gateway/app.js'
import { resetScopes } from '../../src/harness/session-scope.js'
import { buildRuntime, type OpenCsRuntime } from '../../src/runtime.js'

const INPUT = {
  tenantId: 'default',
  dimension: 'knowledge' as const,
  action: 'create' as const,
  title: '缺少国际配送条款',
  rationale: '客户询问海外发货，知识库无相关条款，agent 答错了',
  payload: { suggestion: '补充国际配送政策' },
  evidence: ['客户原话：你们发不发国际？'],
  confidence: 0.6,
  sourceConversationId: 'conv-bad',
}

describe('ProposalStore.setShadowVerdict · 影子验证证据持久化', () => {
  let db: Db
  afterEach(() => db.close())

  function makeStore(): ProposalStore {
    db = openDb(IN_MEMORY, EVOLUTION_MIGRATIONS)
    return new ProposalStore(db)
  }

  it('verdict 写进 payload，读回一致（不是内存快照）', () => {
    const proposals = makeStore()
    const { proposal } = proposals.propose(INPUT)

    proposals.setShadowVerdict(proposal.id, 'badcase_fixed', [
      { kind: 'content_changed', baseline: '我会给你全额退款', replay: '我帮你查一下政策' },
    ])

    const reloaded = proposals.require(proposal.id)
    expect(reloaded.payload.shadowVerdict).toBe('badcase_fixed')
    expect(reloaded.payload.shadowDivergences).toEqual([
      { kind: 'content_changed', baseline: '我会给你全额退款', replay: '我帮你查一下政策' },
    ])
  })

  it('只写影子字段，不覆盖既有 payload（suggestion 保留）', () => {
    const proposals = makeStore()
    const { proposal } = proposals.propose(INPUT)

    const updated = proposals.setShadowVerdict(proposal.id, 'inconclusive')

    expect(updated.payload.suggestion).toBe('补充国际配送政策')
    expect(updated.payload.shadowVerdict).toBe('inconclusive')
  })

  it('无 divergences 时默认为空数组', () => {
    const proposals = makeStore()
    const { proposal } = proposals.propose(INPUT)

    expect(proposals.setShadowVerdict(proposal.id, 'badcase_remains').payload.shadowDivergences).toEqual([])
  })

  it('不存在的提案抛错', () => {
    const proposals = makeStore()
    expect(() => proposals.setShadowVerdict('nope', 'inconclusive')).toThrow(/不存在/)
  })
})

describe('管理端提案 API · 带出影子验证结论', () => {
  let app: FastifyInstance
  let runtime: OpenCsRuntime
  let dataDir: string

  beforeEach(async () => {
    resetScopes()
    dataDir = mkdtempSync(join(tmpdir(), 'opencs-evolution-shadow-'))
    runtime = await buildRuntime({
      config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' }),
    })
    app = await createApp(runtime)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await runtime.dispose()
    rmSync(dataDir, { recursive: true, force: true })
    resetScopes()
  })

  it('列表项带 top-level shadowVerdict（persist 后）', async () => {
    const { proposal } = runtime.proposals.propose(INPUT)
    runtime.proposals.setShadowVerdict(proposal.id, 'badcase_fixed')

    const body = (await app.inject({ method: 'GET', url: '/admin/proposals' })).json() as {
      items: { id: string; shadowVerdict: string | null; payload: { shadowVerdict?: string } }[]
    }
    const item = body.items.find((p) => p.id === proposal.id)
    expect(item?.shadowVerdict).toBe('badcase_fixed')
    // payload 里也持久化了（detail 直接复用 proposal 对象，双保险）
    expect(item?.payload.shadowVerdict).toBe('badcase_fixed')
  })

  it('未做影子验证的提案 shadowVerdict 为 null（前端展示「未验证」）', async () => {
    const { proposal } = runtime.proposals.propose(INPUT)

    const body = (await app.inject({ method: 'GET', url: '/admin/proposals' })).json() as {
      items: { id: string; shadowVerdict: string | null }[]
    }
    const item = body.items.find((p) => p.id === proposal.id)
    expect(item?.shadowVerdict).toBeNull()
  })

  it('详情带 top-level shadowVerdict', async () => {
    const { proposal } = runtime.proposals.propose(INPUT)
    runtime.proposals.setShadowVerdict(proposal.id, 'badcase_remains')

    const body = (await app.inject({ method: 'GET', url: '/admin/proposals/' + proposal.id })).json() as {
      proposal: { payload: { shadowVerdict?: string } }
      shadowVerdict: string | null
    }
    expect(body.shadowVerdict).toBe('badcase_remains')
    expect(body.proposal.payload.shadowVerdict).toBe('badcase_remains')
  })
})
