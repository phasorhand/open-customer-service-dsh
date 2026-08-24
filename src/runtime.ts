/**
 * 组合根：把配置、渠道、端口、dsh harness 装配成一个可运行的对象图。
 *
 * 纪律：这是**唯一**一处知道全部具体实现的地方。其他模块只依赖接口，
 * 便于测试替换与后续分层演进。
 */

import { join } from 'node:path'

import { ApprovalQueue, APPROVAL_MIGRATIONS } from './approval/queue.js'
import { AuditStore, AUDIT_MIGRATIONS } from './audit/store.js'
import { ChannelRegistry } from './channel/adapter.js'
import type { OutboundAction } from './channel/types.js'
import { textContent } from './channel/types.js'
import { WebChatAdapter, WEBCHAT_CHANNEL_ID } from './channel/webchat.js'
import { WecomAdapter } from './channel/wecom.js'
import type { RuntimeConfig } from './config.js'
import { ContactImporter } from './crm/importer.js'
import { ContactService } from './crm/service.js'
import { CRM_MIGRATIONS, ContactStore } from './crm/store.js'
import { openDb, type Db } from './db/sqlite.js'
import { EVAL_MIGRATIONS, EvalStore } from './evaluation/store.js'
import { EvolutionGate } from './evolution/gate.js'
import { runShadowTurn } from './evolution/shadow.js'
import { EVOLUTION_MIGRATIONS, ProposalStore } from './evolution/store.js'
import { assembleHarness, type Harness } from './harness/assemble.js'
import type { RiskDecisionEntry } from './harness/plugins/guard-risk.js'
import { memoryPorts } from './harness/ports-memory.js'
import type { DeliveryResult, HarnessPorts, OutboundPort } from './harness/ports.js'
import { KnowledgeIngestor } from './knowledge/ingestor.js'
import { OutreachComposer } from './nurture/composer.js'
import { DshComposerLlm, OfflineComposerLlm } from './nurture/dsh-llm.js'
import { NurtureEngine } from './nurture/engine.js'
import { NURTURE_MIGRATIONS, CadenceStore } from './nurture/store.js'
import { OUTREACH_MIGRATIONS, SendOutbox } from './outreach/outbox.js'
import { KNOWLEDGE_MIGRATIONS, SqliteKnowledgeStore } from './knowledge/store.js'

export interface OpenCsRuntime {
  readonly config: RuntimeConfig
  readonly channels: ChannelRegistry
  readonly webchat: WebChatAdapter
  /** 企微客服适配器；未配置企微时为 undefined。 */
  readonly wecom?: WecomAdapter
  readonly harness: Harness
  readonly knowledge: SqliteKnowledgeStore
  readonly contacts: ContactService
  readonly contactStore: ContactStore
  readonly importer: ContactImporter
  readonly cadences: CadenceStore
  readonly outbox: SendOutbox
  readonly nurture: NurtureEngine
  readonly evals: EvalStore
  readonly proposals: ProposalStore
  readonly gate: EvolutionGate
  readonly audit: AuditStore
  readonly approvals: ApprovalQueue
  /** 出站端口（审批通过后的确定性投递也走它）。 */
  readonly outbound: OutboundPort
  /** 最近的风险裁决（内存快视图；持久化在 audit 表）。 */
  readonly riskDecisions: readonly RiskDecisionEntry[]
  dispose(): Promise<void>
}

/** 内存中保留的裁决记录条数上限，避免长跑进程无界增长。 */
const RISK_LOG_CAP = 1000

/**
 * 把渠道注册表适配成 harness 的出站端口。
 *
 * 这是插件层与渠道层之间唯一的耦合点——插件层只认 `OutboundPort`。
 */
class ChannelOutbound implements OutboundPort {
  constructor(private readonly channels: ChannelRegistry) {}

  async deliver(
    target: { readonly channelId: string; readonly conversationId: string; readonly customerId: string },
    text: string,
  ): Promise<DeliveryResult> {
    const adapter = this.channels.find(target.channelId)
    if (adapter === undefined) {
      return { ok: false, error: `未注册的渠道 ${target.channelId}`, retryable: false }
    }
    const caps = adapter.capabilities()
    if (text.length > caps.maxTextLength) {
      return { ok: false, error: `回复超长（${text.length} > ${caps.maxTextLength} 字符）`, retryable: false }
    }
    const action: OutboundAction = {
      channelId: target.channelId,
      conversationId: target.conversationId,
      customerId: target.customerId,
      kind: 'reply',
      content: textContent(text),
    }
    return adapter.send(action)
  }
}

export interface BuildRuntimeOptions {
  readonly config: RuntimeConfig
  /**
   * 覆盖业务端口。省略时 orders 用内存实现（P4 换成真实 CRM），
   * knowledge 用 FTS5 store，outbound 始终由渠道注册表提供。
   */
  readonly ports?: Partial<Omit<HarnessPorts, 'outbound'>>
  /**
   * 是否监听知识库目录变更并热重载。
   *
   * 测试里默认关闭：watcher 会让 vitest 因为存活的 handle 而无法退出。
   */
  readonly watchKnowledge?: boolean
  /**
   * 是否启动节奏引擎的周期性 tick。
   *
   * 测试里默认关闭：测试要用 `nurture.tick(now)` 精确控制时间推进，
   * 后台定时器会让断言变得不确定。
   */
  readonly startNurture?: boolean
}

/**
 * 构建运行时对象图。
 *
 * @param options - 配置与可选端口覆盖。
 * @returns 就绪的运行时。
 */
export async function buildRuntime(options: BuildRuntimeOptions): Promise<OpenCsRuntime> {
  const { config } = options
  const channels = new ChannelRegistry()
  const webchat = new WebChatAdapter(config.tenantId)
  channels.register(webchat)

  let wecom: WecomAdapter | undefined
  if (config.wecom !== undefined) {
    wecom = new WecomAdapter({ config: config.wecom, tenantId: config.tenantId })
    channels.register(wecom)
  }

  const knowledgeDb: Db = openDb(join(config.paths.dataDir, 'knowledge.db'), KNOWLEDGE_MIGRATIONS)
  const knowledge = new SqliteKnowledgeStore(knowledgeDb)
  const ingestor = new KnowledgeIngestor({ root: config.paths.knowledgeDir, tenantId: config.tenantId, store: knowledge })
  await ingestor.ingestAll()
  const stopWatching = options.watchKnowledge === true ? await ingestor.watch() : undefined

  const crmDb: Db = openDb(join(config.paths.dataDir, 'crm.db'), CRM_MIGRATIONS)
  const contactStore = new ContactStore(crmDb)
  const contacts = new ContactService(contactStore)
  const importer = new ContactImporter(contactStore)

  const defaults = memoryPorts()
  const ports: HarnessPorts = {
    knowledge: options.ports?.knowledge ?? knowledge,
    orders: options.ports?.orders ?? defaults.orders,
    outbound: new ChannelOutbound(channels),
  }

  const nurtureDb: Db = openDb(join(config.paths.dataDir, 'nurture.db'), [
    ...NURTURE_MIGRATIONS,
    // 发件箱与节奏同库：materialize 与 enqueue 在同一事务里才有意义
    ...OUTREACH_MIGRATIONS.map((migration) => ({ ...migration, id: migration.id + 100 })),
  ])
  const cadences = new CadenceStore(nurtureDb)
  const outbox = new SendOutbox(nurtureDb)

  // 评测与演进同库：门禁要读来源会话的评测结论，跨库读会失去事务一致性
  const evolutionDb: Db = openDb(join(config.paths.dataDir, 'evolution.db'), [
    ...EVAL_MIGRATIONS,
    ...EVOLUTION_MIGRATIONS.map((migration) => ({ ...migration, id: migration.id + 100 })),
  ])
  const evals = new EvalStore(evolutionDb)
  const proposals = new ProposalStore(evolutionDb)
  // 自动放行默认关闭：生产开启前应先积累人工审批数据，确认提案质量
  const gate = new EvolutionGate(proposals, evals)

  const auditDb: Db = openDb(join(config.paths.dataDir, 'audit.db'), [
    ...AUDIT_MIGRATIONS,
    ...APPROVAL_MIGRATIONS.map((migration) => ({ ...migration, id: migration.id + 100 })),
  ])
  const audit = new AuditStore(auditDb)
  const approvals = new ApprovalQueue(auditDb)

  const riskDecisions: RiskDecisionEntry[] = []

  // 闭环编排的 curator 需要 harness.shadowAgent（影子重跑），但 harness 是用 evolution
  // 依赖装配出来的——装配期存在循环依赖。因此这里用一个先声明的 harnessRef 延后解析：
  // curator 的闭包只在 propose 工具执行时（对话期，harness 早已就绪）才会真正调用。
  let harnessRef!: Harness
  const harness = await assembleHarness({
    config,
    ports,
    contacts,
    evolution: {
      proposals,
      gate,
      curator: {
        runShadowTurn: (input, options) => runShadowTurn(harnessRef, input, options),
        evals,
      },
    },
    onRiskDecision: (entry) => {
      riskDecisions.push(entry)
      if (riskDecisions.length > RISK_LOG_CAP) riskDecisions.splice(0, riskDecisions.length - RISK_LOG_CAP)
      try {
        // 持久化审计是旁路：它自身出错不能打断工具执行
        audit.append({
          tool: entry.toolName,
          tier: entry.tier,
          decision: entry.decision,
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          at: entry.at,
        })
      } catch {
        // 已有内存投影兜底；SQLite 故障时不再级联
      }
    },
    onAsk: (request) => {
      // 没有 scope（非 agent 调用）无法定位投递目标，不入队
      if (request.scope === undefined) return undefined
      const preview = previewOf(request.toolName, request.args)
      const { item } = approvals.enqueue({
        tenantId: request.scope.tenantId,
        conversationId: request.scope.conversationId,
        channelId: request.scope.channelId,
        customerId: request.scope.customerId,
        ...(request.scope.contactId === undefined ? {} : { contactId: request.scope.contactId }),
        tool: request.toolName,
        args: request.args ?? {},
        preview,
      })
      // 去重命中时返回已有待批项的 id——模型看到的理由仍指向同一条待办
      return item.id
    },
  })
  // harness 此刻已创建，把引用填给上面的延后闭包（见 harnessRef 声明处的注释）
  harnessRef = harness

  // 组稿走单轮补全而非 agent loop（见 nurture/dsh-llm.ts 注释）。
  // 无 API key 时用离线确定性文案，让节奏在 CI 与冒烟里也能跑通。
  const composerLlm =
    config.llm.kind === 'mock'
      ? new OfflineComposerLlm()
      : new DshComposerLlm({ ctx: harness.ctx, provider: harness.provider, model: harness.model })

  const nurture = new NurtureEngine({
    cadences,
    outbox,
    contacts,
    composer: new OutreachComposer(composerLlm),
    outbound: ports.outbound,
    drainConcurrency: config.nurture.drainConcurrency,
    leaseSeconds: config.nurture.leaseSeconds,
    pollIntervalSeconds: config.nurture.pollIntervalSeconds,
  })
  if (config.nurture.enabled && options.startNurture === true) nurture.start()

  return {
    config,
    channels,
    webchat,
    ...(wecom === undefined ? {} : { wecom }),
    harness,
    knowledge,
    contacts,
    contactStore,
    importer,
    cadences,
    outbox,
    nurture,
    evals,
    proposals,
    gate,
    audit,
    approvals,
    outbound: ports.outbound,
    riskDecisions,
    async dispose(): Promise<void> {
      await nurture.stop()
      await stopWatching?.()
      await ingestor.stop()
      await harness.dispose()
      knowledgeDb.close()
      crmDb.close()
      nurtureDb.close()
      evolutionDb.close()
      auditDb.close()
    },
  }
}

/** 给审核者看的动作摘要。对发消息类工具就是将要发出的正文。 */
function previewOf(toolName: string, args: Readonly<Record<string, unknown>> | undefined): string {
  const text = args?.['text']
  if (typeof text === 'string' && text !== '') return text
  return `${toolName} ${JSON.stringify(args ?? {})}`.slice(0, 500)
}

export { WEBCHAT_CHANNEL_ID }
