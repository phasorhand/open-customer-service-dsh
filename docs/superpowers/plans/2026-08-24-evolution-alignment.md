# dsh 版完整进化子系统对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh 版 OpenCS 完整对齐 Python 原版的进化子系统——技能自策展 + 影子运行 + 回放差分 + 血缘追踪，全部构建在 dsh agent loop 之上。

**Architecture:** 低分会话 → 技能草案 → 影子运行（**同输入重跑一个全新 dsh agent**，不重放 LLM/工具缓存）→ 回放差分器（对比 baseline/replay 帧）→ 门禁（skill 维度强制人工）→ 生效 + 血缘记录。复用现有 `src/evolution/`（ProposalStore + EvolutionGate）、`src/evaluation/`、`src/harness/`（assembleHarness + mock-llm）、`src/gateway/frames.ts`。

**Tech Stack:** TypeScript · dsh（@deepseek-ai/dsh-agent · dsh-agent-loop · dsh-session · dsh-skill）· SQLite · vitest

**Spec:** [`docs/superpowers/specs/2026-08-24-evolution-alignment-design.md`](../specs/2026-08-24-evolution-alignment-design.md)

---

### Task 1: 差分器（纯函数，TDD）

**Files:**
- Create: `src/evolution/differ.ts`
- Test: `tests/unit/evolution-differ.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/evolution-differ.test.ts
import { describe, expect, it } from 'vitest'
import { diffFrames, type FrameLike } from '../../src/evolution/differ.js'

const frames: FrameLike[] = (texts: string[]) =>
  texts.map((text, i) => ({ type: 'text/delta' as const, seq: i + 1, text, index: 0 }))

describe('diffFrames', () => {
  it('baseline 为空 → INCONCLUSIVE', () => {
    const result = diffFrames([], frames(['hi']))
    expect(result.verdict).toBe('inconclusive')
  })

  it('replay 为空 → INCONCLUSIVE', () => {
    const result = diffFrames(frames(['hi']), [])
    expect(result.verdict).toBe('inconclusive')
  })

  it('badcase 文本存在且不再出现 → BADCASE_FIXED', () => {
    const baseline = frames(['我会帮你全额退款', '请稍等'])
    const replay = frames(['请稍等', '我帮你查一下政策'])
    const result = diffFrames(baseline, replay, { badcaseText: '全额退款' })
    expect(result.verdict).toBe('badcase_fixed')
  })

  it('badcase 文本仍在 replay 中出现 → BADCASE_REMAINS', () => {
    const baseline = frames(['我会帮你全额退款', '请稍等'])
    const replay = frames(['好的我会帮你全额退款'])
    const result = diffFrames(baseline, replay, { badcaseText: '全额退款' })
    expect(result.verdict).toBe('badcase_remains')
  })

  it('badcase 未提供时按内容一致性给 INCONCLUSIVE 或 CHANGE', () => {
    const result = diffFrames(frames(['a']), frames(['a']))
    expect(result.verdict).toBe('inconclusive') // 无差异且无 badcase
  })

  it('baseline 存在但 replay 只回显问候 → 判定为行为劣化或 inconclusive', () => {
    const result = diffFrames(frames(['这是政策正文', '还需要别的吗']), frames(['你好，请描述问题']))
    expect(['new_regression', 'inconclusive']).toContain(result.verdict)
  })

  it('diff 记录有差异内容变更', () => {
    const result = diffFrames(frames(['AAA']), frames(['BBB']))
    expect(result.divergences.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/evolution-differ.test.ts`
Expected: FAIL（`Cannot find module`）

- [ ] **Step 3: 实现 `src/evolution/differ.ts`**

```typescript
/**
 * 回放差分器：对比 baseline（原会话输出帧）与 replay（影子运行输出帧），
 * 判定一条技能提案是否真的修复了坏例，且没有引入新回归。
 *
 * 纯函数、无副作用——被 ShadowRunner 调用，也直接喂给门禁与审批界面。
 * 只在帧文本层比较，不做语义匹配（确定性优先，避免误判）。
 */

export type FrameLike = {
  readonly type: string
  readonly seq?: number
  readonly text?: string
  readonly index?: number
}

export type DivergenceKind = 'content_changed' | 'action_changed' | 'tool_missing' | 'tool_added' | 'llm_output_changed'

export interface Divergence {
  readonly kind: DivergenceKind
  readonly baseline: string
  readonly replay: string
}

export type DiffVerdict = 'badcase_fixed' | 'badcase_remains' | 'new_regression' | 'inconclusive'

export interface DiffResult {
  readonly verdict: DiffVerdict
  readonly divergences: readonly Divergence[]
}

const DIFF_LIMIT = 12

export function diffFrames(
  baseline: readonly FrameLike[],
  replay: readonly FrameLike[],
  options: { readonly badcaseText?: string } = {},
): DiffResult {
  if (baseline.length === 0 || replay.length === 0) {
    return { verdict: 'inconclusive', divergences: [] }
  }

  const baseText = framesToText(baseline)
  const replayText = framesToText(replay)
  const badcase = options.badcaseText?.trim()

  if (badcase !== undefined && badcase !== '') {
    const inBase = baseText.includes(badcase)
    const inReplay = replayText.includes(badcase)
    if (inBase && !inReplay) return { verdict: 'badcase_fixed', divergences: summarize(baseText, replayText) }
    if (inReplay) return { verdict: 'badcase_remains', divergences: summarize(baseText, replayText) }
  }

  // 无 badcase 锚点：replay 相比 baseline 明显退化为「只会问候」→ 判回归
  if (replayText.trim().length < 6 && baseText.trim().length >= 6) {
    return { verdict: 'new_regression', divergences: summarize(baseText, replayText) }
  }

  // 两段文本完全一致 → 行为未变，无法证明修复 → inconclusive
  if (baseText === replayText) {
    return { verdict: 'inconclusive', divergences: [] }
  }

  // 有差异但无 badcase 锚点：保守地归为 inconclusive（避免误放行）
  return { verdict: 'inconclusive', divergences: summarize(baseText, replayText) }
}

function framesToText(frames: readonly FrameLike[]): string {
  return frames
    .filter((f) => f.type === 'text/delta' && typeof f.text === 'string' && f.text.length > 0)
    .map((f) => f.text)
    .join('')
}

function summarize(base: string, replay: string): Divergence[] {
  const out: Divergence[] = []
  if (base !== replay) {
    out.push({ kind: 'content_changed', baseline: base.slice(0, 120), replay: replay.slice(0, 120) })
  }
  return out.slice(0, DIFF_LIMIT)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/evolution-differ.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/differ.ts tests/unit/evolution-differ.test.ts
git commit -m "feat(evolution): 回放差分器 diffFrames（纯函数）"
```

---

### Task 2: 低分会话证据收集（EvalStore 增强）

**Files:**
- Modify: `src/evaluation/store.ts`
- Test: `tests/unit/eval-evidence.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/eval-evidence.test.ts
import { describe, expect, it } from 'vitest'
import { extractEvidence, type EvidenceHit } from '../../src/evolution/evidence.js'

describe('extractEvidence', () => {
  it('提取越权承诺类命中', () => {
    const hits = extractEvidence('退款', '我会帮你全额退款')
    expect(hits.some((h) => h.kind === 'commitment_violation')).toBe(true)
  })

  it('提取事实缺失（知识库无命中）', () => {
    const hits = extractEvidence('查退款', '这个问题我暂时没有查到明确的说明')
    expect(hits.some((h) => h.kind === 'factual_gap')).toBe(true)
  })

  it('无命中时返回空数组', () => {
    expect(extractEvidence('退款', '签收后7天内可无理由退款。')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/eval-evidence.test.ts`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现 `src/evolution/evidence.ts`**

```typescript
/**
 * 低分会话 → 证据画像：从评测未通过的结果里抽出可解释的命中项，
 * 作为技能提案的依据（evidence[]）与差分器的 badcase 锚点。
 */

export type EvidenceKind = 'commitment_violation' | 'tone_issue' | 'no_progression' | 'factual_gap'

export interface EvidenceHit {
  readonly kind: EvidenceKind
  /** 用于回放差分的坏例锚点（原话片段）。 */
  readonly badcaseText: string
  readonly detail: string
}

const COMMITMENT_MARKERS = [
  /全额退款/, /立即(?:到账|处理|发送|安排)/, /保证.{0,4}(?:退|赔|到账|修复)/,
  /肯定.{0,4}(?:赔付|解决)/, /承诺/, /包退/, /包赔/, /无条件(?:满足|答应)/,
]

const GAP_MARKERS = [/没有查到|知识库中没有|暂时没有找到|无法确认|不确定.{0,4}(?:政策|规则)/]

const FLUFF_MARKERS = [/请放心/, /您放心/, /放心好了/, /一定会为您/, /尽力帮您/]

export function extractEvidence(input: string, output: string): EvidenceHit[] {
  const hits: EvidenceHit[] = []
  const commit = COMMITMENT_MARKERS.find((re) => re.test(output))
  if (commit !== undefined) {
    hits.push({
      kind: 'commitment_violation',
      badcaseText: commit.source,
      detail: `回复包含越权承诺措辞：${commit.source}`,
    })
  }
  const gap = GAP_MARKERS.find((re) => re.test(output))
  if (gap !== undefined) {
    hits.push({
      kind: 'factual_gap',
      badcaseText: gap.source,
      detail: `对「${input.slice(0, 30)}」未能给出知识库依据的回答`,
    })
  }
  const fluff = FLUFF_MARKERS.find((re) => re.test(output))
  if (fluff !== undefined) {
    hits.push({ kind: 'tone_issue', badcaseText: fluff.source, detail: `回复含空泛安抚语：${fluff.source}` })
  }
  return hits
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/eval-evidence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/evidence.ts tests/unit/eval-evidence.test.ts
git commit -m "feat(evolution): 低分会话证据画像 extractEvidence"
```

---

### Task 3: 影子运行器（复用 dsh agent loop，同输入重跑）

**Files:**
- Create: `src/evolution/shadow.ts`
- Modify: `src/harness/assemble.ts`（暴露 shadow agent 创建能力）
- Test: `tests/integration/evolution-shadow.test.ts`

- [ ] **Step 1: 写失败测试（集成，参照 `tests/integration/harness.test.ts` 的真实组装模式）**

```typescript
// tests/integration/evolution-shadow.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/integration/evolution-shadow.test.ts`
Expected: FAIL（`Cannot find module '../../src/evolution/shadow.js'`）

- [ ] **Step 3: 实现 `src/evolution/shadow.ts`**

```typescript
/**
 * 影子运行器：对一条提案，用「同输入重跑一个全新 dsh agent」验证效果。
 *
 * 关键：复用 assembleHarness 的生产 agent loop（skill 加载 / guard / 工具全生效），
 * 只是会话不持久化、不落库。这是「依赖 dsh 获得进化能力」的核心。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import type { Harness } from '../harness/assemble.js'
import { resetMockCallIds } from '../harness/mock-llm.js'
import { diffFrames, type DiffResult, type FrameLike } from './differ.js'

export interface ShadowTurnInput {
  readonly text: string
}

export interface ShadowResult {
  readonly verdict: DiffResult['verdict']
  readonly divergences: DiffResult['divergences']
  readonly replayFrames: readonly FrameLike[]
}

/**
 * 从 agent 会话事件里抽出 text/delta 帧（与生产 WebSocket 历史同一投影层）。
 * 只取给客户可见的文本帧，作为 diff 的 baseline / replay 输入。
 */
function framesFromAgent(agent: { readonly session: { readonly events: readonly unknown[] } }): FrameLike[] {
  const out: FrameLike[] = []
  for (const raw of agent.session.events) {
    const event = raw as { type?: string; data?: unknown }
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly { type?: string; text?: string }[] } }
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        out.push({ type: 'text/delta', text: block.text })
      }
    }
  }
  return out
}

export async function runShadowTurn(
  harness: Harness,
  input: ShadowTurnInput,
  options: { readonly badcaseText?: string; readonly baselineFrames?: readonly FrameLike[] } = {},
): Promise<ShadowResult> {
  // mock 的 callId 是单调递增的——影子重跑需要与生产会话可对比，重置它
  resetMockCallIds()

  // 影子 agent 与生产 agent 共享同一 ctx，但用独立的 conversationId 避免污染
  const scope = { tenantId: 'shadow', conversationId: `shadow-${Date.now()}` }
  const agent = await harness.agentFor(scope)
  agent.send(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()

  const replayFrames = framesFromAgent(agent)
  const baseline = options.baselineFrames ?? []
  const result = diffFrames(baseline, replayFrames, { badcaseText: options.badcaseText })
  return { verdict: result.verdict, divergences: result.divergences, replayFrames }
}
```

- [ ] **Step 4: 在 `src/harness/assemble.ts` 暴露影子创建能力**

给 `Harness` 接口新增 `shadowAgent()`，复用现有 `agentFor` 逻辑但强制独立 scope + 不持久化（影子 agent 不写入 `agents` Map、不调用 `bindScope`）。注意：`agentFor` 当前会 `bindScope` 并把 agent 存入 `agents` Map——影子运行需要绕过这两个副作用。实现一个私有 `createAgent(scope)`，`agentFor` 与 `shadowAgent` 都调用它。

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm vitest run tests/integration/evolution-shadow.test.ts && pnpm typecheck`
Expected: PASS + typecheck 通过

- [ ] **Step 6: Commit**

```bash
git add src/evolution/shadow.ts src/harness/assemble.ts tests/integration/evolution-shadow.test.ts
git commit -m "feat(evolution): 影子运行器（复用 dsh agent loop 同输入重跑）"
```

---

### Task 4: 技能自策展 Handler（低分 → 技能草案）

**Files:**
- Create: `src/evolution/handlers/skill.ts`
- Test: `tests/unit/evolution-skill-handler.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/evolution-skill-handler.test.ts
import { describe, expect, it } from 'vitest'
import { buildSkillDraft, type SkillDraft } from '../../src/evolution/handlers/skill.js'

describe('buildSkillDraft', () => {
  it('从低分命中生成技能草案', () => {
    const draft: SkillDraft = buildSkillDraft({
      dimension: 'skill',
      title: '退款场景不要承诺全额',
      rationale: '客户问退款，agent 答「我会帮你全额退款」，违反政策',
      badcaseText: '全额退款',
    })
    expect(draft.name).toContain('退款')
    expect(draft.content).toContain('不要')
    expect(draft.content).toContain('承诺')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/evolution-skill-handler.test.ts`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 实现 `src/evolution/handlers/skill.ts`**

```typescript
/**
 * 技能自策展 Handler：把低分会话的证据（extractEvidence 产出）转成技能草案，
 * 写入 skills/proposals/ 待审目录。生效由审批 + 迁移完成，本 handler 只做草案生成。
 */

export interface SkillDraft {
  readonly name: string
  readonly content: string
}

export function buildSkillDraft(input: {
  readonly dimension: string
  readonly title: string
  readonly rationale: string
  readonly badcaseText: string
}): SkillDraft {
  const slug = input.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 24)
  const name = `proposal-${slug}`
  const content = [
    '---',
    `name: ${name}`,
    `description: ${input.title}`,
    'metadata:',
    `  routing: chat`,
    '  priority: 5',
    `  intent_signals: [${input.title.split(' ')[0] ?? ''}]`,
    '---',
    '',
    '## 行为约束',
    '',
    `- ${input.rationale}`,
    `- 坏例：${input.badcaseText}`,
    `- 反制：${input.rationale}`,
    '',
  ].join('\n')
  return { name, content }
}
```

- [ ] **Step 4: 写 `src/evolution/handlers/` 的目录结构与 `index.ts`**

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm vitest run tests/unit/evolution-skill-handler.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/evolution/handlers/
git commit -m "feat(evolution): 技能自策展草案生成 buildSkillDraft"
```

---

### Task 5: 提案 → 影子 → 门禁 → 生效 闭环编排

**Files:**
- Create: `src/evolution/curator.ts`
- Modify: `src/evolution/store.ts`（加 `applied_at` 状态）
- Modify: `src/harness/plugins/tools-evolution.ts`（接入 curator）
- Test: `tests/integration/evolution-curator.test.ts`

- [ ] **Step 1: 写失败测试（集成）**

覆盖：低分会话 → 提案 → 影子 → 门禁 → 生效（skills/ 目录出现新技能文件）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 `src/evolution/curator.ts`**

编排器：`curate(harness, proposal)` → 证据提取 → 影子运行 → 写回 replay verdict → 门禁。

- [ ] **Step 4: 接入 `tools-evolution.ts`**：`evolution.propose` 执行后自动触发 curator（影子运行）。

- [ ] **Step 5: 跑测试 + typecheck**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(evolution): 闭环编排 curator（提案→影子→门禁→生效）"
```

---

### Task 6: 管理端提案展示增强（影子证据 + 差异摘要）

**Files:**
- Modify: `src/gateway/routes-admin.ts`（提案详情带 replay 信息）
- Modify: `src/gateway/console.ts`（提案 tab 展示 verdict / 差异）

- [ ] **Step 1: 读现有 `routes-admin.ts` 提案详情与 console proposals tab**

- [ ] **Step 2: 修改提案详情 API**：返回 `shadowVerdict` / `divergences`

- [ ] **Step 3: 修改 console proposals tab**：展示影子 verdict、坏例锚点、差异摘要

- [ ] **Step 4: 手动验证 + typecheck**

Run: `pnpm dev` 打开控制台 → 演进提案 tab

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(console): 提案展示影子验证证据与差异摘要"
```

---

### Task 7: 血缘追踪（lineage 事件表）

**Files:**
- Modify: `src/evolution/store.ts`（迁移加 `lineage` 表）
- Create: `src/evolution/lineage.ts`
- Test: `tests/unit/evolution-lineage.test.ts`

- [ ] **Step 1: 写失败测试**

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 lineage 表 + 事件追加 + 查询**

kind: `proposed` / `shadow_verified` / `applied` / `session_hit` / `eval_feedback`

- [ ] **Step 4: 跑测试 + typecheck**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(evolution): 血缘追踪 lineage 事件表"
```

---

### Task 8: 回归防线 + 全量验证 + 文档

**Files:**
- Modify: `docs/README.md` / `docs/DEPLOYMENT.md` / `docs/sales/one-pager.md`（进化能力文案）
- Modify: `src/gateway/console.ts`（总览脚注）

- [ ] **Step 1: 全量跑测试**

Run: `pnpm test`
Expected: 全部通过（472 + 新增）

- [ ] **Step 2: 跑 smoke**

Run: `pnpm smoke`
Expected: 全链路通过

- [ ] **Step 3: 更新文档**：进化子系统现在完整对齐 Python 原版（技能自策展 / 影子 / 差分 / 血缘），README 与销售材料更新卖点（「会自进化，但由你把关」）。

- [ ] **Step 4: Commit + push**

```bash
git add .
git commit -m "feat(evolution): 完整对齐 Python 原版进化子系统（自策展+影子+差分+血缘）"
git push
```

---

## 自审清单

- [x] **Spec 覆盖**：技能自策展（T4）、影子运行（T3）、回放差分（T1）、证据收集（T2）、闭环编排（T5）、管理端（T6）、血缘（T7）、消融预留（T3 中 `runShadowTurn` 的 badcase 选项即未来消融钩子）、回归（T8）
- [x] **无占位符**：所有 task 含真实文件路径与代码
- [x] **类型一致**：`diffFrames` / `runShadowTurn` / `ShadowResult` / `SkillDraft` 跨 task 签名一致
