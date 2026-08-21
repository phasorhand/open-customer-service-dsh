import { describe, expect, it } from 'vitest'

import { CARD_PROTOCOL_VERSION } from '../../src/harness/cards.js'
import { FrameProjector, replayFrames, type SessionEventLike } from '../../src/gateway/frames.js'

const CARD_META = {
  protocolVersion: CARD_PROTOCOL_VERSION,
  type: 'knowledge_hit',
  title: '命中 1 条',
  summary: '退款政策',
  scope: '租户 default',
  items: [{ id: 'k1', title: '售后 / 退款政策', evidence: '7 天无理由' }],
  actions: [{ id: 'open', label: '查看原文', kind: 'per_item', requiresConfirm: false }],
}

/** 一次完整 turn 的事件序列：turn → 文本 → 工具调用 → 工具结果 → turn 结束。 */
const TURN: readonly SessionEventLike[] = [
  { type: 'turn/start', seq: 1, data: {} },
  { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: '让我查一下。' } } },
  { type: 'tool/call', seq: 3, data: { callId: 'call-1', name: 'knowledge.search', arguments: '{}' } },
  {
    type: 'tool/result',
    seq: 4,
    data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ toolCallId: 'call-1' }] }, meta: CARD_META },
  },
  { type: 'turn/end', seq: 5, data: {} },
]

describe('FrameProjector · 事件投影', () => {
  it('turn 边界投影为 turn/start 与 turn/done', () => {
    const frames = replayFrames(TURN)
    expect(frames[0]).toEqual({ type: 'turn/start', seq: 1 })
    expect(frames.at(-1)).toEqual({ type: 'turn/done', seq: 5 })
  })

  it('文本增量投影为 text/delta', () => {
    const frames = replayFrames(TURN)
    expect(frames).toContainEqual({ type: 'text/delta', text: '让我查一下。', seq: 2 })
  })

  it('空文本增量不产生帧', () => {
    const projector = new FrameProjector()
    expect(projector.push({ type: 'assistant/chunk', seq: 9, data: { chunk: { type: 'text-delta', text: '' } } })).toEqual([])
  })

  it('非文本增量（如 tool-call-delta）不产生帧', () => {
    const projector = new FrameProjector()
    expect(projector.push({ type: 'assistant/chunk', seq: 9, data: { chunk: { type: 'tool-call-delta' } } })).toEqual([])
  })

  it('未知事件类型被忽略而不是抛错', () => {
    const projector = new FrameProjector()
    expect(projector.push({ type: 'some/future/event', seq: 99, data: { anything: true } })).toEqual([])
  })
})

describe('FrameProjector · 工具名关联', () => {
  it('tool/result 通过 callId 还原出工具名', () => {
    const frames = replayFrames(TURN)
    const done = frames.find((f) => f.type === 'tool/status' && f.status === 'done')
    expect(done).toMatchObject({ tool: 'knowledge.search', label: '知识库检索完成' })
  })

  it('running 与 done 两个状态都下发', () => {
    const statuses = replayFrames(TURN).filter((f) => f.type === 'tool/status')
    expect(statuses.map((f) => (f as { status: string }).status)).toEqual(['running', 'done'])
  })

  it('callId 缺失时降级为通用文案而不是空字符串标签', () => {
    const frames = replayFrames([{ type: 'tool/result', seq: 1, data: { message: { content: [{}] } } }])
    expect(frames[0]).toMatchObject({ type: 'tool/status', status: 'done', label: '工具执行完成' })
  })

  it('多个工具交错时各自对上号', () => {
    const frames = replayFrames([
      { type: 'tool/call', seq: 1, data: { callId: 'a', name: 'knowledge.search' } },
      { type: 'tool/call', seq: 2, data: { callId: 'b', name: 'crm.get_order' } },
      { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'b' }, content: [{ toolCallId: 'b' }] } } },
      // 只有 content.toolCallId 没有 source.callId：验证兜底读取路径
      { type: 'tool/result', seq: 4, data: { message: { content: [{ toolCallId: 'a' }] } } },
    ])
    const done = frames.filter((f) => f.type === 'tool/status' && f.status === 'done')
    expect(done.map((f) => (f as { tool: string }).tool)).toEqual(['crm.get_order', 'knowledge.search'])
  })
})

describe('FrameProjector · 卡片分片', () => {
  it('按 open → item… → close 顺序下发', () => {
    const cardFrames = replayFrames(TURN).filter((f) => f.type.startsWith('card/'))
    expect(cardFrames.map((f) => f.type)).toEqual(['card/open', 'card/item', 'card/close'])
  })

  it('card/open 不带 actions（此前动作应置灰）', () => {
    const open = replayFrames(TURN).find((f) => f.type === 'card/open')
    expect(open).not.toHaveProperty('actions')
  })

  it('card/close 携带 actions 与 traceRef', () => {
    const close = replayFrames(TURN).find((f) => f.type === 'card/close')
    expect(close).toMatchObject({ traceRef: 4, summary: '退款政策' })
    expect((close as unknown as { actions: readonly unknown[] }).actions).toHaveLength(1)
  })

  it('card/open 透传 scope，让人能判断数据范围', () => {
    const open = replayFrames(TURN).find((f) => f.type === 'card/open')
    expect((open as { card: { scope?: string } }).card.scope).toBe('租户 default')
  })

  it('无 meta 的工具结果只产生状态帧，不产生卡片', () => {
    const frames = replayFrames([
      { type: 'tool/call', seq: 1, data: { callId: 'a', name: 'knowledge.search' } },
      { type: 'tool/result', seq: 2, data: { message: { source: { callId: 'a' }, content: [{ toolCallId: 'a' }] } } },
    ])
    expect(frames.filter((f) => f.type.startsWith('card/'))).toHaveLength(0)
  })

  it('旧版本卡片降级后仍下发 open/close，但没有条目', () => {
    const frames = replayFrames([
      { type: 'tool/call', seq: 1, data: { callId: 'a', name: 'knowledge.search' } },
      {
        type: 'tool/result',
        seq: 2,
        data: { message: { source: { callId: 'a' }, content: [{ toolCallId: 'a' }] }, meta: { ...CARD_META, protocolVersion: 0 } },
      },
    ])
    expect(frames.map((f) => f.type)).toEqual(['tool/status', 'tool/status', 'card/open', 'card/close'])
  })
})

describe('replayFrames · 确定性', () => {
  it('同一段事件两次投影结果完全相同', () => {
    expect(replayFrames(TURN)).toEqual(replayFrames(TURN))
  })

  it('逐事件实时投影与整段回放投影结果一致', () => {
    const live = new FrameProjector()
    const streamed = TURN.flatMap((event) => live.push(event))
    expect(streamed).toEqual(replayFrames(TURN))
  })
})
