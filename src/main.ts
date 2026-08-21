/**
 * 进程入口。
 *
 * 职责边界：只负责「读配置 → 建对象图 → 起服务 → 优雅关停」。
 * 任何业务逻辑都不应出现在这里。
 */

import { createApp } from './gateway/app.js'
import { ConfigError, loadConfig } from './config.js'
import { buildRuntime } from './runtime.js'

async function main(): Promise<void> {
  const config = loadConfig()
  // 生产进程开启知识库热重载：改一个 .md 文件后新答案立即生效，无需重启
  const runtime = await buildRuntime({ config, watchKnowledge: true, startNurture: true })
  const app = await createApp(runtime)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, '收到关停信号，开始优雅关停')
    // 先停止收新请求，再卸载 harness——反过来会让在途 turn 失去工具
    await app.close()
    await runtime.dispose()
    app.log.info('关停完成')
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('[opencs] 关停失败:', error)
          process.exit(1)
        },
      )
    })
  }

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    { provider: runtime.harness.provider, model: runtime.harness.model, env: config.env },
    `OpenCS 已就绪 → http://${config.host}:${config.port}`,
  )
  if (runtime.harness.provider === 'opencs-mock') {
    app.log.warn('未配置 LLM API key，正在使用离线确定性 mock 模型——仅适用于开发与演示')
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`[opencs] 配置错误：${error.message}`)
    process.exit(2)
  }
  console.error('[opencs] 启动失败:', error)
  process.exit(1)
})
