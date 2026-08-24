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
  const scope = { tenantId: 'shadow', conversationId: `shadow-${Date.now()}`, channelId: 'webchat', customerId: 'shadow-customer' }
  const agent = await harness.shadowAgent(scope)
  agent.send(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }), 'next-turn', true)
  await agent.whenIdle()

  const replayFrames = framesFromAgent(agent)
  const baseline = options.baselineFrames ?? []
  const result = diffFrames(baseline, replayFrames, {
    ...(options.badcaseText === undefined ? {} : { badcaseText: options.badcaseText }),
  })
  return { verdict: result.verdict, divergences: result.divergences, replayFrames }
}
