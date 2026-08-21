/**
 * 知识库端到端：真实 FTS5 store + 真实 Markdown 文件 + 真实 agent。
 *
 * 验收目标（plan §P3）：**改一个 .md 文件，热重载后新答案立即生效**——
 * 这是「运营自己维护知识库、不需要发版」的核心能力，必须端到端证明。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { createApp } from '../../src/gateway/app.js'
import { resetScopes } from '../../src/harness/session-scope.js'
import { buildRuntime, type OpenCsRuntime } from '../../src/runtime.js'

let app: FastifyInstance
let runtime: OpenCsRuntime
let dataDir: string
let knowledgeDir: string

async function boot(): Promise<void> {
  runtime = await buildRuntime({
    config: loadConfig({
      OPENCS_DATA_DIR: dataDir,
      OPENCS_KNOWLEDGE_DIR: knowledgeDir,
      OPENCS_ENV: 'test',
      OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4',
    }),
    watchKnowledge: true,
  })
  app = await createApp(runtime)
  await app.ready()
}

beforeEach(async () => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-kb-e2e-data-'))
  knowledgeDir = mkdtempSync(join(tmpdir(), 'opencs-kb-e2e-kb-'))
  writeFileSync(
    join(knowledgeDir, 'refund.md'),
    '# 售后\n\n## 退款政策\n\n签收后 7 天内可无理由退款，退款原路返回。\n',
  )
  await boot()
})

afterEach(async () => {
  await app.close()
  await runtime.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(knowledgeDir, { recursive: true, force: true })
  resetScopes()
})

const ask = async (text: string, conversationId = 'kb-c1'): Promise<string> => {
  const response = await app.inject({
    method: 'POST',
    url: '/channels/webchat',
    payload: { conversation_id: conversationId, customer_id: 'kb-u1', text },
  })
  return (response.json() as { reply: string }).reply
}

describe('知识库端到端', () => {
  it('启动时全量索引，答案来自真实 Markdown 文件', async () => {
    expect(await ask('想退款还来得及吗')).toMatch(/7\s*天/)
  })

  it('索引状态可查', () => {
    expect(runtime.knowledge.status('default').sourceFileCount).toBe(1)
    expect(runtime.knowledge.listSources('default')).toEqual(['refund.md'])
  })

  it('改 .md 文件后，新答案立即生效（无需重启）', async () => {
    expect(await ask('想退款还来得及吗', 'kb-before')).toMatch(/7\s*天/)

    writeFileSync(
      join(knowledgeDir, 'refund.md'),
      '# 售后\n\n## 退款政策\n\n政策已调整：签收后 30 天内均可无理由退款。\n',
    )
    await waitFor(() => runtime.knowledge.searchSync('default', '30 天', 3).length > 0)

    const updated = await ask('想退款还来得及吗', 'kb-after')
    expect(updated).toMatch(/30\s*天/)
    expect(updated).not.toMatch(/7\s*天/)
  })

  it('新增 .md 文件后其内容可被检索到', async () => {
    writeFileSync(join(knowledgeDir, 'invoice.md'), '# 财务\n\n## 发票开具\n\n电子发票 48 小时内开具。\n')
    await waitFor(() => runtime.knowledge.searchSync('default', '发票', 3).length > 0)
    expect(await ask('怎么开发票', 'kb-invoice')).toMatch(/48\s*小时/)
  })

  it('知识库查不到时，模型被要求如实说明而不是编造', async () => {
    const hits = runtime.knowledge.searchSync('default', '完全不存在的话题zzz', 3)
    expect(hits).toEqual([])
    // render() 在零命中时给模型的指令包含「不要编造」
    const reply = await ask('你们支持火星配送吗', 'kb-none')
    expect(reply).not.toMatch(/支持火星/)
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('等待条件超时')
}
