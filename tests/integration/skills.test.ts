/**
 * 技能库集成测试：真实 `ctx.skills`（dsh）+ 真实 SKILL.md 文件。
 *
 * 重点验证两件事：
 * 1. 隔离——`includeDefaultRoots: false` 确实生效，不会把开发者机器上
 *    `~/.dsh/skills`、`~/.agents` 里的个人技能混进客服话术库
 * 2. 技能索引确实进入了 system prompt（model-visible ⟺ logged）
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { assembleHarness, type Harness } from '../../src/harness/assemble.js'
import { memoryPorts } from '../../src/harness/ports-memory.js'
import { resetScopes } from '../../src/harness/session-scope.js'

let harness: Harness
let dataDir: string
let skillsDir: string

/**
 * 写一个 SKILL.md。
 *
 * 注意 `metadata:` 的嵌套——dsh 的 filesystem provider 只识别
 * name/description/whenToUse/metadata 与两个 invocation 开关，
 * 其余顶层键一律忽略。OpenCS 的路由字段必须放在 metadata 之下。
 */
function writeSkill(
  name: string,
  description: string,
  metadata: Record<string, unknown> | undefined,
  body: string,
): void {
  mkdirSync(join(skillsDir, name), { recursive: true })
  const meta =
    metadata === undefined
      ? ''
      : `metadata:\n${Object.entries(metadata)
          .map(([key, value]) =>
            Array.isArray(value)
              ? `  ${key}:\n${value.map((item) => `    - ${String(item)}`).join('\n')}`
              : `  ${key}: ${String(value)}`,
          )
          .join('\n')}\n`
  writeFileSync(
    join(skillsDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${meta}---\n\n${body}\n`,
  )
}

async function boot(): Promise<void> {
  harness = await assembleHarness({
    config: loadConfig({
      OPENCS_DATA_DIR: dataDir,
      OPENCS_SKILLS_DIR: skillsDir,
      OPENCS_ENV: 'test',
      OPENCS_AUTO_APPROVE_TIERS: '0,1,2,3,4',
    }),
    ports: memoryPorts(),
  })
}

beforeEach(() => {
  resetScopes()
  dataDir = mkdtempSync(join(tmpdir(), 'opencs-skill-data-'))
  skillsDir = mkdtempSync(join(tmpdir(), 'opencs-skill-dir-'))
})

afterEach(async () => {
  await harness?.dispose()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(skillsDir, { recursive: true, force: true })
  resetScopes()
})

describe('DshSkillRepo · 加载与索引', () => {
  it('加载 SKILL.md 并解析 OpenCS 的路由语义', async () => {
    writeSkill(
      'refund',
      '处理退款请求',
      { priority: 80, routing: 'cs_reply', intent_signals: ['想退款', '退货'] },
      '先查政策再答复。',
    )
    await boot()

    const all = await harness.skills.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      name: 'refund',
      description: '处理退款请求',
      priority: 80,
      routing: 'cs_reply',
      intentSignals: ['想退款', '退货'],
    })
    expect(all[0]?.content).toContain('先查政策再答复')
  })

  it('索引按 priority 降序，含意图线索但**不含正文**（两轮法的成本控制点）', async () => {
    writeSkill('low', '低优先级', { priority: 10 }, '低优先级的很长很长的正文内容')
    writeSkill('high', '高优先级', { priority: 90, intent_signals: ['关键词'] }, '高优先级正文')
    await boot()

    const index = await harness.skills.buildIndex()
    expect(index.indexOf('high')).toBeLessThan(index.indexOf('low'))
    expect(index).toContain('（适用：关键词）')
    expect(index).not.toContain('很长很长的正文内容')
  })

  it('缺省 priority/routing 的技能也能加载', async () => {
    writeSkill('minimal', '只有描述', undefined, '正文')
    await boot()
    expect((await harness.skills.list())[0]).toMatchObject({ priority: 50, routing: 'cs_reply' })
  })

  it('load 按名字取正文', async () => {
    writeSkill('a', 'A', undefined, 'AAA 正文')
    writeSkill('b', 'B', undefined, 'BBB 正文')
    await boot()

    const loaded = await harness.skills.load(['b'])
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.content).toContain('BBB 正文')
  })

  it('模型幻觉出的技能名被静默跳过，不让整轮失败', async () => {
    writeSkill('a', 'A', undefined, 'AAA')
    await boot()
    await expect(harness.skills.load(['a', '并不存在的技能', ''])).resolves.toHaveLength(1)
  })

  it('load 对重复名字去重', async () => {
    writeSkill('a', 'A', undefined, 'AAA')
    await boot()
    expect(await harness.skills.load(['a', 'a'])).toHaveLength(1)
  })

  it('技能目录为空时索引为空串（而不是注入噪音）', async () => {
    await boot()
    expect(await harness.skills.buildIndex()).toBe('')
    expect(await harness.skills.list()).toEqual([])
  })
})

describe('技能库隔离', () => {
  it('不扫描 $DSH_HOME/skills 与 ~/.agents 的个人技能', async () => {
    writeSkill('project-only', '项目内技能', undefined, '正文')
    await boot()

    const names = (await harness.skills.list()).map((skill) => skill.name)
    // 只应看到项目目录里的技能。若 includeDefaultRoots 被误设为 true，
    // 开发者机器上的个人技能会出现在这里。
    expect(names).toEqual(['project-only'])
  })
})

describe('技能索引进入 system prompt', () => {
  it('索引作为 prompt section 被注入，且记入 session（model-visible ⟺ logged）', async () => {
    writeSkill('refund', '处理退款请求', { priority: 80 }, '先查政策')
    await boot()

    const agent = await harness.agentFor({
      tenantId: 'default',
      conversationId: 'skill-c1',
      channelId: 'webchat',
      customerId: 'u1',
    })
    await harness.runTurn(agent, '想退款还来得及吗')

    // request/header 或 request/context 事件里应能看到技能索引的痕迹
    const logged = JSON.stringify([...agent.session.events].map((event) => event.data))
    expect(logged).toContain('refund')
    expect(logged).toContain('处理退款请求')
  })
})
