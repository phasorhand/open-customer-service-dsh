/** 开发用：连上 WS，发一条消息，打印收到的帧序列，再重连验证历史重放。 */
const url = process.argv[2] ?? 'ws://localhost:8099/ws/conversations/ws-1?customer_id=u-ws'

async function session(label: string, text?: string): Promise<string[]> {
  const ws = new WebSocket(url)
  const seen: string[] = []
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () => resolve())
  })
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { type: string; frames?: unknown[] }
    seen.push(frame.type === 'history' ? `history(${frame.frames?.length ?? 0})` : frame.type)
  })
  if (text !== undefined) ws.send(JSON.stringify({ type: 'user', text }))
  await new Promise((resolve) => setTimeout(resolve, 3000))
  ws.close()
  console.log(`[${label}]`, seen.join(' '))
  return seen
}

await session('首次连接 + 发消息', '想退款还来得及吗')
await session('重连（应看到历史重放）')
