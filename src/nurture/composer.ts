/**
 * 外呼文案组稿。
 *
 * 两种模式（research §4 教训 #6）：
 * - `template` 非空 → 占位符替换，**毫秒级**。大批量首触必须用这个
 * - 否则 `goal` 走 LLM，约 40 秒/条。留给高价值跟进步骤
 *
 * ## 身份边界（教训 #1，最重要的一条）
 *
 * Python 版生产事故：LLM 把联系人的 `company` 字段读成自己的雇主，
 * 给「晨光电商」的客户发消息时自称「我是晨光电商的小王」。
 *
 * 修复有两层，缺一不可：
 * 1. system prompt 里显式声明「客户所在公司是客户的公司，不是你的公司」
 * 2. 用户 prompt 里给字段打标签时也写明归属（「客户所在公司（不是你的公司）」）
 */

import type { Contact } from '../crm/types.js'
import type { CadenceStep } from './types.js'

/** 组稿所需的最小 LLM 能力。用接口而非直接依赖 dsh，便于测试替身与真实实现共用。 */
export interface ComposerLlm {
  /**
   * 单轮补全。
   *
   * @param systemPrompt - 系统提示。
   * @param userPrompt - 用户提示。
   * @returns 模型输出的纯文本。
   */
  complete(systemPrompt: string, userPrompt: string): Promise<string>
}

export interface ComposeInput {
  readonly step: CadenceStep
  readonly contact: Contact
  /** 发件人身份。为空时明确禁止模型虚构身份。 */
  readonly senderPersona?: string
  readonly cadenceName: string
}

export interface ComposeResult {
  readonly text: string
  /** `template` 走模板、`llm` 走模型。用于运维统计与成本归因。 */
  readonly mode: 'template' | 'llm'
}

/** 模板占位符最大长度，防止超长字段撑爆消息。 */
const MAX_PLACEHOLDER_LENGTH = 60

export class OutreachComposer {
  constructor(private readonly llm: ComposerLlm) {}

  /**
   * 为一步节奏组稿。
   *
   * @param input - 步骤、联系人、发件人身份。
   * @returns 文案与所用模式。
   * @throws {Error} 步骤既没有 template 也没有 goal。
   */
  async compose(input: ComposeInput): Promise<ComposeResult> {
    const template = input.step.template?.trim()
    if (template !== undefined && template !== '') {
      return { text: renderTemplate(template, input.contact), mode: 'template' }
    }

    const goal = input.step.goal?.trim()
    if (goal === undefined || goal === '') {
      throw new Error(`节奏步骤 ${input.step.stepOrder} 既没有 template 也没有 goal，无法组稿`)
    }

    const raw = await this.llm.complete(
      buildSystemPrompt(input.senderPersona),
      buildUserPrompt(goal, input.contact, input.cadenceName),
    )
    return { text: sanitize(raw), mode: 'llm' }
  }
}

/**
 * 构造 system prompt。
 *
 * @param senderPersona - 发件人身份；为空时禁止虚构。
 * @returns system prompt。
 */
export function buildSystemPrompt(senderPersona: string | undefined): string {
  const persona = senderPersona?.trim()

  const identity =
    persona === undefined || persona === ''
      ? [
          '【身份约束】你没有被赋予具体的公司或姓名身份。',
          '因此**绝对不要**自称属于任何公司，也不要虚构姓名、职位或工号。',
          '用中性的第一人称写作，不做自我介绍。',
        ]
      : [
          `【身份约束】你的身份是且仅是：${persona}`,
          '只能用这个身份自我介绍，不得使用任何其他公司名或姓名。',
        ]

  return [
    '你在为一次主动外呼撰写一条消息。',
    '',
    ...identity,
    '',
    // 这三行是 Python 版生产事故的直接修复，不要删改
    '【关键边界】客户资料里出现的公司名是**客户所在的公司**，不是你的公司。',
    '绝对不要把客户的公司当成自己的雇主，也不要自称是该公司的员工。',
    '',
    '【写作要求】',
    '1. 一条消息，不超过 120 字，可直接发送，不要写标题、署名或解释。',
    '2. 结合客户资料做个性化，但不要罗列你知道的全部信息（会显得像在监视）。',
    '3. 不做价格承诺、效果保证、退款承诺。',
    '4. 不使用「亲」「宝子」等过度亲昵的称呼。',
    '5. 只输出消息正文本身。',
  ].join('\n')
}

/**
 * 构造 user prompt。
 *
 * 字段标签刻意写明归属——「客户所在公司（不是你的公司）」——
 * 这是身份边界的第二层保险。
 */
export function buildUserPrompt(goal: string, contact: Contact, cadenceName: string): string {
  const lines = [
    `本次触达的目标：${goal}`,
    `所属节奏：${cadenceName}`,
    '',
    '客户资料：',
    `- 称呼：${contact.name ?? '（未知，不要编造姓名）'}`,
    `- 客户所在公司（不是你的公司）：${contact.company ?? '（未知）'}`,
    `- 当前漏斗阶段：${contact.lifecycleStage}`,
    `- 意向分：${contact.score}`,
  ]
  if (contact.tags.length > 0) lines.push(`- 标签：${contact.tags.join('、')}`)
  if (contact.lastInboundAt !== undefined) {
    lines.push(`- 上次主动联系我们：${contact.lastInboundAt.toISOString().slice(0, 10)}`)
  }
  lines.push('', '请直接输出要发送的消息正文。')
  return lines.join('\n')
}

/**
 * 渲染模板占位符。
 *
 * 支持 `{{name}}` `{{company}}` `{{stage}}`。未知占位符与缺失字段
 * 都替换为**空串**而不是留下 `{{name}}` ——把原始占位符发给客户是明显的事故。
 *
 * @param template - 模板文本。
 * @param contact - 联系人。
 * @returns 渲染后的文本。
 */
export function renderTemplate(template: string, contact: Contact): string {
  const values: Readonly<Record<string, string | undefined>> = {
    name: contact.name,
    company: contact.company,
    stage: contact.lifecycleStage,
    email: contact.email,
    phone: contact.phone,
  }
  return template
    .replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_match, key: string) => {
      const value = values[key] ?? ''
      return value.length > MAX_PLACEHOLDER_LENGTH ? value.slice(0, MAX_PLACEHOLDER_LENGTH) : value
    })
    // 占位符落空后常留下「你好，！」这样的孤立标点，收拾一下
    .replace(/\s*[,，]\s*([。！？!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 清理模型输出。
 *
 * 模型常自作主张加引号、Markdown 代码块、「以下是消息：」之类的前言。
 */
function sanitize(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '')
  text = text.replace(/^(以下是|这是)[^：:]{0,20}[：:]\s*/, '')
  text = text.replace(/^["'「『]|["'」』]$/g, '')
  return text.trim()
}
