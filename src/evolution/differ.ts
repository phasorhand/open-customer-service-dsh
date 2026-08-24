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
