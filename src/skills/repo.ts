/**
 * 技能库：`ctx.skills`（dsh）的薄封装。
 *
 * 复用（RESEARCH.md 决策）：`@deepseek-ai/dsh-skill` + `dsh-skill-filesystem`
 * 负责 SKILL.md 扫描、frontmatter 解析、文件监听与失效。
 * 本文件只加 OpenCS 的路由语义（priority / routing / intent_signals）与紧凑索引。
 *
 * 隔离纪律：dsh 的 skill 类型**不外泄**到业务代码——工具层只认 `SkillPort`。
 */

import type { Context } from '@deepseek-ai/cordis'

import { parseRoutingMeta, type LoadedSkill, type SkillPort } from './types.js'

/** 索引里每条技能的意图线索最多展示几条，避免索引本身撑爆 context。 */
const MAX_SIGNALS_IN_INDEX = 5

export class DshSkillRepo implements SkillPort {
  /** name → 已加载技能。`skills/change` 时整体失效。 */
  private cache: Map<string, LoadedSkill> | undefined
  /**
   * 索引的同步快照。
   *
   * 存在的理由：dsh 的 `PromptSection.text` 必须是**同步**的
   * （`string | (ctx) => string`），而技能加载是异步的。因此在
   * 启动与每次 `skills/change` 之后预热这个快照，prompt 组装时直接读。
   */
  private indexSnapshot = ''
  private readonly disposeListener: () => void

  constructor(private readonly ctx: Context) {
    // dsh 在 provider 注册/失效时发 `skills/change`，只是「该重新拉了」的通知，不带 diff
    this.disposeListener = ctx.on('skills/change', () => {
      this.cache = undefined
      void this.refresh()
    })
  }

  /** 停止监听失效通知。 */
  dispose(): void {
    this.disposeListener()
  }

  /**
   * 重新加载技能并刷新同步索引快照。
   *
   * 启动时必须调用一次，否则第一轮对话拿不到索引。
   */
  async refresh(): Promise<void> {
    this.indexSnapshot = await this.buildIndex().catch(() => '')
  }

  /**
   * 同步读取索引快照，供 `ctx.systemPrompt.section()` 使用。
   *
   * @returns 上一次 {@link refresh} 得到的索引；尚未预热时为空串。
   */
  indexSync(): string {
    return this.indexSnapshot
  }

  async buildIndex(): Promise<string> {
    const skills = await this.list()
    if (skills.length === 0) return ''

    const lines = skills.map((skill) => {
      const signals = skill.intentSignals.slice(0, MAX_SIGNALS_IN_INDEX)
      const hint = signals.length === 0 ? '' : `（适用：${signals.join('、')}）`
      return `- ${skill.name}：${skill.description}${hint}`
    })
    return lines.join('\n')
  }

  async load(names: readonly string[]): Promise<readonly LoadedSkill[]> {
    const all = await this.loadAll()
    const seen = new Set<string>()
    const out: LoadedSkill[] = []
    for (const name of names) {
      const normalized = name.trim()
      if (normalized === '' || seen.has(normalized)) continue
      seen.add(normalized)
      const skill = all.get(normalized)
      // 模型可能幻觉出不存在的技能名——静默跳过，不让整轮对话失败
      if (skill !== undefined) out.push(skill)
    }
    return out
  }

  async list(): Promise<readonly LoadedSkill[]> {
    const all = await this.loadAll()
    // 高 priority 在前；同 priority 按名字稳定排序，保证索引可比对
    return [...all.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  }

  private async loadAll(): Promise<ReadonlyMap<string, LoadedSkill>> {
    if (this.cache !== undefined) return this.cache

    const cache = new Map<string, LoadedSkill>()
    const summaries = await this.ctx.skills.list({})
    for (const summary of summaries) {
      // `list()` 只给摘要，路由语义在 frontmatter 里，需要 `get()` 才拿得到
      const definition = await this.ctx.skills.get(summary.name, {}).catch(() => undefined)
      if (definition === undefined) continue
      const meta = parseRoutingMeta(definition.metadata, definition.whenToUse)
      cache.set(definition.name, {
        name: definition.name,
        description: definition.description,
        content: definition.content,
        priority: meta.priority,
        routing: meta.routing,
        intentSignals: meta.intentSignals,
      })
    }
    this.cache = cache
    return cache
  }
}
