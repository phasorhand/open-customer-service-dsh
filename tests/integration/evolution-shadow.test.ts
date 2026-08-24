/**
 * 影子运行器集成测试。
 *
 * 纪律同 harness.test.ts：走真实 assembleHarness()，只替换「模型 token 生成」
 * 与「数据端口」。影子运行必须能复用同一个 ctx 创建一个全新 agent 并同输入重跑。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { assembleHarness, type Harness } from '../../src/harness/assemble.js'
import { resetMockCallIds } from '../../src/harness/mock-llm.js'
import { memoryPorts, RecordingOutbound } from '../../src/harness/ports-memory.js'
import { resetScopes } from '../../src/harness/session-scope.js'
import { diffFrames } from '../../src/evolution/differ.js'
import { runShadowTurn } from '../../src/evolution/shadow.js'

const AUTO_REPLY = { OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4' } as const

interface Fixture {
  readonly harness: Harness
  readonly dataDir: string
}
const built: Fixture[] = []

async function build(env: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opencs-shadow-'))
  const harness = await assembleHarness({
    config: loadConfig({ OPENCS_DATA_DIR: dataDir, OPENCS_ENV: 'test', ...AUTO_REPLY, ...env }),
    ports: memoryPorts(undefined, undefined, new RecordingOutbound()),
  })
  const fixture = { harness, dataDir }
  built.push(fixture)
  return fixture
}

beforeEach(() => resetScopes())
afterEach(async () => {
  for (const f of built.splice(0)) {
    await f.harness.dispose()
    rmSync(f.dataDir, { recursive: true, force: true })
  }
  resetScopes()
})

describe('runShadowTurn · 同输入重跑', () => {
  it('同输入重跑产出 replay frames', async () => {
    resetMockCallIds()
    const { harness } = await build()
    const result = await runShadowTurn(harness, { text: '想退款还来得及吗' })
    expect(result.replayFrames.length).toBeGreaterThan(0)
    // 影子 agent 必须真的走通业务工具（scope 已绑定并生效），
    // 而不是退化到 guard 的「缺作用域」拒绝路径——否则重跑毫无意义。
    const framesText = result.replayFrames.map((f) => f.text ?? '').join('')
    expect(framesText).not.toMatch(/缺少必要的权限上下文|缺少租户作用域/)
  })

  it('与生产 agent 的帧可对比（badcase 锚点判定）', async () => {
    const { harness } = await build()
    // 先跑一次真实会话，得到 baseline frames（同输入）
    const baseline = await runShadowTurn(harness, { text: '想退款还来得及吗' })
    // 再跑一次影子（同输入）——两次 mock 输出应一致 → diff 无差异
    resetMockCallIds()
    const replay = await runShadowTurn(harness, { text: '想退款还来得及吗' })
    const result = diffFrames(baseline.replayFrames, replay.replayFrames, { badcaseText: '全额退款' })
    expect(['inconclusive', 'badcase_fixed']).toContain(result.verdict)
    // 明确断言：同一 mock 输入两次运行，badcase 锚点「全额退款」都不出现 → 不 remains
    expect(result.verdict).not.toBe('badcase_remains')
  })
})
