/**
 * 用 dsh 的 `ctx.llm` 实现 composer 的 LLM 端口。
 *
 * 为什么不复用 agent loop：组稿是**单轮无工具**的补全，
 * 走完整 agent loop 会拉进 persona、技能索引、工具 schema 等无关 context，
 * 既贵又会让模型误以为自己在跟客户对话（可能直接调 channel.reply）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import type { ComposerLlm } from './composer.js'

export interface DshComposerLlmOptions {
  readonly ctx: Context
  readonly provider: string
  readonly model: string
}

export class DshComposerLlm implements ComposerLlm {
  constructor(private readonly options: DshComposerLlmOptions) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const chunks: string[] = []
    const stream = this.options.ctx.llm.stream({
      provider: this.options.provider,
      model: this.options.model,
      system: systemPrompt,
      messages: [createUserMessage({ content: [{ type: 'text', text: userPrompt }], source: { kind: 'user' } })],
    } as never)

    for await (const chunk of stream as AsyncIterable<{ type: string; text?: string }>) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text)
    }
    return chunks.join('')
  }
}

/**
 * 离线兜底 composer：无 API key 时用确定性文案，让节奏引擎在冒烟/CI 里也能跑通。
 *
 * 与真实实现共用 `ComposerLlm` 接口（教训 #5）。
 */
export class OfflineComposerLlm implements ComposerLlm {
  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const goal = /本次触达的目标：(.+)/.exec(userPrompt)?.[1]?.trim() ?? '跟进'
    const name = /- 称呼：(.+)/.exec(userPrompt)?.[1]?.trim()
    const greeting = name === undefined || name.startsWith('（') ? '你好' : `${name}你好`
    // 身份约束由 system prompt 表达；离线文案刻意**不自称任何公司**，
    // 与「senderPersona 为空时不得虚构身份」的规则保持一致
    const persona = /【身份约束】你的身份是且仅是：(.+)/.exec(systemPrompt)?.[1]?.trim()
    const intro = persona === undefined ? '' : `我是${persona}，`
    return `${greeting}，${intro}想跟你确认一下${goal}。方便的话回复我一下，我来帮你安排。`
  }
}
