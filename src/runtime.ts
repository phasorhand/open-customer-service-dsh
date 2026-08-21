/**
 * 组合根：把配置、渠道、端口、dsh harness 装配成一个可运行的对象图。
 *
 * 纪律：这是**唯一**一处知道全部具体实现的地方。其他模块只依赖接口，
 * 便于测试替换与后续分层演进。
 */

import { join } from 'node:path'

import { ChannelRegistry } from './channel/adapter.js'
import type { OutboundAction } from './channel/types.js'
import { textContent } from './channel/types.js'
import { WebChatAdapter, WEBCHAT_CHANNEL_ID } from './channel/webchat.js'
import type { RuntimeConfig } from './config.js'
import { openDb, type Db } from './db/sqlite.js'
import { assembleHarness, type Harness } from './harness/assemble.js'
import type { RiskDecisionEntry } from './harness/plugins/guard-risk.js'
import { memoryPorts } from './harness/ports-memory.js'
import type { DeliveryResult, HarnessPorts, OutboundPort } from './harness/ports.js'
import { KnowledgeIngestor } from './knowledge/ingestor.js'
import { KNOWLEDGE_MIGRATIONS, SqliteKnowledgeStore } from './knowledge/store.js'

export interface OpenCsRuntime {
  readonly config: RuntimeConfig
  readonly channels: ChannelRegistry
  readonly webchat: WebChatAdapter
  readonly harness: Harness
  readonly knowledge: SqliteKnowledgeStore
  /** 最近的风险裁决记录（P7 会换成 audit 表持久化）。 */
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

  const knowledgeDb: Db = openDb(join(config.paths.dataDir, 'knowledge.db'), KNOWLEDGE_MIGRATIONS)
  const knowledge = new SqliteKnowledgeStore(knowledgeDb)
  const ingestor = new KnowledgeIngestor({ root: config.paths.knowledgeDir, tenantId: config.tenantId, store: knowledge })
  await ingestor.ingestAll()
  const stopWatching = options.watchKnowledge === true ? await ingestor.watch() : undefined

  const defaults = memoryPorts()
  const ports: HarnessPorts = {
    knowledge: options.ports?.knowledge ?? knowledge,
    orders: options.ports?.orders ?? defaults.orders,
    outbound: new ChannelOutbound(channels),
  }

  const riskDecisions: RiskDecisionEntry[] = []
  const harness = await assembleHarness({
    config,
    ports,
    onRiskDecision: (entry) => {
      riskDecisions.push(entry)
      if (riskDecisions.length > RISK_LOG_CAP) riskDecisions.splice(0, riskDecisions.length - RISK_LOG_CAP)
    },
  })

  return {
    config,
    channels,
    webchat,
    harness,
    knowledge,
    riskDecisions,
    async dispose(): Promise<void> {
      await stopWatching?.()
      await ingestor.stop()
      await harness.dispose()
      knowledgeDb.close()
    },
  }
}

export { WEBCHAT_CHANNEL_ID }
