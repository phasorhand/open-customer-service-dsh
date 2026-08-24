/**
 * 从会话事件里抽出助手消息的纯文本块（跨模块共用）。
 *
 * `assistant/message` 事件里 `message.content` 是一个块数组，可能是 text（模型叙述）、
 * tool-call、tool-result 等。本 helper 只取 text 块——影子运行器的帧投影、
 * 网关的 assistant_narration 拼接、harness 集成测试的断言都依赖这一抽取，保持 DRY。
 *
 * 保持原各调用方的行为不变：不 trim、不排空串，只按类型过滤。
 */
export function toTextBlocks(events: readonly unknown[]): readonly { readonly type: 'text'; readonly text: string }[] {
  const out: { type: 'text'; text: string }[] = []
  for (const raw of events) {
    const event = raw as { type?: string; data?: unknown }
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly { type?: string; text?: string }[] } }
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: block.text })
    }
  }
  return out
}
