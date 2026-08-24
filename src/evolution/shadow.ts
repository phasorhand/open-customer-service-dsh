/**
 * 影子运行器：对一条提案，用「同输入重跑一个全新 dsh agent」验证效果。
 *
 * 关键：复用 assembleHarness 的生产 agent loop（skill 加载 / guard / 工具全生效），
 * 只是会话不持久化、不落库。这是「依赖 dsh 获得进化能力」的核心。
 *
 * 重要（Important #1）：影子重跑必须用**原会话的真实租户**（input.tenantId），
 * 不能虚构 'shadow'——否则 knowledge.search 对 SAMPLE_KNOWLEDGE 永远 0 命中，
 * 政策类坏例既无法被真正演练，还会产生「空知识库回放恰好不含坏例文本」的假 badcase_fixed。
 */

import { randomUUID } from 'node:crypto'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import type { Harness } from '../harness/assemble.js'
import { resetMockCallIds } from '../harness/mock-llm.js'
import { toTextBlocks } from './assistant-text.js'
import { diffFrames, type DiffResult, type FrameLike } from './differ.js'

export interface ShadowTurnInput {
  readonly text: string
  /** 原会话的真实租户——决定 knowledge/crm 数据域，缺了它重跑等于查空库。 */
  readonly tenantId: string
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
  return toTextBlocks(agent.session.events)
    .filter((b) => b.text.trim() !== '')
    .map((b) => ({ type: 'text/delta', text: b.text }))
}

export async function runShadowTurn(
  harness: Harness,
  input: ShadowTurnInput,
  options: { readonly badcaseText?: string; readonly baselineFrames?: readonly FrameLike[] } = {},
): Promise<ShadowResult> {
  // 全局副作用（documented）：mock 的 callId 是单调递增的，影子重跑要与生产会话
  // 及其他影子运行可对比，必须先重置——这保证同一个 harness 里两次影子运行
  // 产出完全一致的帧序列。
  resetMockCallIds()

  // conversationId 用随机 UUID 保证每次唯一：既不与生产 agent 缓存（按 conversationId 建
  // 索引）撞键，也不会有 Date.now() 毫秒级竞态撞到同毫秒两次运行。
  const scope = {
    tenantId: input.tenantId,
    conversationId: `shadow-${randomUUID()}`,
    channelId: 'webchat',
    customerId: 'shadow-customer',
  }
  const handle = await harness.shadowAgent(scope)
  try {
    handle.agent.send(
      createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }),
      'next-turn',
      true,
    )
    await handle.agent.whenIdle()

    const replayFrames = framesFromAgent(handle.agent)
    const baseline = options.baselineFrames ?? []
    // badcaseText 未提供时 diffFrames 内部以 undefined 空守卫，无需条件展开
    const result = diffFrames(baseline, replayFrames, { badcaseText: options.badcaseText })
    return { verdict: result.verdict, divergences: result.divergences, replayFrames }
  } finally {
    // 影子会话是一次性回放：用后即弃，dispose 停循环、注销 agent、移除其 session，
    // 否则 shadow-* 会话会在 session store 里越积越多。
    await handle.dispose()
  }
}
