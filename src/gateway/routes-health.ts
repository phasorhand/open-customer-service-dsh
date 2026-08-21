/**
 * 健康检查。
 *
 * 分离 liveness / readiness（沿用 Python 版的划分）：
 * - `/health/live` 永远 200，且**绝不触碰** DB / LLM——它只回答「进程还活着吗」
 * - `/health/ready` 检查依赖，未就绪返回 503，供 k8s / compose 决定是否切流量
 */

import type { FastifyInstance } from 'fastify'

import type { OpenCsRuntime } from '../runtime.js'

interface ComponentStatus {
  readonly ok: boolean
  readonly detail?: string
}

export function registerHealthRoutes(app: FastifyInstance, runtime: OpenCsRuntime): void {
  app.get('/health/live', async () => ({ status: 'ok' }))

  app.get('/health/ready', async (_request, reply) => {
    const components: Record<string, ComponentStatus> = {
      channels: checkChannels(runtime),
      llm: { ok: true, detail: `${runtime.harness.provider}/${runtime.harness.model}` },
      harness: { ok: true },
    }
    const ready = Object.values(components).every((component) => component.ok)
    // mock 模型能跑但不是生产就绪状态，显式标注让运维看得见
    const degraded = runtime.harness.provider === 'opencs-mock'

    void reply.status(ready ? 200 : 503)
    return { ready, degraded, components }
  })

  // Python 版的旧路径别名，便于既有探针与文档平滑迁移
  app.get('/health', async () => ({
    status: 'ok',
    channels: runtime.channels.list(),
    deprecated: '请改用 /health/live 与 /health/ready',
  }))
}

function checkChannels(runtime: OpenCsRuntime): ComponentStatus {
  const registered = runtime.channels.list()
  return registered.length > 0
    ? { ok: true, detail: registered.join(', ') }
    : { ok: false, detail: '没有注册任何渠道适配器' }
}
