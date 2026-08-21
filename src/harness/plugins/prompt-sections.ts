/**
 * System prompt 注入：persona + 技能索引。
 *
 * 用 `ctx.systemPrompt.section()` 而不是手拼字符串（dsh-best-practices §E）：
 * section 带 order 与 scope，且**被记入 session 事件**——满足
 * 「Model-visible ⟺ logged」铁律，否则回放时无法重建当时的模型输入。
 */

import type { Context } from '@deepseek-ai/cordis'

import { round1Instruction } from '../../skills/selection.js'
import type { SkillPort } from '../../skills/types.js'

export const name = 'opencs-prompt-sections'
export const inject = ['systemPrompt']

/**
 * section 顺序，遵循 dsh 的约定（`-100` harness 身份、`0` 部署 persona、
 * `100–199` 工具指引）：persona 用 0 定调，技能索引作为工具指引放 150。
 */
const ORDER_PERSONA = 0
const ORDER_SKILL_INDEX = 150

export interface PromptSectionsConfig {
  readonly persona: string
  /** 提供同步索引快照的技能库。异步加载在 `refresh()` 里完成，此处只读快照。 */
  readonly skills: Pick<SkillPort, 'buildIndex'> & { indexSync(): string }
}

export function apply(ctx: Context, config: PromptSectionsConfig): void {
  ctx.systemPrompt.section({
    name: 'opencs-persona',
    order: ORDER_PERSONA,
    text: config.persona,
  })

  ctx.systemPrompt.section({
    name: 'opencs-skill-index',
    order: ORDER_SKILL_INDEX,
    // 每次组装重新读快照：运营改了 SKILL.md 触发 skills/change → 快照刷新 → 下一轮生效
    text: () => {
      const index = config.skills.indexSync()
      return index === '' ? '' : round1Instruction(index)
    },
  })
}
