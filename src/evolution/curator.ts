/**
 * 闭环编排：低分会话证据 → 影子运行验证 → 差分判定。
 *
 * 这是「自进化」闭环的中枢：把证据画像（evidence.ts）、影子运行（shadow.ts）、
 * 差分器（differ.ts）串起来，产出给人工审批看的影子验证证据——
 * 审核者除了看「提案说要改什么」，还能看到「同输入重跑是否真的修了坏例」。
 *
 * 依赖形状（为什么是 `runShadowTurn` 而不是整个 `Harness`）：
 * `shadow.ts` 的 `runShadowTurn(harness, input, options)` 需要 harness 才能建影子 agent，
 * 但 harness 在组合根（runtime.ts）里是**先**用 evolution 依赖装配、**后**才创建出来的。
 * 若 CuratorDeps 直接持有 harness 会形成装配期循环依赖。因此这里持有的是**已绑定 harness
 * 的影子运行函数**（组合根在 harness 创建后用闭包注入），curate 只关心「给输入 → 拿到重跑帧」。
 */

import type { EvalStore } from '../evaluation/store.js'
import { extractEvidence, type EvidenceHit } from './evidence.js'
import { diffFrames, type DiffVerdict, type Divergence, type FrameLike } from './differ.js'
import type { Proposal } from './store.js'
import type { ShadowResult, ShadowTurnInput } from './shadow.js'

export interface CuratorDeps {
  /**
   * 绑定到生产 harness 的影子运行函数（shadow.ts 的 `runShadowTurn` 部分应用）。
   * curate 只传输入；harness 由组合根在创建后经闭包注入。
   */
  readonly runShadowTurn: (
    input: ShadowTurnInput,
    options?: { readonly badcaseText?: string },
  ) => Promise<ShadowResult>
  /** 评测库：取来源会话的低分评测原文（input/output 就是坏例）。 */
  readonly evals: EvalStore
}

export interface CurateResult {
  /** 差分判定：坏例是否被影子重跑修复。 */
  readonly shadowVerdict: DiffVerdict
  /** baseline（坏例原文）vs replay（影子输出）的差异记录。 */
  readonly divergences: readonly Divergence[]
  /** 从坏例里抽出的证据画像（也是 diff 的 badcase 锚点来源）。 */
  readonly evidenceHits: readonly EvidenceHit[]
  /** 影子重跑的 replay 帧，供审批界面展示「重跑后长什么样」。 */
  readonly replayFrames: readonly FrameLike[]
}

/**
 * 对一条提案做闭环影子验证。
 *
 * 流程：取来源会话的低分评测原文 → `extractEvidence` 抽出证据与坏例锚点 →
 * 用**原输入 + 提案租户**重跑影子 agent → `diffFrames` 对比坏例原文与重跑输出。
 *
 * @param proposal - 待验证的提案（要求有 `sourceConversationId` 指向一条低分评测）。
 * @param deps - 影子运行函数 + 评测库。
 * @returns 影子验证结果。无来源会话 / 非低分 / 缺原文时返回 `inconclusive`。
 */
export async function curate(proposal: Proposal, deps: CuratorDeps): Promise<CurateResult> {
  const { runShadowTurn, evals } = deps

  // 1. 来源会话的低分评测 = 坏例原文（演进提案的输入源，见 EvalStore.failing）
  const results = proposal.sourceConversationId === undefined ? [] : evals.byConversation(proposal.sourceConversationId)
  const bad = results.find((r) => !r.passed)
  if (bad === undefined || bad.inputText === undefined || bad.outputText === undefined) {
    return { shadowVerdict: 'inconclusive', divergences: [], evidenceHits: [], replayFrames: [] }
  }

  // 2. 证据画像 + 差分坏例锚点（取第一条命中的 badcaseText；可能为空数组）
  const evidenceHits = extractEvidence(bad.inputText, bad.outputText)
  const badcaseText = evidenceHits[0]?.badcaseText

  // 3. 影子运行：同输入重跑（用原会话真实租户，见 shadow.ts Important #1 ——
  //    缺了它 knowledge.search 对真实知识库永远 0 命中，会产生假的 badcase_fixed）
  const shadow = await runShadowTurn({ text: bad.inputText, tenantId: proposal.tenantId })

  // 4. 差分：baseline（坏例原文，单帧即可——differ 内部按文本比较）vs replay（影子输出）
  const baselineFrames: FrameLike[] = [{ type: 'text/delta', text: bad.outputText }]
  const diff = diffFrames(baselineFrames, shadow.replayFrames, { badcaseText })

  return {
    shadowVerdict: diff.verdict,
    divergences: diff.divergences,
    evidenceHits,
    replayFrames: shadow.replayFrames,
  }
}
