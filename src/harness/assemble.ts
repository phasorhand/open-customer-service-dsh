/**
 * dsh 运行时组装 —— 本项目的 agent 内核。
 *
 * 方式选择（research §2.1）：`new Context()` + `ctx.plugin()` 手写组装，
 * 不用 `boot()` + cordis.yml。理由：单服务进程不需要 YAML 组合层与 profile 目录。
 *
 * 插件挂载顺序有语义：
 *   基础服务 → LLM provider → 持久化 → 业务工具 → guard 链
 * guard 链内 **scope 在前、risk 在后**：越权是权限事实，不管风险档多低都先拒。
 */

import { mkdirSync } from 'node:fs'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import type { RuntimeConfig } from '../config.js'
import type { ContactService } from '../crm/service.js'
import type { EvolutionToolDeps } from './plugins/tools-evolution.js'
import { DshSkillRepo } from '../skills/repo.js'
import { MOCK_MODEL, MOCK_PROVIDER, apply as applyMockLlm, inject as mockInject } from './mock-llm.js'
import * as GuardRisk from './plugins/guard-risk.js'
import type { AskRequest, RiskDecisionEntry } from './plugins/guard-risk.js'
import * as GuardScope from './plugins/guard-scope.js'
import * as PromptSections from './plugins/prompt-sections.js'
import * as ToolsCrm from './plugins/tools-crm.js'
import * as ToolsEvolution from './plugins/tools-evolution.js'
import * as ToolsCs from './plugins/tools-cs.js'
import type { HarnessPorts } from './ports.js'
import { bindScope, type TenantScope } from './session-scope.js'

/** 客服 agent 的基础人设。营期/租户级 persona 由 P3 的 prompt-sections 叠加。 */
export const BASE_PERSONA = [
  '你是 OpenCS 客服助手，代表企业与客户沟通。',
  '规则：',
  '1. 政策、价格、时效类问题必须先调用 knowledge.search 查证，查不到就如实说不确定并转人工，绝不编造。',
  '2. 订单状态必须调用 crm.get_order 查询，不要凭上下文猜测。',
  '3. 不做超出知识库范围的承诺（赔付、加急、破例）。',
  '4. 回复简洁、用中文、不使用客套堆砌。',
].join('\n')

export interface HarnessOptions {
  readonly config: RuntimeConfig
  readonly ports: HarnessPorts
  /** 联系人服务。省略则不挂 CRM 工具（P1/P3 的纯客服形态）。 */
  readonly contacts?: ContactService
  /** 演进依赖。省略则不挂 evolution.propose。 */
  readonly evolution?: EvolutionToolDeps
  /** 风险裁决审计回调；接到 audit 表。 */
  readonly onRiskDecision?: (entry: RiskDecisionEntry) => void
  /** ask 分支的审批落队回调。 */
  readonly onAsk?: (request: AskRequest) => string | undefined
}

export interface Harness {
  readonly ctx: Context
  /** 实际生效的 provider/model（无 key 时是 mock）。 */
  readonly provider: string
  readonly model: string
  /** 技能库。管理端与 Round 2 注入使用。 */
  readonly skills: DshSkillRepo
  /**
   * 取得某会话的常驻 agent；不存在则创建并绑定作用域。
   *
   * @param scope - 服务端注入的权限事实。
   * @returns 该会话的 agent。
   */
  agentFor(scope: TenantScope): Promise<Agent>
  /**
   * 投递一条用户消息并等到 agent 空闲。
   *
   * @param agent - 目标 agent。
   * @param text - 用户消息文本。
   */
  runTurn(agent: Agent, text: string): Promise<void>
  /** 关停：释放 agent 与作用域绑定。 */
  dispose(): Promise<void>
}

/**
 * 组装 dsh 运行时。
 *
 * @param options - 配置与业务端口。
 * @returns 就绪的 harness。
 */
export async function assembleHarness(options: HarnessOptions): Promise<Harness> {
  const { config, ports } = options
  const ctx = new Context()

  // cordis 没有 `ctx.stop()`：整棵树的关停靠逆序 dispose 每个 fiber。
  const fibers: { dispose: () => Promise<void> }[] = []
  const mount = async (plugin: Parameters<Context['plugin']>[0], pluginConfig?: unknown): Promise<void> => {
    const fiber = await ctx.plugin(plugin, pluginConfig)
    fibers.push(fiber)
  }

  // 基础服务：顺序不敏感（cordis 按 inject 自动等待），但按依赖方向书写便于阅读
  await mount(LlmRuntime)
  await mount(SessionStore)
  await mount(SystemPrompt, {})
  await mount(ToolRuntime, {})
  await mount(AgentRegistry)
  await mount(AgentLoop, { agents: [] })

  // LLM provider：mock adapter 永远挂载作为兜底，真实 provider 按配置叠加
  await mount({ name: 'opencs-mock-llm', inject: mockInject, apply: applyMockLlm })
  let provider = MOCK_PROVIDER
  let model = MOCK_MODEL
  if (config.llm.kind === 'deepseek') {
    await mount(LlmDeepSeek, {})
    provider = 'deepseek-official'
    model = config.llm.model
  } else if (config.llm.kind === 'openai-compatible') {
    // 客户自建/代理网关：手声明一条 OpenAI 兼容路由（dsh-llm-pi-ai 的 hand-declared route）。
    // apiKeyEnv 是**凭证引用**而不是值——密钥留在环境变量里，不进配置对象。
    await mount(LlmPiAi, {
      providers: {
        'opencs-gateway': {
          displayName: 'OpenCS Gateway',
          apiKeyEnv: 'OPENAI_API_KEY',
          api: 'openai-completions',
          ...(config.llm.baseUrl === undefined ? {} : { baseURL: config.llm.baseUrl }),
          models: [{ id: config.llm.model, contextWindow: 131_072 }],
        },
      },
    })
    provider = 'opencs-gateway'
    model = config.llm.model
  }

  // session 事件溯源 = 运行期审计与回放的数据源
  mkdirSync(config.paths.sessionsDir, { recursive: true })
  await mount(JsonlSessionPersistence, { root: config.paths.sessionsDir })

  // 技能库：复用 dsh 的 skill 注册表 + 文件系统 provider。
  // includeDefaultRoots: false 是**必须的**——默认会扫描 $DSH_HOME/skills 与 ~/.agents，
  // 那是开发者机器上的个人技能，绝不能混进服务端的客服话术库。
  await mount(SkillRegistry, {})
  await mount({ name: SkillFilesystem.name, inject: SkillFilesystem.inject, apply: SkillFilesystem.apply }, {
    providerName: 'opencs',
    includeDefaultRoots: false,
    customSkillDirs: [config.paths.skillsDir],
  })
  const skills = new DshSkillRepo(ctx)
  await skills.refresh()

  // persona 与技能索引经 systemPrompt.section 注入（model-visible ⟺ logged）
  await mount({ name: PromptSections.name, inject: PromptSections.inject, apply: PromptSections.apply }, {
    persona: BASE_PERSONA,
    skills,
  } satisfies PromptSections.PromptSectionsConfig)

  // 业务工具
  await mount({ name: ToolsCs.name, inject: ToolsCs.inject, apply: ToolsCs.apply }, ports)
  if (options.contacts !== undefined) {
    await mount({ name: ToolsCrm.name, inject: ToolsCrm.inject, apply: ToolsCrm.apply }, options.contacts)
  }
  if (options.evolution !== undefined) {
    await mount({ name: ToolsEvolution.name, inject: ToolsEvolution.inject, apply: ToolsEvolution.apply }, options.evolution)
  }

  // guard 链：scope 在前（权限事实），risk 在后（风险偏好）
  await mount({ name: GuardScope.name, inject: GuardScope.inject, apply: GuardScope.apply })
  await mount({ name: GuardRisk.name, inject: GuardRisk.inject, apply: GuardRisk.apply }, {
    autoApproveTiers: config.autoApproveTiers,
    ...(options.onRiskDecision === undefined ? {} : { onDecision: options.onRiskDecision }),
    ...(options.onAsk === undefined ? {} : { onAsk: options.onAsk }),
  } satisfies GuardRisk.RiskGuardConfig)

  const agents = new Map<string, Agent>()
  const unbinders: (() => void)[] = []

  return {
    ctx,
    provider,
    model,
    skills,

    async agentFor(scope: TenantScope): Promise<Agent> {
      const sessionId = SessionId(`conv-${scope.tenantId}-${scope.conversationId}`)
      // **每次**都重新绑定，不只是首次创建时：contactId 是在首轮入站时才解析出来的，
      // 只在创建时绑定会让整个会话的 CRM 工具都看不到客户档案。
      unbinders.push(bindScope(String(sessionId), scope))

      const existing = agents.get(scope.conversationId)
      if (existing !== undefined) return existing

      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions: { provider, model },
      })
      agents.set(scope.conversationId, handle.agent)
      return handle.agent
    },

    async runTurn(agent: Agent, text: string): Promise<void> {
      agent.send(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), 'next-turn', true)
      await agent.whenIdle()
    },

    async dispose(): Promise<void> {
      for (const unbind of unbinders.reverse()) unbind()
      unbinders.length = 0
      agents.clear()
      skills.dispose()
      // 逆序卸载：先业务插件后基础服务，让 guard/工具先于 ToolRuntime 消失
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      fibers.length = 0
    },
  }
}

export { BASE_PERSONA as PERSONA }
