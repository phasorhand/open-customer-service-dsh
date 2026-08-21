/**
 * `opencs-mock` LLM 适配器：无 API key 时的确定性意图路由。
 *
 * 为什么需要（spec §8）：CI 与本地开发不应依赖真实模型。这个 adapter 走**完整的**
 * agent loop——文本流 → tool-call → 工具真实执行（guard / presentationMeta 全生效）
 * → tool-result → 收尾文本。因此离线冒烟验证的是真实链路，不是被 mock 掉的假链路。
 *
 * 参照 dsh `examples/headless-agent` 的 CliMockAdapter 与
 * `ai_mingtai_copilot/impl/src/harness/mock-llm.ts` 的已验证实现。
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

export const MOCK_PROVIDER = 'opencs-mock'
export const MOCK_MODEL = 'opencs-router-v1'

const OFF = ReasoningEffortId('off')

interface RoutedCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly preamble: string
}

/**
 * 意图 → 工具的确定性路由表。
 *
 * 顺序敏感：先匹配到的先用。把更具体的意图（订单号、退款）排在泛化意图（咨询）前面。
 */
const ROUTES: readonly { readonly test: RegExp; readonly build: (text: string) => RoutedCall }[] = [
  {
    test: /(ord-|订单号|我的订单)/i,
    build: (text) => ({
      tool: 'crm.get_order',
      args: { order_id: /ord-[a-z0-9]+/i.exec(text)?.[0] ?? 'ord-unknown' },
      preamble: '好的，我先查一下这笔订单的状态。',
    }),
  },
  {
    test: /(退款|退货|退钱|不想要了)/,
    build: () => ({
      tool: 'knowledge.search',
      args: { query: '退款政策' },
      preamble: '我帮你确认一下退款政策。',
    }),
  },
  {
    test: /(发票|开票)/,
    build: () => ({ tool: 'knowledge.search', args: { query: '发票开具' }, preamble: '我查一下开票的规则。' }),
  },
  {
    test: /(物流|快递|发货|什么时候到)/,
    build: () => ({ tool: 'knowledge.search', args: { query: '物流时效' }, preamble: '我看一下配送时效说明。' }),
  },
  {
    test: /(怎么|如何|可以吗|能不能|多久|多少钱|政策|规则)/,
    build: (text) => ({ tool: 'knowledge.search', args: { query: text.slice(0, 40) }, preamble: '让我查一下相关说明。' }),
  },
]

const GREETING = '你好，我是 OpenCS 客服助手。你可以直接描述遇到的问题，比如退款、发票、物流或订单状态，我来帮你处理。'

function route(text: string): RoutedCall | undefined {
  for (const entry of ROUTES) {
    if (entry.test.test(text)) return entry.build(text)
  }
  return undefined
}

function lastUserText(options: GenerateOptions): string {
  for (let i = options.messages.length - 1; i >= 0; i--) {
    const message = options.messages[i]
    if (message === undefined || message.role !== 'user') continue
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (text.trim() !== '') return text
  }
  return ''
}

function* streamText(text: string, index = 0): Generator<StreamChunk> {
  yield { type: 'block-start', index, blockType: 'text' }
  // 按标点切片，驱动前端 text/delta 渐进渲染
  const pieces = text.match(/[^，。；！？\n]{1,14}[，。；！？\n]?/g) ?? [text]
  for (const piece of pieces) {
    yield { type: 'text-delta', index, text: piece }
  }
  yield { type: 'block-end', index, block: { type: 'text', text } }
}

class OpenCsMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: 'OpenCS 离线路由（确定性 mock）',
      reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1)
    const toolResult = last?.content.find((block) => block.type === 'tool-result')

    if (toolResult !== undefined) {
      const text = textOfResult(toolResult)

      // 已经发过 channel.reply（不论成败）→ 本轮结束，只补一段收尾文本。
      // 判据用工具结果内容而非调用历史：mock 不持有跨轮状态。
      const outcome = replyOutcomeOf(text)
      if (outcome !== undefined) {
        yield* streamText(outcome)
        yield { type: 'usage', usage: { inputTokens: 64, outputTokens: 24 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      // 查到信息 → 走 channel.reply 把答复发出去（真实模型的行为，也让出站链路被测到）
      yield* yieldToolCall('channel.reply', { text: summarize(text) })
      return
    }

    const routed = route(lastUserText(options))
    if (routed === undefined) {
      // 无法识别意图：直接把问候作为答复发出去
      yield* yieldToolCall('channel.reply', { text: GREETING })
      return
    }

    // 第一步：简短前言 + 查证工具
    yield* streamText(routed.preamble)
    yield* yieldToolCall(routed.tool, routed.args)
  }
}

/** 产出一次工具调用的完整 chunk 序列。 */
function* yieldToolCall(tool: string, args: Record<string, unknown>): Generator<StreamChunk> {
  const callId = CallId(`mock-${counter()}`)
  const encoded = JSON.stringify(args)
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 1, id: callId, name: tool, argumentsDelta: encoded }
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: tool, arguments: encoded } }
  yield { type: 'usage', usage: { inputTokens: 48, outputTokens: 24 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}


/** 单调计数器：mock 的 callId 需要唯一但**必须确定性**，不能用时间戳（否则回放不可比对）。 */
let seq = 0
function counter(): number {
  seq += 1
  return seq
}

/** 测试用：重置 callId 计数，让同一段脚本两次运行产生相同的 id。 */
export function resetMockCallIds(): void {
  seq = 0
}

function textOfResult(toolResult: { readonly content: readonly { readonly type: string }[] }): string {
  return toolResult.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 识别 `channel.reply` 的执行结果并给出对应的收尾文本。
 *
 * 返回 `undefined` 表示这不是一次回复的结果（而是查证工具的结果），调用方应继续发回复。
 */
function replyOutcomeOf(text: string): string | undefined {
  if (/回复已送达/.test(text)) return '好的，已经答复客户了。'
  if (/需人工确认/.test(text)) return '答复草稿已生成，按当前策略需要人工确认后才能发送给客户。'
  if (/回复未能送达/.test(text)) return '答复没能送达客户，我不重复发送，请人工跟进。'
  if (/未经服务端注入|作用域|越权/.test(text)) return '抱歉，当前会话缺少必要的权限上下文，我无法处理这个请求。'
  if (/频控/.test(text)) return '触达频率已达上限，本次不再发送，稍后再试。'
  return undefined
}

function summarize(text: string): string {
  // 零命中：render() 给模型的是**指令**（「不要编造政策，请如实告知」），
  // 直接回显会把内部指令发给客户。真实模型会理解并改写；mock 必须显式处理。
  if (/没有找到|知识库中没有/.test(text)) {
    return '这个问题我暂时没有查到明确的说明，不方便凭印象回答。我帮你转人工同事跟进，可以吗？'
  }
  if (/拒绝|deny|作用域|越权|频控/.test(text)) {
    const firstLine = text.split('\n')[0] ?? ''
    return `抱歉，这个操作超出了当前会话的权限范围：${firstLine}。我已记录，请联系管理员处理。`
  }
  // 真实模型会引用查到的条款正文作答；mock 用「取最长的一条正文」逼近这一行为，
  // 从而让离线冒烟能验证「回复内容确实来自工具结果」而不只是空壳。
  const body = text
    .split('\n')
    .map((line) => line.replace(/^\d+\.\s*/, '').trim())
    // 排除给模型的指令性内容——它们绝不能出现在给客户的话里
    .filter((line) => line !== '' && !/^(找到|订单|知识库中没有)/.test(line))
    .filter((line) => !/不要编造|请如实告知|不要臆测|不要重复发送|不要向客户承诺/.test(line))
    .sort((a, b) => b.length - a.length)[0]

  if (body === undefined || body === '') {
    const firstLine = text.split('\n')[0] ?? ''
    return firstLine === ''
      ? '我查了一下，暂时没有找到相关信息。可以再描述得具体一些吗？'
      : `${firstLine}。如果还有疑问可以继续问我。`
  }
  return `${body} 以上信息来自知识库，如果还有疑问可以继续问我。`
}

export const name = 'opencs-mock-llm'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([MOCK_PROVIDER], new OpenCsMockAdapter())
}
