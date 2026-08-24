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

/**
 * 返回标记数组中第一个在 output 里实际命中的正则：
 * source 是正则模式原文，matched 是 output 中被匹配到的真实子串。
 * 复合正则（如 `保证.{0,4}(?:退|赔|到账|修复)`）的 source 不是回复的子串，
 * 只有 matched 才能作为差分器的 badcase 锚点。
 */
function firstMatch(
  markers: readonly RegExp[],
  output: string,
): { source: string; matched: string } | undefined {
  for (const re of markers) {
    const m = re.exec(output)
    if (m !== null) return { source: re.source, matched: m[0] }
  }
  return undefined
}

export function extractEvidence(input: string, output: string): EvidenceHit[] {
  const hits: EvidenceHit[] = []
  const commit = firstMatch(COMMITMENT_MARKERS, output)
  if (commit !== undefined) {
    hits.push({
      kind: 'commitment_violation',
      badcaseText: commit.matched,
      detail: `回复包含越权承诺措辞：${commit.matched}`,
    })
  }
  const gap = firstMatch(GAP_MARKERS, output)
  if (gap !== undefined) {
    hits.push({
      kind: 'factual_gap',
      badcaseText: gap.matched,
      detail: `对「${input.slice(0, 30)}」未能给出知识库依据的回答`,
    })
  }
  const fluff = firstMatch(FLUFF_MARKERS, output)
  if (fluff !== undefined) {
    hits.push({ kind: 'tone_issue', badcaseText: fluff.matched, detail: `回复含空泛安抚语：${fluff.matched}` })
  }
  return hits
}
